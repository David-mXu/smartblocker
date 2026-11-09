// Shared privileged Firefox test transport. Raw Marionette is required because
// current WebDriver/BiDi navigation rejects moz-extension:// URLs. The caller
// still drives the real packed extension: chrome context only opens/selects
// tabs, while extension APIs and DOM assertions run in its content context.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const FIREFOX_UUID = '11111111-2222-3333-4444-555555555555';
export const GECKO_ID = 'smartblocker-poc@davidxu.dev';
export const EXTENSION_ORIGIN = `moz-extension://${FIREFOX_UUID}`;
export const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'firefox');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- minimal store-only zip writer (an XPI needs no compression) ------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(root, prefix))) {
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(root, relative)).isDirectory()) files.push(...listFiles(root, relative));
    else files.push(relative);
  }
  return files;
}

export function writeXpi(outPath, root) {
  const parts = [];
  const central = [];
  const files = listFiles(root);
  let offset = 0;
  for (const relative of files) {
    const data = readFileSync(join(root, relative));
    const name = Buffer.from(relative.split('\\').join('/'));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 30);
    entry.writeUInt32LE(0, 34);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outPath, Buffer.concat([...parts, directory, end]));
}

// ---------- minimal Marionette client (protocol v3: [1,id,error,result]) -----
export class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    socket.on('data', (chunk) => this.#feed(chunk));
    this.handshake = new Promise((resolve) => (this.onHandshake = resolve));
  }

  #feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(':');
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isInteger(length) || this.buffer.length < colon + 1 + length) return;
      const body = this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8');
      this.buffer = this.buffer.subarray(colon + 1 + length);
      const message = JSON.parse(body);
      if (!Array.isArray(message)) {
        this.onHandshake?.(message);
        this.onHandshake = null;
        continue;
      }
      const [, id, error, result] = message;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve({ error, result });
      }
    }
  }

  send(command, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify([0, id, command, params]), 'utf8');
    this.socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${command}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: ({ error, result }) => {
          if (error) reject(new Error(`${command}: ${error.error ?? error} — ${error.message ?? ''}`));
          else resolve(result);
        },
      });
    });
  }

  async eval(script, context = 'content', args = [], timeoutMs = 30_000) {
    await this.send('Marionette:SetContext', { value: context }, timeoutMs);
    const result = await this.send(
      'WebDriver:ExecuteScript',
      {
        script: `return (function(){ ${script} }).apply(null, arguments)`,
        args,
        // Chrome context runs on the browser window so Services/gBrowser stay
        // reachable; content gets a fresh sandbox for every call.
        newSandbox: context === 'content',
      },
      timeoutMs,
    );
    return result?.value ?? result;
  }

  async evalAsync(body, context = 'content', args = [], timeoutMs = 30_000) {
    await this.send('Marionette:SetContext', { value: context }, timeoutMs);
    const result = await this.send(
      'WebDriver:ExecuteAsyncScript',
      {
        script:
          'const done = arguments[arguments.length - 1];' +
          'const injected = Array.prototype.slice.call(arguments, 0, -1);' +
          `(async () => { ${body} })().then(done, (e) => done({ __err: String(e) }));`,
        args,
        newSandbox: context === 'content',
      },
      timeoutMs,
    );
    const value = result?.value ?? result;
    if (value && typeof value === 'object' && value.__err) throw new Error(value.__err);
    return value;
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export class FirefoxTestSession {
  constructor(process, driver, work, originalHandle) {
    this.process = process;
    this.driver = driver;
    this.work = work;
    this.originalHandle = originalHandle;
  }

  static async launch({
    firefoxPath,
    dist = DEFAULT_DIST,
    scriptTimeoutMs = 30_000,
    temporary = true,
    install = true,
    reuseWork = null,
    extraPrefs = [],
    isolateNativeMessaging = false,
  } = {}) {
    if (!firefoxPath) throw new Error('SB_FIREFOX env var required (path to a Firefox binary)');
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
    if (!manifest.permissions?.includes('declarativeNetRequest')) {
      throw new Error('dist/firefox manifest lacks declarativeNetRequest — run `npm run build:firefox` first');
    }

    // Lifecycle suites can install once, stop Firefox, then reuse the exact
    // work/profile directory with install:false. That proves a persistent XPI
    // survived a real process restart rather than passing via reinstallation.
    const work = reuseWork ?? mkdtempSync(join(tmpdir(), 'sb-firefox-e2e-'));
    mkdirSync(work, { recursive: true });
    const xpi = join(work, 'smartblocker.xpi');
    if (install) writeXpi(xpi, dist);
    const profile = join(work, 'profile');
    mkdirSync(profile, { recursive: true });
    // A random free port avoids collisions with another local Firefox suite.
    // --marionette-port is ignored by current Firefox; the user.js pref works.
    const port = await availablePort();
    writeFileSync(
      join(profile, 'user.js'),
      [
        `user_pref("extensions.webextensions.uuids", '${JSON.stringify({ [GECKO_ID]: FIREFOX_UUID })}');`,
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("app.update.disabledForTesting", true);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("xpinstall.signatures.required", false);',
        `user_pref("marionette.port", ${port});`,
        ...extraPrefs,
      ].join('\n'),
    );

    const env = { ...globalThis.process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
    if (isolateNativeMessaging) {
      // Firefox resolves XREUserNativeManifests to $HOME/.mozilla. Give only
      // this disposable browser a new home so an installed companion cannot
      // keep its event page alive; never modify the user's manifests/daemon.
      env.HOME = join(work, 'isolated-home');
      mkdirSync(env.HOME, { recursive: true });
    }
    const process = spawn(
      firefoxPath,
      ['-marionette', '-headless', '-profile', profile, '-no-remote', '-foreground', '-new-instance'],
      { stdio: ['ignore', 'ignore', 'pipe'], env },
    );
    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });

    let socket = null;
    try {
      for (let attempt = 0; attempt < 120 && !socket; attempt++) {
        socket = await new Promise((resolve) => {
          const candidate = net.createConnection({ host: '127.0.0.1', port });
          candidate.once('connect', () => resolve(candidate));
          candidate.once('error', () => resolve(null));
        });
        if (!socket) await sleep(500);
      }
      if (!socket) throw new Error(`Marionette listener never came up on port ${port}\n${stderr}`);
      const driver = new Marionette(socket);
      await driver.handshake;
      await driver.send('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } });
      await driver.send('WebDriver:SetTimeouts', { script: scriptTimeoutMs, pageLoad: scriptTimeoutMs });
      // Firefox 121 can open the install-time options tab before Addon:Install
      // returns. Preserve Marionette's actual original handle instead of
      // accidentally binding subsequent content evals to that new options tab.
      const originalHandleResult = await driver.send('WebDriver:GetWindowHandle');
      const originalHandle = originalHandleResult?.value ?? originalHandleResult;
      if (install) await driver.send('Addon:Install', { path: xpi, temporary });
      await driver.send('WebDriver:SwitchToWindow', { handle: originalHandle });
      const session = new FirefoxTestSession(process, driver, work, originalHandle);
      // Keep a stable reference to Marionette's original content handle. The
      // install-time options tab is real but must not replace this original tab.
      await driver.eval(
        `const win = Services.wm.getMostRecentWindow('navigator:browser');
         const browser = win.gBrowser.browsers.find((b) => b?.currentURI?.spec === 'about:blank')
           ?? win.gBrowser.selectedTab.linkedBrowser;
         win.__smartBlockerTestTab = win.gBrowser.getTabForBrowser(browser);
         return browser.currentURI.spec;`,
        'chrome',
      );
      return session;
    } catch (error) {
      socket?.destroy();
      process.kill('SIGTERM');
      throw error;
    }
  }

  // Perform a real WebDriver pointer click on an element returned by the
  // caller's content script. Unlike element.click(), this produces trusted
  // input and also works for native about:addons controls and block-screen
  // actions that explicitly reject synthetic events.
  async nativeClick(script, args = []) {
    const reference = await this.driver.eval(
      `const element = (function(){ ${script} }).apply(null, arguments);
       if (!element) throw new Error('native click target not found');
       element.scrollIntoView({ block: 'center', inline: 'nearest' });
       return element;`,
      'content',
      args,
    );
    const id = reference?.['element-6066-11e4-a52e-4f735466cecf'];
    if (!id) throw new Error('native click target did not serialize as a WebElement');
    await this.driver.send('WebDriver:ElementClick', { id });
  }

  async load(url, { timeoutMs = 30_000 } = {}) {
    await this.driver.eval(
      `const win = Services.wm.getMostRecentWindow('navigator:browser');
       const tab = win.__smartBlockerTestTab;
       if (!tab || !tab.linkedBrowser) throw new Error('original Marionette tab is gone');
       const principal = Services.scriptSecurityManager.getSystemPrincipal();
       win.gBrowser.selectedTab = tab;
       tab.linkedBrowser.loadURI(Services.io.newURI(${JSON.stringify(url)}), { triggeringPrincipal: principal });
       return 'loading';`,
      'chrome',
    );
    // Selecting a tab in the parent process does not move Marionette's
    // content context (notably after a trusted click in another tab). Rebind
    // explicitly or waitFor would inspect the previous target's document.
    await this.driver.send('WebDriver:SwitchToWindow', { handle: this.originalHandle });
    await this.waitFor(`return location.href === ${JSON.stringify(url)} || location.href.startsWith(${JSON.stringify(`${url}#`)});`, {
      timeoutMs,
      description: `navigation to ${url}`,
    });
  }

  async waitFor(script, { args = [], timeoutMs = 30_000, intervalMs = 250, description = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.driver.eval(script, 'content', args)) return;
      } catch (error) {
        // A navigation can invalidate the content sandbox between polls.
        lastError = error;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${description}${lastError ? ` (last error: ${lastError.message})` : ''}`);
  }

  /** Gracefully exit the whole browser and wait for the process to die. This
   * deliberately differs from close(), whose SIGTERM is only suite cleanup. */
  async quit({ timeoutMs = 30_000 } = {}) {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise((resolve) => this.process.once('exit', resolve));
    await this.driver.send('Marionette:Quit', {}, timeoutMs);
    const cleanExit = await Promise.race([
      exited.then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
    this.driver.socket.destroy();
    if (!cleanExit) {
      this.process.kill('SIGTERM');
      throw new Error(`Firefox did not exit within ${timeoutMs}ms after Marionette:Quit`);
    }
  }

  async close() {
    this.driver.socket.destroy();
    this.process.kill('SIGTERM');
  }
}

export function makeChecker(prefix = 'FIREFOX') {
  let failures = 0;
  const check = (condition, label, details = '') => {
    console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${!condition && details ? `\n${details}` : ''}`);
    if (!condition) failures++;
    return condition;
  };
  const finish = () => {
    console.log(failures === 0 ? `${prefix}: ALL PASSED` : `${prefix}: ${failures} FAILURE(S)`);
    return failures;
  };
  return { check, finish };
}
