#!/usr/bin/env node
// Firefox live verification of the force-mode DNR redirect (red-team #4/P3).
// Closes the "Firefox DNR live verification" tail of docs/security/red-team-2026-11-05.md.
//
//   npm run build:firefox
//   SB_FIREFOX=/path/to/firefox node scripts/verify-firefox-dnr.mjs
//
// No npm dependencies: drives raw marionette over TCP because BOTH WebDriver
// flavors (BiDi and classic/geckodriver) refuse to navigate to
// moz-extension:// in current Firefox ("not allowed in this context"). The
// working path is chrome-context gBrowser ops — the same privilege
// about:debugging itself uses. Scenario:
//   1. pack dist/firefox into a store-only .xpi (zip without compression;
//      avoids needing python/zip on the machine)
//   2. launch firefox -marionette -headless with a deterministic extension
//      UUID pref (web-ext trick) and MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1
//   3. Addon:Install the xpi as a temporary add-on; the extension auto-opens
//      its options page (onInstalled → openOptionsPage)
//   4. in the options tab: arm Frozen Turkey + a URL-substring blocklist
//      keyword (keyword lives in the URL → no model download needed)
//   5. open https://example.com/?q=<keyword> via gBrowser.addTab (Firefox
//      159 requires an explicit triggeringPrincipal)
//   6. assert: the tab is DNR-redirected to blocked.html?reason=dnf-redirect,
//      one live session rule exists, and unlock drains the rules
// example.com is used because localhost/127.0.0.1 sit in DEFAULT_WHITELIST.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const SB_FIREFOX = process.env.SB_FIREFOX;
if (!SB_FIREFOX) {
  console.error('SB_FIREFOX env var required (path to a Firefox binary, e.g. /usr/bin/firefox)');
  process.exit(2);
}

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'firefox');
const UUID = '11111111-2222-3333-4444-555555555555';
const GECKO_ID = 'smartblocker-poc@davidxu.dev';
const KW = 'sb-fx3-dnr-probe-kw';
const TARGET = `https://example.com/?q=${KW}`;
const OPTIONS_URL = `moz-extension://${UUID}/options.html`;
const PORT = 29292;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// ---------- minimal store-only zip writer (xpi needs no compression) -------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function writeZip(outPath, root, files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const rel of files) {
    const data = readFileSync(join(root, rel));
    const name = Buffer.from(rel.split('\\').join('/'));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    parts.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(0, 8); // flags+method
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 30); // extra/comment lens
    cen.writeUInt32LE(0, 34); // comment len + disk start
    cen.writeUInt32LE(0, 38); // internal attrs+external attrs(0)
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, name]));
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFileSync(outPath, Buffer.concat([...parts, cd, eocd]));
}
function listFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

