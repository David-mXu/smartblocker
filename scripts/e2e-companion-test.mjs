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
const blockingStatePath = join(DATA_DIR, 'blocking-state.json');
const eventsPath = join(DATA_DIR, 'events.log');
const readLockState = () => {
  try {
    return JSON.parse(readFileSync(lockStatePath, 'utf8'));
  } catch {
    return null;
  }
};
const readBlockingState = () => {
  try {
    return JSON.parse(readFileSync(blockingStatePath, 'utf8'));
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
function daemonCli(...args) {
  return spawnSync(DAEMON_BIN, [...args, '--socket', SOCKET], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}
async function extensionBlockingView() {
  return sw.evaluate(async () => {
    const stored = await chrome.storage.local.get(['settings', 'companionSnapshot']);
    return {
      enabled: stored.settings?.enabled ?? true,
      authority: stored.companionSnapshot?.status?.blocking ?? null,
    };
  });
}
async function waitForBlocking(enabled, minimumRevision) {
  const observed = await poll(
    async () => {
      const durable = readBlockingState();
      const local = await extensionBlockingView();
      return (
        durable?.enabled === enabled &&
        durable.revision >= minimumRevision &&
        local.enabled === enabled &&
        local.authority?.enabled === durable.enabled &&
        local.authority?.revision === durable.revision
      );
    },
    15_000,
    `blocking=${enabled}, revision>=${minimumRevision} reaches the extension`,
  );
  if (!observed) {
    console.log('  … blocking mismatch diagnostic:', JSON.stringify({
      durable: readBlockingState(),
      local: await extensionBlockingView().catch((error) => ({ error: error.message })),
    }));
  }
  return observed;
}
async function setExtensionEnabled(enabled) {
  await sw.evaluate(async (value) => {
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(stored.settings ?? {}), enabled: value },
    });
  }, enabled);
}
async function rapidExtensionEnabledSequence(...enabledValues) {
  await sw.evaluate(async (sequence) => {
    const stored = await chrome.storage.local.get('settings');
    let settings = stored.settings ?? {};
    for (const enabled of sequence) {
      settings = { ...settings, enabled };
      await chrome.storage.local.set({ settings });
    }
  }, enabledValues);
}

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

  // Item 8 full-loop authority check: this is the REAL daemon's post-hello
  // enforcer observation passing through nm-host → onPortMessage → the
  // extension cache, not a heartbeat-send timestamp or a test injection.
  let genuineSnapshot = null;
  check(
    await poll(
      async () => {
        const stored = await sw.evaluate(() => chrome.storage.local.get('companionSnapshot'));
        genuineSnapshot = stored.companionSnapshot ?? null;
        const observed = genuineSnapshot?.extensionLoss;
        return (
          genuineSnapshot?.status?.extensionLoss?.state === 'connected' &&
          observed?.state === 'connected' &&
          observed?.graceSeconds === 60 &&
          observed?.graceRemainingMs === null &&
          Number.isFinite(observed?.observedAtMs) &&
          Math.abs(observed.observedAtMs - Date.now()) < 60_000
        );
      },
      15_000,
      'healthy daemon observation reaches the real extension cache',
    ),
    'real authenticated daemon observation is receipt-stamped in the extension cache',
  );

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

  // (a0) Item 13: REAL daemon CLI + REAL Chromium storage/native-messaging
  // loop. Start with no active lock so both directions of ordinary blocking
  // are legal; every revision below comes from the daemon, never test code.
  check(
    await waitForBlocking(true, 1),
    'fresh daemon initializes from authenticated Chromium hello without a CLI write',
  );
  let cliResult = daemonCli('block', 'start');
  check(cliResult.status === 0, `block start acknowledged (${cliResult.stdout.trim()}${cliResult.stderr.trim()})`);
  check(await waitForBlocking(true, 1), 'block start persists and enables ordinary blocking in Chromium');
  const beforeStopRevision = readBlockingState()?.revision ?? 0;

  cliResult = daemonCli('block', 'stop');
  check(cliResult.status === 0, 'block stop acknowledged outside a lock');
  check(
    await waitForBlocking(false, beforeStopRevision + 1),
    'block stop propagates daemon authority into the real extension',
  );
  const stoppedRevision = readBlockingState()?.revision ?? beforeStopRevision + 1;

  // A genuine settings storage change must travel extension -> nm-host ->
  // daemon and increment the durable revision. The daemon-applied return
  // write is then recognized as an echo rather than another user intent.
  await setExtensionEnabled(true);
  check(
    await waitForBlocking(true, stoppedRevision + 1),
    'Chromium settings intent persists back through native messaging to the daemon',
  );
  const convergedRevision = readBlockingState()?.revision ?? stoppedRevision + 1;
  await sleep(800);
  check(
    readBlockingState()?.revision === convergedRevision,
    'daemon-applied settings echo terminates without revision churn',
  );

  const beforeRapidOn = readBlockingState()?.revision ?? convergedRevision;
  await rapidExtensionEnabledSequence(false, true);
  check(
    await waitForBlocking(true, beforeRapidOn + 2),
    'rapid real-storage off→on rebases the newest intent after the older acknowledgement',
  );
  await sleep(300);
  check(
    readBlockingState()?.revision === beforeRapidOn + 2,
    'rapid off→on settles after exactly one intent per daemon revision',
  );

  const beforeToggleOff = readBlockingState()?.revision ?? convergedRevision;
  cliResult = daemonCli('block', 'toggle');
  check(cliResult.status === 0, 'block toggle-off acknowledged outside a lock');
  check(
    await waitForBlocking(false, beforeToggleOff + 1),
    'block toggle-off reaches the real extension',
  );
  const beforeRapidOff = readBlockingState()?.revision ?? beforeToggleOff + 1;
  await rapidExtensionEnabledSequence(true, false);
  check(
    await waitForBlocking(false, beforeRapidOff + 2),
    'rapid real-storage on→off cannot be overwritten by the older on acknowledgement',
  );
  await sleep(300);
  check(
    readBlockingState()?.revision === beforeRapidOff + 2,
    'rapid on→off also settles without revision churn',
  );
  const beforeToggleOn = readBlockingState()?.revision ?? beforeToggleOff + 1;
  cliResult = daemonCli('block', 'toggle');
  check(cliResult.status === 0, 'block toggle-on acknowledged outside a lock');
  check(
    await waitForBlocking(true, beforeToggleOn + 1),
    'block toggle-on reaches the real extension',
  );

  // Item 14: a REAL classifier + cached-policy + boundary-sweep loop. The
  // active scope blocks despite the category being absent from blockedLabels;
  // an inactive scope then rescues a REAL model verdict, but never a rule hit.
  const beforeScopedPolicy = await sw.evaluate(() =>
    chrome.storage.local.get(['settings', 'lockState']),
  );
  const setScopedPolicy = async ({ active, blockGames, deterministic }) => {
    await sw.evaluate(
      async ({ active, blockGames, deterministic }) => {
        const stored = await chrome.storage.local.get(['settings', 'lockState']);
        const now = new Date();
        const minute = now.getHours() * 60 + now.getMinutes();
        const categories = ['video games'];
        const scoped = {
          id: 'e2e-category-window',
          days: active
            ? [...new Set([now.getDay(), (now.getDay() + 6) % 7])]
            : [(now.getDay() + 1) % 7],
          startMinutes: active ? (minute + 1438) % 1440 : 0,
          endMinutes: active ? (minute + 120) % 1440 : 1439,
          tzOffsetMinutes: -now.getTimezoneOffset(),
          categories,
        };
        await chrome.storage.local.set({
          settings: {
            ...stored.settings,
            enabled: true,
            blockThreshold: 0.5,
            blockedLabels: blockGames
              ? [...new Set([...(stored.settings?.blockedLabels ?? []), 'video games'])]
              : (stored.settings?.blockedLabels ?? []).filter((label) => label !== 'video games'),
            blocklist: deterministic
              ? [...new Set([...(stored.settings?.blocklist ?? []), 'dark souls'])]
              : (stored.settings?.blocklist ?? []).filter((rule) => rule !== 'dark souls'),
          },
          lockState: {
            ...stored.lockState,
            categorySchedules: [scoped],
            categorySchedulesUpdatedAt: Date.now(),
          },
        });
      },
      { active, blockGames, deterministic },
    );
  };
  const scopedWatch = (title) =>
    `<!doctype html><html><head><title>${title} - YouTube</title></head><body><h1>${title}</h1></body></html>`;
  await context.route('**://www.youtube.com/**', (route) => {
    const u = new URL(route.request().url());
    route.fulfill({
      contentType: 'text/html',
      body: scopedWatch(decodeURIComponent(u.searchParams.get('t') ?? 'YouTube')),
    });
  });
  const scopedTab = await context.newPage();
  const scopedUrl = 'https://www.youtube.com/watch?v=x&t=' + encodeURIComponent('speedrunning Dark Souls');
  const hasScopedBlockScreen = async () => {
    if (await scopedTab.locator('#smartblocker-overlay').count().catch(() => 0)) return true;
    const u = new URL(scopedTab.url());
    return u.protocol === 'chrome-extension:' && u.pathname.endsWith('/blocked.html');
  };
  await setScopedPolicy({ active: true, blockGames: false, deterministic: false });
  await scopedTab.goto(scopedUrl);
  check(
    await poll(hasScopedBlockScreen, MODEL_TIMEOUT_MS, 'active category schedule blocks the game page'),
    'active per-category schedule blocks without the ordinary blocked label',
  );

  await setScopedPolicy({ active: false, blockGames: true, deterministic: false });
  const sampleCountBeforeRescue = await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('latencySamples');
    return (stored.latencySamples ?? []).length;
  });
  await scopedTab.goto(scopedUrl);
  check(
    await poll(
      async () => {
        const stored = await sw.evaluate(() => chrome.storage.local.get('latencySamples'));
        return (stored.latencySamples ?? [])
          .slice(sampleCountBeforeRescue)
          .some((sample) => sample.url === scopedUrl && sample.blocked === false);
      },
      MODEL_TIMEOUT_MS,
      'inactive schedule rescues a completed classifier verdict',
    ),
    'inactive per-category schedule rescues a real classifier block',
  );

  await setScopedPolicy({ active: false, blockGames: true, deterministic: true });
  await scopedTab.goto(`${scopedUrl}&case=deterministic`);
  check(
    await poll(hasScopedBlockScreen, 30_000, 'deterministic rule remains blocked outside category hours'),
    'inactive per-category schedule cannot rescue a deterministic rule',
  );
  await sw.evaluate(async (original) => {
    const current = await chrome.storage.local.get('lockState');
    const restored = { ...current.lockState };
    delete restored.categorySchedules;
    delete restored.categorySchedulesUpdatedAt;
    if (original.lockState?.categorySchedules !== undefined) {
      restored.categorySchedules = original.lockState.categorySchedules;
    }
    if (original.lockState?.categorySchedulesUpdatedAt !== undefined) {
      restored.categorySchedulesUpdatedAt = original.lockState.categorySchedulesUpdatedAt;
    }
    await chrome.storage.local.set({ settings: original.settings, lockState: restored });
  }, beforeScopedPolicy);
  await scopedTab.close();

  // Already-classified SUBITEMS: no navigation between these assertions. The
  // scoped epoch invalidates allowed states and classifier masks, while a
  // deterministic sentinel must survive every transition.
  await context.route('**://www.youtube.com/results*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>Search - YouTube</title></head><body>
        <ytd-video-renderer class="e2e-game-card"><a id="video-title" href="/watch?v=gamevideo01" title="speedrunning Dark Souls">speedrunning Dark Souls</a></ytd-video-renderer>
        <ytd-video-renderer class="e2e-rule-card"><a id="video-title" href="/watch?v=rulevideo01" title="deterministic sentinel">deterministic sentinel</a></ytd-video-renderer>
      </body></html>`,
    }),
  );
  await context.route('**://example.com/scoped-subitems', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>Study notes</title></head><body>
        <lite-youtube class="e2e-facade" videoid="gamevideo01" title="speedrunning Dark Souls"></lite-youtube>
      </body></html>`,
    }),
  );
  await setScopedPolicy({ active: false, blockGames: true, deterministic: false });
  const searchTab = await context.newPage();
  await searchTab.goto('https://www.youtube.com/results?search_query=games');
  const embedTab = await context.newPage();
  await embedTab.goto('https://example.com/scoped-subitems');
  const attributes = (tab, selector) =>
    tab.locator(selector).evaluate((el) => ({
      state: el.getAttribute('data-smartblocker-state'),
      masked: el.getAttribute('data-smartblocker-masked'),
      classifier: el.getAttribute('data-smartblocker-classifier'),
      bars: el.querySelectorAll(':scope > .smartblocker-mask-bar').length,
    }));
  const expectAllowed = async (tab, selector) =>
    poll(
      async () => {
        const current = await attributes(tab, selector);
        return current.state === 'allowed' && current.masked === null && current.bars === 0;
      },
      MODEL_TIMEOUT_MS,
      `${selector} becomes allowed through the current scoped policy`,
    );
  const expectClassifierMask = async (tab, selector) =>
    poll(
      async () => {
        const current = await attributes(tab, selector);
        return current.masked !== null && current.classifier === '1' && current.bars === 1;
      },
      MODEL_TIMEOUT_MS,
      `${selector} becomes classifier-masked by the active scoped policy`,
    );
  check(
    (await expectAllowed(searchTab, '.e2e-game-card')) &&
      (await expectAllowed(embedTab, '.e2e-facade')),
    'existing search card and embed initially receive inactive classifier rescue',
  );
  await setScopedPolicy({ active: true, blockGames: false, deterministic: false });
  check(
    (await expectClassifierMask(searchTab, '.e2e-game-card')) &&
      (await expectClassifierMask(embedTab, '.e2e-facade')),
    'active scope re-gates existing allowed search card and embed without navigation',
  );
  await setScopedPolicy({ active: false, blockGames: true, deterministic: false });
  check(
    (await expectAllowed(searchTab, '.e2e-game-card')) &&
      (await expectAllowed(embedTab, '.e2e-facade')),
    'inactive scope clears existing classifier masks without navigation',
  );

  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...stored.settings,
        blocklist: [...new Set([...(stored.settings?.blocklist ?? []), 'deterministic sentinel'])],
      },
    });
  });
  check(
    await poll(
      async () => (await attributes(searchTab, '.e2e-rule-card')).masked === 'serp-card',
      30_000,
      'deterministic sentinel becomes masked',
    ),
    'deterministic sentinel installs a rule-owned mask',
  );
  await setScopedPolicy({ active: true, blockGames: false, deterministic: false });
  check(
    await expectClassifierMask(searchTab, '.e2e-game-card'),
    'next active epoch re-masks the classifier card beside the rule sentinel',
  );
  // At this point the page has lived through multiple policy epochs. A single
  // persistent MutationObserver must dispatch with this CURRENT epoch rather
  // than the first sanitizer invocation's stale epoch.
  await searchTab.evaluate(() => {
    const card = document.createElement('ytd-video-renderer');
    card.className = 'e2e-lazy-card';
    const link = document.createElement('a');
    link.id = 'video-title';
    link.href = '/watch?v=lazyvideo01';
    link.title = 'speedrunning Dark Souls';
    link.textContent = link.title;
    card.appendChild(link);
    document.body.appendChild(card);
  });
  check(
    await expectClassifierMask(searchTab, '.e2e-lazy-card'),
    'lazy card inserted after repeated epoch changes still accepts fresh verdicts',
  );
  const sentinelAfterActivation = await attributes(searchTab, '.e2e-rule-card');
  await setScopedPolicy({ active: false, blockGames: true, deterministic: false });
  check(
    (await expectAllowed(searchTab, '.e2e-game-card')) &&
      (await attributes(searchTab, '.e2e-rule-card')).masked === 'serp-card' &&
      sentinelAfterActivation.classifier === null,
    'scoped policy resets never clear deterministic masks',
  );
  await sw.evaluate(async (original) => {
    const current = await chrome.storage.local.get('lockState');
    const restored = { ...current.lockState };
    delete restored.categorySchedules;
    delete restored.categorySchedulesUpdatedAt;
    if (original.lockState?.categorySchedules !== undefined) {
      restored.categorySchedules = original.lockState.categorySchedules;
    }
    if (original.lockState?.categorySchedulesUpdatedAt !== undefined) {
      restored.categorySchedulesUpdatedAt = original.lockState.categorySchedulesUpdatedAt;
    }
    await chrome.storage.local.set({ settings: original.settings, lockState: restored });
  }, beforeScopedPolicy);
  await searchTab.close();
  await embedTab.close();

  cliResult = daemonCli('lock', '1');
  check(cliResult.status === 0, `lock 1 acknowledged (${cliResult.stdout.trim()}${cliResult.stderr.trim()})`);
  const firstCliLock = readLockState();
  const firstLockUntil = firstCliLock?.timerUntil ?? 0;
  check(
    firstLockUntil > Date.now() + 45_000 && readBlockingState()?.enabled === true,
    'lock acknowledgement follows durable timer + enabled-state writes',
  );
  check(
    await poll(
      async () => {
        const stored = await sw.evaluate(() => chrome.storage.local.get('lockState'));
        return stored.lockState?.timerUntil === firstLockUntil;
      },
      15_000,
      'CLI timer lock reaches Chromium',
    ),
    'CLI timer lock synchronizes into the real extension',
  );

  cliResult = daemonCli('lock', '2');
  const secondLockUntil = readLockState()?.timerUntil ?? 0;
  check(
    cliResult.status === 0 && secondLockUntil > firstLockUntil,
    'a later lock command extends the persisted monotonic deadline',
  );
  const lockedBlocking = readBlockingState();
  cliResult = daemonCli('block', 'stop');
  check(
    cliResult.status !== 0 && /lock is active/.test(cliResult.stderr),
    'block stop is truthfully refused during the CLI timer lock',
  );
  cliResult = daemonCli('block', 'toggle');
  check(
    cliResult.status !== 0 && /lock is active/.test(cliResult.stderr),
    'block toggle-off is truthfully refused during the CLI timer lock',
  );
  check(
    JSON.stringify(readBlockingState()) === JSON.stringify(lockedBlocking) &&
      readLockState()?.timerUntil === secondLockUntil,
    'locked disable refusals preserve both durable authority and timer deadline',
  );

  const beforeLockedStart = readBlockingState()?.revision ?? 0;
  cliResult = daemonCli('block', 'start');
  check(
    cliResult.status === 0 && readBlockingState()?.revision === beforeLockedStart,
    'block start remains legal and idempotent during a lock',
  );

  // Bypass the TypeScript setSettings guard deliberately. The daemon is the
  // authority of last resort: reject the disable and return enabled=true;
  // the extension's enable-only exception must be able to apply that healing.
  await setExtensionEnabled(false);
  check(
    await waitForBlocking(true, beforeLockedStart),
    'raw Chromium disable during a lock is refused and healed back to enabled',
  );
  cliResult = daemonCli('status', '--data-dir', DATA_DIR);
  check(
    cliResult.status === 0 &&
      /blockingEnabled: on/.test(cliResult.stdout) &&
      /settingsLocked: true/.test(cliResult.stdout),
    'CLI status reports the persisted ordinary and timer-lock state truthfully',
  );

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

  // Item 8 RENDER FIXTURE ONLY: inject the already-validated cache response at
  // the page's GET_COMPANION_STATUS boundary. This does NOT simulate a stale
  // heartbeat or test the enforcer; the real daemon loop is checked above and
  // below. Disabling only the 5s interval makes the storage-listener assertion
  // deterministic instead of accidentally passing through the fallback poll.
  async function openGraceFixture(path) {
    const page = await context.newPage();
    const fixture = {
      state: 'connected',
      status: {
        companionVersion: 'ui-fixture',
        pro: true,
        enforcement: { appBlocking: true, watchdog: true, policyProtected: false },
        lockState: genuineSnapshot?.status?.lockState ?? {},
        extensionLoss: { state: 'grace', graceSeconds: 60, graceRemainingMs: 42_000 },
      },
      extensionLoss: {
        state: 'grace',
        observedAtMs: Date.now(),
        lastHeartbeatAtMs: null,
        graceRemainingMs: 42_000,
        graceSeconds: 60,
      },
      lastConnectedAt: Date.now(),
    };
    await page.addInitScript((initial) => {
      window.__graceFixture = initial;
      window.__graceStatusReads = 0;
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (handler, delay, ...args) =>
        delay === 5000 ? 0 : setInterval(handler, delay, ...args);
      chrome.runtime.sendMessage = (...args) => {
        if (args[0]?.type === 'GET_COMPANION_STATUS') {
          window.__graceStatusReads++;
          return Promise.resolve({
            ok: true,
            snapshot: structuredClone(window.__graceFixture),
            incognitoAllowed: true,
          });
        }
        return sendMessage(...args);
      };
    }, fixture);
    await page.goto(`chrome-extension://${EXTENSION_ID}/${path}`);
    return page;
  }

  const fixtureOpts = await openGraceFixture('options.html#companion');
  check(
    await poll(
      async () => {
        const text = (await fixtureOpts.locator('#companion-grace').textContent().catch(() => '')) ?? '';
        const seconds = Number(text.match(/in (\d+)s/)?.[1] ?? 0);
        return seconds > 0 && seconds <= 42;
      },
      10_000,
      'injected grace fixture renders on options',
    ),
    'INJECTED UI FIXTURE: options renders the daemon-observation countdown wording',
  );
  const fixturePopup = await openGraceFixture('popup.html');
  check(
    await poll(
      async () => {
        const text = (await fixturePopup.locator('#extension-grace').textContent().catch(() => '')) ?? '';
        const seconds = Number(text.match(/in (\d+)s/)?.[1] ?? 0);
        return seconds > 0 && seconds <= 42;
      },
      10_000,
      'injected grace fixture renders on popup',
    ),
    'INJECTED UI FIXTURE: popup renders the daemon-observation countdown wording',
  );
  await fixturePopup.close();

  const fixtureReads = await fixtureOpts.evaluate(() => window.__graceStatusReads);
  const disconnectedFixture = await fixtureOpts.evaluate(() => {
    window.__graceFixture = { ...window.__graceFixture, state: 'disconnected', extensionLoss: null };
    return window.__graceFixture;
  });
  await sw.evaluate((value) => chrome.storage.local.set({ companionSnapshot: value }), disconnectedFixture);
  check(
    await poll(
      async () => {
        const reads = await fixtureOpts.evaluate(() => window.__graceStatusReads);
        const text = (await fixtureOpts.locator('#companion-grace').textContent().catch(() => '')) ?? '';
        return reads > fixtureReads && /remaining time is unavailable/.test(text) && !/\d+s/.test(text);
      },
      2_000,
      'options companion storage event refreshes immediately',
    ),
    'INJECTED UI FIXTURE: options storage event clears the number without the 5s fallback poll',
  );
  await fixtureOpts.close();
  if (genuineSnapshot) {
    await sw.evaluate((value) => chrome.storage.local.set({ companionSnapshot: value }), genuineSnapshot);
  }

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
  const blockingBeforeRestart = readBlockingState();
  daemon.kill('SIGKILL');
  check(
    await poll(
      async () => {
        const stored = await sw.evaluate(() => chrome.storage.local.get('companionSnapshot'));
        const optionText = (await opts.locator('#companion-status').textContent().catch(() => '')) ?? '';
        return (
          stored.companionSnapshot?.state === 'disconnected' &&
          stored.companionSnapshot?.extensionLoss === null &&
          /installed but not running/i.test(optionText)
        );
      },
      15_000,
      'real daemon loss clears the live observation and options state',
    ),
    'real daemon loss clears the cached observation and updates the open options page',
  );
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
  check(
    await poll(
      async () => {
        const stored = await sw.evaluate(() => chrome.storage.local.get('companionSnapshot'));
        return (
          stored.companionSnapshot?.state === 'connected' &&
          stored.companionSnapshot?.extensionLoss?.state === 'connected' &&
          Number.isFinite(stored.companionSnapshot?.extensionLoss?.observedAtMs)
        );
      },
      30_000,
      'daemon recovery restores a fresh real observation',
    ),
    'daemon recovery publishes a fresh authenticated observation to the extension',
  );
  const blockingRestored = await waitForBlocking(
    blockingBeforeRestart?.enabled ?? true,
    blockingBeforeRestart?.revision ?? 1,
  );
  check(
    blockingRestored &&
      JSON.stringify(readBlockingState()) === JSON.stringify(blockingBeforeRestart),
    'daemon restart reloads the exact durable blocking value + revision into Chromium',
  );

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
