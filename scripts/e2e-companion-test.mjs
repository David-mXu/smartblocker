// Full Linux loop for the desktop companion: real Chromium + real extension
// + real nm-host relay + real daemon, wired through an actual Native
// Messaging manifest in the test profile.
//
//   node scripts/e2e-companion-test.mjs
//
// Chromium reads NM host manifests from <user-data-dir>/NativeMessagingHosts
// on Linux, and the browser's env is inherited by the spawned nm-host, which
// is how SMARTBLOCKER_SOCKET points the relay at the scratch daemon. Reuses
// .e2e-profile/ (run scripts/e2e-test.mjs first for a warm model cache).
import { chromium } from 'playwright';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile');
const COMPANION = resolve('companion');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh'; // fixed by manifest "key"
const SOCKET = `smartblocker-e2e-${process.pid}`;
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
execFileSync('cargo', ['build', '-p', 'smartblocker-nm-host', '-p', 'smartblocker-daemon'], {
  cwd: COMPANION,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
});
const NM_HOST_BIN = join(COMPANION, 'target/debug/smartblocker-nm-host');
const DAEMON_BIN = join(COMPANION, 'target/debug/smartblocker-daemon');

// 2. Scratch daemon data dir: fakegame in the app blocklist from the start.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'smartblocker-e2e-'));
writeFileSync(
  join(DATA_DIR, 'config.json'),
  JSON.stringify({ appBlocklist: ['fakegame'], extraIncompatibleBrowsers: [] }, null, 2),
);
// Extra scratch dirs created inside the run; declared here so `finally` cleans them.
const SCRATCH_DIRS = [];

// 3. NM manifest into the Chromium profile.
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(
  join(PROFILE, 'NativeMessagingHosts/dev.davidxu.smartblocker.json'),
  JSON.stringify(
    {
      name: 'dev.davidxu.smartblocker',
      description: 'SmartBlocker companion bridge (e2e)',
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

// NM-style framing helpers for speaking to the daemon's IPC socket directly
// (abstract-namespace address = NUL-prefixed name).
const ABSTRACT_SOCKET = '\0' + SOCKET;
function frameEncode(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
class FrameStream {
  // The accumulator attaches at construction TIME, before connect() resolves:
  // bytes that land during the handshake window sit in the stream buffer, and
  // a 'data' listener attached only per-read never sees them (the stream
  // stays paused for pre-arrival bytes). next() then just polls the buffer.
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.err = null;
    sock.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); });
    sock.on('error', (e) => { this.err = e; });
    sock.on('end', () => { this.err = this.err ?? new Error('socket ended'); });
  }
  // One frame per call; rejects on EOF/timeout/oversize so probes are bounded.
  async next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (len > 1024 * 1024) throw new Error(`oversize frame: ${len}`);
        if (this.buf.length >= 4 + len) {
          const body = this.buf.subarray(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          return JSON.parse(body.toString('utf8'));
        }
      }
      if (this.err) throw this.err;
      if (Date.now() > deadline) throw new Error('frame timeout');
      await sleep(10);
    }
  }
}

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

