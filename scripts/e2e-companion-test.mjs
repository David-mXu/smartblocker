// Full Linux loop for the desktop companion: real Chromium + real extension
// + real nm-host relay + real daemon, wired through an actual Native
// Messaging manifest in the test profile.
//
//   node scripts/e2e-companion-test.mjs
//
// Chromium reads NM host manifests from <user-data-dir>/NativeMessagingHosts
// on Linux, and the browser's env is inherited by the spawned nm-host, which
// is how FLOWGUARD_SOCKET points the relay at the scratch daemon. Reuses
// .e2e-profile/ (run scripts/e2e-test.mjs first for a warm model cache).
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile');
const COMPANION = resolve('companion');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh'; // fixed by manifest "key"
const SOCKET = `flowguard-e2e-${process.pid}`;
const MODEL_TIMEOUT_MS = 5 * 60_000;

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`… poll timed out: ${label}`);
  return false;
}

// 1. Build the companion binaries (cargo respects default-members: no Tauri).
console.log('… cargo build (nm-host + daemon)');
execFileSync('cargo', ['build', '-p', 'flowguard-nm-host', '-p', 'flowguard-daemon'], {
  cwd: COMPANION,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
});
const NM_HOST_BIN = join(COMPANION, 'target/debug/flowguard-nm-host');
const DAEMON_BIN = join(COMPANION, 'target/debug/flowguard-daemon');

// 2. Scratch daemon data dir: fakegame in the app blocklist from the start.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'flowguard-e2e-'));
writeFileSync(
  join(DATA_DIR, 'config.json'),
  JSON.stringify({ appBlocklist: ['fakegame'], extraIncompatibleBrowsers: [] }, null, 2),
);

// 3. NM manifest into the Chromium profile.
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(
  join(PROFILE, 'NativeMessagingHosts/dev.davidxu.flowguard.json'),
  JSON.stringify(
    {
      name: 'dev.davidxu.flowguard',
      description: 'FlowGuard companion bridge (e2e)',
      path: NM_HOST_BIN,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  ),
);

// Stale SW script cache (same hazard as the main e2e).
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

const children = [];
function startDaemon() {
  const child = spawn(
    DAEMON_BIN,
    ['run', '--socket', SOCKET, '--data-dir', DATA_DIR, '--extra-browser', 'fakebrowser'],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  children.push(child);
  return child;
}
let daemon = startDaemon();
await sleep(300); // let the listener bind before Chromium spawns relays

const lockStatePath = join(DATA_DIR, 'lock-state.json');
const eventsPath = join(DATA_DIR, 'events.log');
const readLockState = () => {
  try {
    return JSON.parse(readFileSync(lockStatePath, 'utf8'));
  } catch {
    return null;
  }
};
const readEvents = () => {
  try {
    return readFileSync(eventsPath, 'utf8');
  } catch {
    return '';
  }
};

// 4. Chromium with the extension; FLOWGUARD_SOCKET reaches nm-host via env.
async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
      env: { ...process.env, FLOWGUARD_SOCKET: SOCKET },
    });
    let worker = ctx.serviceWorkers()[0];
    if (!worker) {
      const swPromise = ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      worker = ctx.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (worker) return { context: ctx, sw: worker };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    await sleep(2_000);
  }
  throw new Error('service worker did not boot after 3 launches');
}

const { context, sw } = await launchWithServiceWorker();