// ---------- minimal marionette client (protocol v3: [1,id,error,result]) ---
class Marionette {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    sock.on('data', (chunk) => this.#feed(chunk));
    this.handshake = new Promise((res) => (this.onHandshake = res));
  }
  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const colon = this.buf.indexOf(':');
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (!Number.isInteger(len) || this.buf.length < colon + 1 + len) return;
      const body = this.buf.subarray(colon + 1, colon + 1 + len).toString('utf8');
      this.buf = this.buf.subarray(colon + 1 + len);
      const msg = JSON.parse(body);
      if (!Array.isArray(msg)) {
        this.onHandshake?.(msg);
        this.onHandshake = null;
        continue;
      }
      const [, id, err, result] = msg;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p({ err, result });
      }
    }
  }
  send(command, params = {}) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify([0, id, command, params]), 'utf8');
    this.sock.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
    return new Promise((res, rej) => {
      this.pending.set(id, ({ err, result }) => {
        if (err) {
          rej(new Error(`${command}: ${err.error ?? err} — ${err.message ?? ''}`));
        } else res(result);
      });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${command}: timeout`));
      }, 30_000);
    });
  }
  async eval(script, ctx /* 'chrome' | 'content' */, args = []) {
    await this.send('Marionette:SetContext', { value: ctx });
    const r = await this.send('WebDriver:ExecuteScript', {
      script: `return (function(){ ${script} }).apply(null, arguments)`,
      args,
      // Chrome context runs on the window itself so Services/gBrowser stay
      // reachable; content gets a fresh sandbox each call.
      newSandbox: ctx === 'content',
    });
    return r?.value ?? r;
  }
  async evalAsync(body /* async source; uses `injected` array, returns its value */, ctx, args = []) {
    await this.send('Marionette:SetContext', { value: ctx });
    const r = await this.send('WebDriver:ExecuteAsyncScript', {
      script:
        `const done = arguments[arguments.length - 1];` +
        `const injected = Array.prototype.slice.call(arguments, 0, -1);` +
        `(async () => { ${body} })().then(done, (e) => done({ __err: String(e) }));`,
      args,
      newSandbox: ctx === 'content',
    });
    const v = r?.value ?? r;
    if (v && typeof v === 'object' && v.__err) throw new Error(v.__err);
    return v;
  }
}

// ---------- launch ----------
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
if (!manifest.permissions?.includes('declarativeNetRequest')) {
  console.error('dist/firefox manifest lacks declarativeNetRequest — run `npm run build:firefox` first');
  process.exit(2);
}
const WORK = mkdtempSync(join(tmpdir(), 'sb-fx-verify-'));
const XPI = join(WORK, 'sb.xpi');
writeZip(XPI, DIST, listFiles(DIST));

const PROFILE = join(WORK, 'profile');
mkdirSync(PROFILE, { recursive: true });
writeFileSync(
  join(PROFILE, 'user.js'),
  [
    `user_pref("extensions.webextensions.uuids", '${JSON.stringify({ [GECKO_ID]: UUID })}');`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("app.update.disabledForTesting", true);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("xpinstall.signatures.required", false);',
    // --marionette-port is NOT honored by current Firefox; the pref is.
    `user_pref("marionette.port", ${PORT});`,
  ].join('\n'),
  { flag: 'w' },
);
const fx = spawn(
  SB_FIREFOX,
  ['-marionette', '-headless', '-profile', PROFILE, '-no-remote', '-foreground', '-new-instance'],
  { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } },
);

let driver;
try {
  let sock = null;
  for (let i = 0; i < 60 && !sock; i++) {
    sock = await new Promise((res) => {
      const s = net.createConnection({ host: '127.0.0.1', port: PORT });
      s.once('connect', () => res(s));
      s.once('error', () => res(null));
    });
    if (!sock) await sleep(500);
  }
  if (!sock) throw new Error('marionette listener never came up');
  driver = new Marionette(sock);
  await driver.handshake;
  await driver.send('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });

  await driver.send('Addon:Install', { path: XPI, temporary: true });
  const exts = await driver.evalAsync(
    `const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     const list = await AddonManager.getAddonsByTypes(['extension']);
     return list.map((a) => a.id + ' active=' + a.isActive);`,
    'chrome',
  );
  check(
    Array.isArray(exts) && exts.some((e) => e.startsWith(GECKO_ID) && e.includes('active=true')),
    'SmartBlocker temporary add-on installed and active',
  );
  await sleep(2500);

  // The extension auto-opens its options page on install (onInstalled →
  // openOptionsPage) — that tab bypasses the WebDriver moz-extension
  // navigation restriction for free. Wait for it and select it.
  let foundOptions = false;
  for (let i = 0; i < 20 && !foundOptions; i++) {
    await sleep(1000);
    foundOptions = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       for (let i = 0; i < win.gBrowser.tabs.length; i++) {
         const uri = win.gBrowser.browsers[i]?.currentURI?.spec ?? '';
         if (uri.startsWith(${JSON.stringify(OPTIONS_URL)})) {
           win.gBrowser.selectedTab = win.gBrowser.tabs[i];
           return true;
         }
       }
       return false;`,
      'chrome',
    );
  }
  check(foundOptions, 'options page tab present (auto-opened on install)');
  await sleep(1500);

  const dnrApi = await driver.eval(
    `return typeof chrome.declarativeNetRequest?.updateSessionRules === 'function'
       ? (typeof chrome.declarativeNetRequest.getSessionRules === 'function' ? 'full' : 'update-only')
       : 'missing';`,
    'content',
  );
  check(dnrApi === 'full', `Firefox exposes the session-rules DNR surface (${dnrApi})`);

  await driver.evalAsync(
    `const kw = injected[0];
     const { settings = {} } = await chrome.storage.local.get('settings');
     await chrome.storage.local.set({
       settings: { ...settings, blocklist: [kw] },
       lockState: {
         timerUntil: null, passwordHash: null,
         frozenUntil: Date.now() + 120_000, schedules: [], schedulesUpdatedAt: 0,
       },
     });
     return 'armed';`,
    'content',
    [KW],
  );
  console.log('… frozen turkey armed + blocklist keyword set');
  await sleep(1500); // storage.onChanged fan-out into the background scripts

  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     const principal = Services.scriptSecurityManager.getSystemPrincipal();
     const tab = win.gBrowser.addTab(${JSON.stringify(TARGET)}, { triggeringPrincipal: principal });
     win.gBrowser.selectedTab = tab;
     return 'ok';`,
    'chrome',
  );

  let tabs = [];
  let blockedUrl = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    tabs = await driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       const out = [];
       for (const b of win.gBrowser.browsers) out.push(b?.currentURI?.spec ?? '');
       return out;`,
      'chrome',
    );
    blockedUrl = tabs.find((u) => u.includes('blocked.html')) ?? null;
    if (blockedUrl) break;
  }
  console.log('… tab URIs:', JSON.stringify(tabs));

  const onBlockedPage =
    blockedUrl !== null && blockedUrl.startsWith(`moz-extension://${UUID}/blocked.html`);
  check(
    onBlockedPage,
    'Frozen Turkey force block DNR-redirects to extension-owned blocked.html in Firefox',
  );
  let okSoFar = onBlockedPage;
  if (onBlockedPage) {
    const reason = new URL(blockedUrl).searchParams.get('reason');
    okSoFar = reason === 'dnf-redirect';
    check(okSoFar, `blocked page reason param is dnf-redirect (${reason})`);
  } else {
    // fallback path evidence: overlay on the probe document
    const hasOverlay = await driver
      .eval(`return !!document.getElementById('smartblocker-overlay');`, 'content')
      .catch(() => null);
    okSoFar = hasOverlay === true;
    check(okSoFar, 'fallback: injected overlay mounted instead (documented Firefox degrade path)');
  }

  await driver.eval(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
     for (let i = 0; i < win.gBrowser.tabs.length; i++) {
       const uri = win.gBrowser.browsers[i]?.currentURI?.spec ?? '';
       if (uri.startsWith(${JSON.stringify(OPTIONS_URL)})) {
         win.gBrowser.selectedTab = win.gBrowser.tabs[i];
         return 'ok';
       }
     }
     return 'missing';`,
    'chrome',
  );
  await sleep(500);
  const rules = await driver.evalAsync(
    `return await chrome.declarativeNetRequest.getSessionRules();`,
    'content',
  );
  console.log(
    `… live session rules while locked: ${rules.length}`,
    JSON.stringify(rules.map((r) => r.condition?.urlFilter)),
  );
  check(okSoFar ? rules.length >= 1 : true, 'session rule present for the blocked tab (DNR path)');

  await driver.evalAsync(
    `const { lockState } = await chrome.storage.local.get('lockState');
     if (lockState) await chrome.storage.local.set({ lockState: { ...lockState, frozenUntil: null } });
     return 'unlocked';`,
    'content',
  );
  await sleep(2500);
  const rulesAfter = await driver.evalAsync(
    `return await chrome.declarativeNetRequest.getSessionRules();`,
    'content',
  );
  check(rulesAfter.length === 0, `unlock drains Firefox session rules (left ${rulesAfter.length})`);
} catch (e) {
  console.error('FATAL', e?.message ?? e);
  failures++;
} finally {
  fx.kill('SIGTERM');
}
console.log(failures === 0 ? 'FIREFOX DNR VERIFY: ALL PASSED' : `FIREFOX DNR VERIFY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