// 4. Chromium with the extension; SMARTBLOCKER_SOCKET reaches nm-host via env.
async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
      env: { ...process.env, SMARTBLOCKER_SOCKET: SOCKET },
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

  // Clear lock/override state leaking from other runs of this profile —
  // INCLUDING the extension's clock-drift anchor: a stale anchor from an
  // earlier run reads as unexplained drift and shifts lock ends forward,
  // which breaks the exact-equality merge assertions below.
  await sw.evaluate(() =>
    chrome.storage.local.remove([
      'overrides', 'feedback', 'lockState', 'companionSnapshot', 'lockClockAnchor',
    ]),
  );

  // (a) Options page shows the live companion connection.
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#companion`);
  const connectedOk = await poll(
    async () => /hardcore mode active/i.test((await opts.locator('#companion-status').textContent()) ?? ''),
    15_000,
    'companion connected on options page',
  );
  check(connectedOk, 'options page shows "Connected — hardcore mode active"');
  check(/hello.*chrome/i.test(readEvents()), 'daemon logged the extension hello (registry live)');

  // (a1) Watchdog liveness probe (#7 residual): protocol PING is answered
  // with a PONG carrying the daemon instance identity (pid + mono-ms), and
  // probe-only connections must not produce relay-disconnect log noise.
  // Placed against the freshly started daemon — the supervision churn in
  // (f) makes any later slot racy without covering different code.
  const disconnectsBefore = (readEvents().match(/relay-disconnect/g) ?? []).length;
  async function pingPongProbe() {
    const sock = net.createConnection({ path: ABSTRACT_SOCKET });
    const frames = new FrameStream(sock); // attach before connect resolves
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write(frameEncode({ type: 'ping', v: 2 }));
    // The connect-greeting may lead the pong: read until it arrives.
    const seen = [];
    for (let i = 0; i < 8; i++) {
      const frame = await frames.next(4_000);
      seen.push(frame.type ?? JSON.stringify(frame));
      if (frame.type === 'pong') { sock.destroy(); return { pong: frame, seen }; }
    }
    sock.destroy();
    return { pong: null, seen };
  }
  const probe = await pingPongProbe().catch((e) => ({ pong: null, seen: [`error: ${e.message}`] }));
  const pong = probe.pong;
  if (!pong) console.log('  … probe frames seen:', probe.seen.join(', '));
  check(
    pong && typeof pong.pid === 'number' && pong.pid > 0 && typeof pong.monoMs === 'number',
    'protocol PING answered with PONG (pid + monoMs) — the watchdog liveness probe path',
  );
  await pingPongProbe().catch(() => null); // second probe: immediate re-probe sanity
  await sleep(300); // let any disconnect logging flush
  const disconnectsAfter = (readEvents().match(/relay-disconnect/g) ?? []).length;
  check(disconnectsAfter === disconnectsBefore, 'probe-only connections never log relay-disconnect');

  // (a+) Armed-phase kill (red-team #25): a timer-only countdown is NOT
  // force_blocking, yet the app blocklist must already be enforced the
  // moment the lock is armed. The copy lives in its own dir so (d)'s copy
  // stays a distinct process.
  const TIMER_DIR = mkdtempSync(join(tmpdir(), 'smartblocker-armed-'));
  SCRATCH_DIRS.push(TIMER_DIR);
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('lockState');
    const state = stored.lockState ?? {
      timerUntil: null, passwordHash: null, frozenUntil: null, schedules: [], schedulesUpdatedAt: 0,
    };
    await chrome.storage.local.set({
      lockState: { ...state, timerUntil: Date.now() + 120_000 },
    });
  });
  check(
    // Sync-integrity, not a latency SLA: MV3 SW wake + nm-host relay jitter +
    // notification traffic from the kill section can stretch delivery past 5s
    // on a loaded box. Observed once in a green-code run; 15s keeps it honest.
    await poll(() => (readLockState()?.timerUntil ?? 0) > Date.now(), 15_000, 'timer lock reaches daemon'),
    'extension timer persisted by daemon within 15s',
  );
  copyFileSync('/bin/sleep', join(TIMER_DIR, 'fakegame'));
  const armedGame = spawn(join(TIMER_DIR, 'fakegame'), ['300'], { stdio: 'ignore' });
  children.push(armedGame);
  let armedExited = false;
  armedGame.on('exit', () => { armedExited = true; });
  check(
    await poll(() => armedExited, 10_000, 'fakegame killed under a timer-only lock'),
    'blocklisted app closed during an ARMED (timer-only, not forced) lock',
  );

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
    15_000,
    'frozen turkey reaches daemon',
  );
  if (!synced) {
    // The suite rmSyncs DATA_DIR on exit — surface the daemon's actual view
    // now or the failure is un-debuggable post-mortem.
    console.log('  … daemon actually persisted:', JSON.stringify(readLockState()));
  }
  check(synced, `extension frozen turkey persisted by daemon within 15s (${frozenUntil})`);

  // (d) Blocklisted app: killed by the enforcement loop within ~2 ticks.
  copyFileSync('/bin/sleep', join(DATA_DIR, 'fakegame'));
  const fakegame = spawn(join(DATA_DIR, 'fakegame'), ['300'], { stdio: 'ignore' });
  children.push(fakegame);
  let gameExited = false;
  fakegame.on('exit', () => { gameExited = true; });
  check(await poll(() => gameExited, 10_000, 'fakegame killed'), 'blocklisted app closed during forced block');

  // (d2) Decoy: /bin/sleep renamed `smartblocker-daemon` must get NO
  // kill-immunity — it's not in the recorded PID set (its exe lives outside
  // the daemon's own dir), so it's closed as a hostile decoy and logged.
  copyFileSync('/bin/sleep', join(DATA_DIR, 'smartblocker-daemon'));
  const decoy = spawn(join(DATA_DIR, 'smartblocker-daemon'), ['300'], { stdio: 'ignore' });
  children.push(decoy);
  let decoyExited = false;
  decoy.on('exit', () => { decoyExited = true; });
  check(
    await poll(() => decoyExited, 10_000, 'decoy killed'),
    'decoy wearing the daemon name closed during forced block',
  );
  check(/decoy-killed/.test(readEvents()), 'decoy kill logged (decoy-killed event)');

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
  // Relative to NOW, not the earlier arm's frozenUntil: the (d)/(e) kill
  // sections run long enough that `frozenUntil + 60s` can land at/past expiry
  // by the time the distraction tab navigates, making "still locked" racy.
  const seededUntil = Date.now() + 120_000;
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
    30_000, // nm-host retries every 2s; push-on-accept does the rest (load-hardened)
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
  // The blockscreen has two generations: the in-page overlay AND the harder
  // force-redirect to the extension-owned /blocked.html (see e2e-test.mjs).
  // Either proves the companion-held lock actually blocks.
  const blocked = await poll(
    async () => {
      if (await tab.locator('#smartblocker-overlay').count().catch(() => 0)) return true;
      const u = new URL(tab.url());
      return u.protocol === 'chrome-extension:' && u.pathname.endsWith('/blocked.html');
    },
    MODEL_TIMEOUT_MS,
    'distraction blocked (overlay or blocked.html redirect)',
  );
  if (!blocked) {
    // Diagnose rather than guess: dump the tab state, the extension's merged
    // lock (vs now — did the seeded lock expire?) and the live DNR ruleset.
    const diag = await (async () => {
      const overlay = await tab.locator('#smartblocker-overlay').count().catch(() => -1);
      const stored = await sw.evaluate(() => chrome.storage.local.get('lockState')).catch(() => null);
      const rules = await sw
        .evaluate(() =>
          chrome.declarativeNetRequest
            ? chrome.declarativeNetRequest.getSessionRules()
            : 'dnr-unavailable',
        )
        .catch((e) => `err: ${e.message}`);
      return { url: tab.url(), overlay, now: Date.now(), lockState: stored?.lockState, rules };
    })();
    console.log('  … distraction-block diagnostics:', JSON.stringify(diag));
  }
  check(blocked, 'distraction blocked while the companion-held lock is active');

  // (f) Mutual supervision (the autostart shape): the watchdog spawns and
  // revives the daemon; the daemon — told the watchdog's pid via env —
  // revives the watchdog. Event-log deltas are the observable here, matching
  // the sections above.
  const daemonStartsBefore = (readEvents().match(/daemon-start/g) ?? []).length;
  const supervisorRespawnsBefore = (readEvents().match(/supervisor-respawned/g) ?? []).length;
  const watchdog = spawn(DAEMON_BIN, ['watchdog', '--socket', SOCKET, '--data-dir', DATA_DIR], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(watchdog);
  await sleep(300); // let the watchdog observe the live daemon once
  daemon.kill('SIGKILL');
  const revived = await poll(
    () => (readEvents().match(/daemon-start/g) ?? []).length > daemonStartsBefore,
    30_000,
    'watchdog revived the daemon',
  );
  check(revived, 'killing the daemon → watchdog respawns it (new daemon-start event)');
  if (revived) {
    // The revived daemon has the watchdog's pid via env and now supervises
    // it — killing the watchdog must trigger a supervisor respawn.
    watchdog.kill('SIGKILL');
    check(
      await poll(
        () => (readEvents().match(/supervisor-respawned/g) ?? []).length > supervisorRespawnsBefore,
        30_000,
        'daemon revived the watchdog',
      ),
      'killing the watchdog → daemon respawns it (supervisor-respawned event)',
    );
  }

  // (h) Uninstall guard (#22): refused while ANY lock is armed — a plain
  // countdown timer included (previously only forced blocks were guarded) —
  // and proceeds once nothing holds. Own scratch dirs + fake HOME so no
  // real registrations are touched.
  const U_DIR = mkdtempSync(join(tmpdir(), 'smartblocker-uninstall-'));
  const U_HOME = mkdtempSync(join(tmpdir(), 'smartblocker-home-'));
  SCRATCH_DIRS.push(U_DIR, U_HOME);
  const uLockPath = join(U_DIR, 'lock-state.json');
  const unlockedState = {
    timerUntil: null, passwordHash: null, frozenUntil: null, schedules: [], schedulesUpdatedAt: 0,
  };
  const uninstall = () =>
    spawnSync(DAEMON_BIN, ['uninstall', '--data-dir', U_DIR], {
      env: { ...process.env, HOME: U_HOME },
      encoding: 'utf8',
    });
  writeFileSync(uLockPath, JSON.stringify({ ...unlockedState, timerUntil: Date.now() + 60_000 }));
  let r = uninstall();
  check(r.status !== 0 && /lock is active/.test(r.stderr), 'uninstall refused under an armed timer lock');
  writeFileSync(uLockPath, JSON.stringify({ ...unlockedState, passwordHash: 'a'.repeat(64) }));
  r = uninstall();
  check(r.status !== 0 && /lock is active/.test(r.stderr), 'uninstall refused under a password lock');
  writeFileSync(uLockPath, JSON.stringify({ ...unlockedState, timerUntil: Date.now() - 1_000 }));
  r = uninstall();
  check(r.status === 0, 'uninstall proceeds once nothing is locked');

  // (i) Squatter vs watchdog (#7): a foreign process holding the IPC name
  // and answering garbage fails the PING/PONG probe, so the watchdog keeps
  // spawning `run` — each exits AddrInUse with NO daemon-start event — until
  // the squatter lets go, after which the real daemon binds and starts.
  try { execFileSync('pkill', ['-f', SOCKET]); } catch { /* first sweep */ }
  await sleep(800);
  try { execFileSync('pkill', ['-f', SOCKET]); } catch { /* stragglers */ }
  const squatterStartsBefore = (readEvents().match(/daemon-start/g) ?? []).length;
  const squatterConns = new Set();
  const squatter = net.createServer((conn) => {
    squatterConns.add(conn);
    conn.on('close', () => squatterConns.delete(conn));
    // The reader aborting mid-garbage must not crash the harness.
    conn.on('error', () => {});
    conn.write('garbage!!'); // framed garbage: the probe must not be fooled
  });
  await new Promise((res) => squatter.listen(ABSTRACT_SOCKET, res));
  const watch2 = spawn(DAEMON_BIN, ['watchdog', '--socket', SOCKET, '--data-dir', DATA_DIR], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(watch2);
  await sleep(5_000); // several probe+respawn cycles under the squatter
  check(
    (readEvents().match(/daemon-start/g) ?? []).length === squatterStartsBefore,
    'squatter holding the socket name: no daemon-start while squatted (probe not fooled)',
  );
  for (const conn of squatterConns) conn.destroy();
  await new Promise((res) => squatter.close(res));
  check(
    await poll(
      () => (readEvents().match(/daemon-start/g) ?? []).length > squatterStartsBefore,
      30_000,
      'daemon re-bound after the squatter left',
    ),
    'squatter gone → watchdog spawns a daemon that binds and starts',
  );

  console.log(failures === 0 ? 'COMPANION E2E: ALL PASSED' : `COMPANION E2E: ${failures} FAILURE(S)`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  // Sweep detached daemon/watchdog pairs (respawned by each other, so not
  // handles in `children`); the socket name is unique to this run.
  await sleep(400);
  try { execFileSync('pkill', ['-f', SOCKET]); } catch { /* nothing left */ }
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const dir of SCRATCH_DIRS) rmSync(dir, { recursive: true, force: true });
  // Leave no NM manifest behind: the plain e2e asserts the NOT-installed UI.
  rmSync(join(PROFILE, 'NativeMessagingHosts/dev.davidxu.smartblocker.json'), { force: true });
}