try {
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));
  check(sw.url().includes(EXTENSION_ID), `service worker booted with the stable ID (${sw.url()})`);

  // Clear lock/override state leaking from other runs of this profile.
  await sw.evaluate(() =>
    chrome.storage.local.remove(['overrides', 'feedback', 'lockState', 'companionSnapshot']),
  );

  // (a) Options page shows the live companion connection.
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const connectedOk = await poll(
    async () => /hardcore mode active/i.test((await opts.locator('#companion-status').textContent()) ?? ''),
    15_000,
    'companion connected on options page',
  );
  check(connectedOk, 'options page shows "Connected — hardcore mode active"');
  check(/hello.*chrome/i.test(readEvents()), 'daemon logged the extension hello (registry live)');

  // (b) Frozen Turkey started in the extension lands in the daemon's file.
  const frozenUntil = await sw.evaluate(async () => {
    const until = Date.now() + 90_000;
    const stored = await chrome.storage.local.get('lockState');
    const state = stored.lockState ?? {
      timerUntil: null, passwordHash: null, frozenUntil: null, schedules: [], schedulesUpdatedAt: 0,
    };
    await chrome.storage.local.set({ lockState: { ...state, frozenUntil: until } });
    return until;
  });
  const synced = await poll(
    async () => readLockState()?.frozenUntil === frozenUntil,
    5_000,
    'frozen turkey reaches daemon',
  );
  check(synced, `extension frozen turkey persisted by daemon within 5s (${frozenUntil})`);

  // (d) Blocklisted app: killed by the enforcement loop within ~2 ticks.
  copyFileSync('/bin/sleep', join(DATA_DIR, 'fakegame'));
  const fakegame = spawn(join(DATA_DIR, 'fakegame'), ['300'], { stdio: 'ignore' });
  children.push(fakegame);
  let gameExited = false;
  fakegame.on('exit', () => { gameExited = true; });
  check(await poll(() => gameExited, 10_000, 'fakegame killed'), 'blocklisted app closed during forced block');

  // (e) Incompatible browser: notice period, then closed + logged.
  copyFileSync('/bin/sleep', join(DATA_DIR, 'fakebrowser'));
  const fakebrowser = spawn(join(DATA_DIR, 'fakebrowser'), ['300'], { stdio: 'ignore' });
  children.push(fakebrowser);
  let browserExited = false;
  fakebrowser.on('exit', () => { browserExited = true; });
  check(
    await poll(() => browserExited, 25_000, 'fakebrowser killed'),
    'incompatible browser closed after its notice period',
  );
  check(/incompatible-browser-close/.test(readEvents()), 'incompatible close logged for the UI');

  // (c) Daemon restart with a longer seeded lock: state flows BACK into the
  // extension via the reconnect push (no re-hello happens on daemon bounce).
  daemon.kill('SIGKILL');
  await sleep(300);
  const seededUntil = frozenUntil + 60_000;
  const seeded = readLockState() ?? {
    timerUntil: null, passwordHash: null, frozenUntil: null, schedules: [], schedulesUpdatedAt: 0,
  };
  writeFileSync(lockStatePath, JSON.stringify({ ...seeded, frozenUntil: seededUntil }, null, 2));
  daemon = startDaemon();
  const mergedBack = await poll(
    async () => {
      const stored = await sw.evaluate(() => chrome.storage.local.get('lockState'));
      return stored?.lockState?.frozenUntil === seededUntil;
    },
    20_000, // nm-host retries every 2s; push-on-accept does the rest
    'seeded daemon lock merges into the extension',
  );
  check(mergedBack, 'daemon-seeded lock (survives extension wipe) merged back into the extension');

  // …and the merged forced block actually blocks a page.
  const fakeWatch = (title) =>
    `<!doctype html><html><head><title>${title} - YouTube</title></head><body><h1>${title}</h1></body></html>`;
  await context.route('**://www.youtube.com/**', (route) => {
    const u = new URL(route.request().url());
    route.fulfill({
      contentType: 'text/html',
      body: fakeWatch(decodeURIComponent(u.searchParams.get('t') ?? 'YouTube')),
    });
  });
  const tab = await context.newPage();
  await tab.goto('https://www.youtube.com/watch?v=x&t=' + encodeURIComponent('speedrunning Dark Souls'));
  const blocked = await tab
    .waitForSelector('#flowguard-overlay', { timeout: MODEL_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  check(blocked, 'distraction blocked while the companion-held lock is active');

  console.log(failures === 0 ? 'COMPANION E2E: ALL PASSED' : `COMPANION E2E: ${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  // Leave no NM manifest behind: the plain e2e asserts the NOT-installed UI.
  rmSync(join(PROFILE, 'NativeMessagingHosts/dev.davidxu.flowguard.json'), { force: true });
}
