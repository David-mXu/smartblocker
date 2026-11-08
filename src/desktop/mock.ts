// In-memory stand-in for the Tauri commands (see api.ts). Used whenever the
// page runs outside the companion window, so the UI can be developed and
// screenshotted in plain Chromium.
//
//   ?mock=<scenario>[,<scenario>…]  start state, patches applied in order
//   ?fast=1                         6-second undo window instead of 60s
//
// Behaviour mirrors the Rust contract: deferred focus-session commit with a
// 60s undo, add-only blocklist while locked (same error text as main.rs),
// license verify/clear, realistic running apps and raw events.log lines.
// Tests can poke the state through window.__sbMock.

import type {
  ActivityEvent,
  DesktopStatus,
  LicenseInfo,
  LockReason,
  PendingSession,
  RunningApp,
} from './api';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MAX_LOCK_MS = 30 * DAY;

interface MockState {
  status: DesktopStatus;
  events: ActivityEvent[];
  running: RunningApp[];
  /** Per-reason end times, folded into status.lock on every read. */
  ends: Partial<Record<LockReason, number | null>>;
  /** When set, start_companion rejects with this text. */
  startError?: string;
  /** Test hook: the next undo loses the race to the commit. */
  lateUndo?: boolean;
}

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const FAST = params.get('fast') === '1';
const UNDO_MS = FAST ? 6_000 : 60_000;
/** The record outlives commitAtMs until the next daemon tick (1–3s in Rust). */
const COMMIT_LAG_MS = 2_000;
const EXPIRED_GRACE_MS = 7 * DAY;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const RUNNING_APPS: RunningApp[] = [
  { name: '1password', count: 2, isBrowser: false },
  { name: 'brave', count: 7, isBrowser: true },
  { name: 'chrome', count: 23, isBrowser: true },
  { name: 'code', count: 11, isBrowser: false },
  { name: 'discord', count: 4, isBrowser: false },
  { name: 'epicgameslauncher', count: 1, isBrowser: false },
  { name: 'firefox', count: 9, isBrowser: true },
  { name: 'leagueclient', count: 3, isBrowser: false },
  { name: 'ms-teams', count: 3, isBrowser: false },
  { name: 'msedge', count: 14, isBrowser: true },
  { name: 'notion', count: 3, isBrowser: false },
  { name: 'obs64', count: 1, isBrowser: false },
  { name: 'onedrive', count: 1, isBrowser: false },
  { name: 'slack', count: 4, isBrowser: false },
  { name: 'spotify', count: 5, isBrowser: false },
  { name: 'steam', count: 1, isBrowser: false },
  { name: 'steamwebhelper', count: 6, isBrowser: false },
  { name: 'whatsapp', count: 2, isBrowser: false },
  { name: 'windowsterminal', count: 1, isBrowser: false },
  { name: 'zoom', count: 2, isBrowser: false },
];

function seedEvents(now: number): ActivityEvent[] {
  const at = (ago: number, kind: string, detail: string): ActivityEvent => ({ tsMs: now - ago, kind, detail });
  const wall = (ago: number) => String(now - ago);
  return [
    at(6 * MIN, 'kill', 'steam pid 18244 (BlockedApp)'),
    at(6 * MIN + 1_000, 'notify', 'steam is blocked while this session is active.'),
    at(22 * MIN, 'kill', 'msedge pid 9120 (Watchdog)'),
    at(22 * MIN + 10, 'watchdog-close', `Edge (wall ${wall(22 * MIN)})`),
    at(
      22 * MIN + 30_000,
      'notify',
      'The SmartBlocker extension is not responding in Edge. Re-enable it or the browser will be closed in 30s.',
    ),
    at(41 * MIN, 'kill', 'brave pid 15032 (IncompatibleBrowser)'),
    at(41 * MIN + 10, 'incompatible-browser-close', `brave (wall ${wall(41 * MIN)})`),
    at(
      41 * MIN + 1_000,
      'notify',
      'brave is not compatible with SmartBlocker and will be closed while this block is active.',
    ),
    at(48 * MIN, 'hello', 'Chrome ext 0.5.0 id dhbhbhhcjkfdkfbloeaeedndfjfadajh'),
    at(63 * MIN, 'config-tamper-restored', 'discord'),
    at(2 * HOUR + 4 * MIN, 'kill', 'smartblocker-daemon pid 20112 (DecoyImpersonation)'),
    at(2 * HOUR + 4 * MIN + 10, 'decoy-killed', 'smartblocker-daemon pid 20112'),
    at(3 * HOUR, 'license', 'free-no-key'),
    at(3 * HOUR + 50, 'daemon-start', 'socket smartblocker'),
    at(DAY + 2 * HOUR, 'relay-disconnect', 'conn 4'),
    at(DAY + 3 * HOUR, 'kill', 'discord pid 11876 (BlockedApp)'),
    at(DAY + 3 * HOUR + 900, 'notify', 'discord is blocked while this session is active.'),
    at(DAY + 3 * HOUR + 5 * MIN, 'focus-session-start', `until ${now - DAY - HOUR}`),
    at(DAY + 4 * HOUR, 'clock-tamper-compensated', 'wall clock jumped 3600412ms ahead of monotonic; lock deadlines shifted'),
    at(DAY + 5 * HOUR, 'conn-idle-reaped', 'conn 3: unauthenticated + idle > 30000ms'),
    at(DAY + 5 * HOUR + 20 * MIN, 'hello', 'Edge ext 0.5.0 id dhbhbhhcjkfdkfbloeaeedndfjfadajh'),
    at(DAY + 5 * HOUR + 20 * MIN + 5, 'pair', 'adopted a new browser pairing token'),
    at(2 * DAY + 1 * HOUR, 'kill', 'epicgameslauncher pid 6620 (BlockedApp)'),
    at(2 * DAY + 6 * HOUR, 'lock-file-restored', "disk copy was weaker than the daemon's in-memory state"),
    at(2 * DAY + 7 * HOUR, 'daemon-start', 'socket smartblocker'),
    at(2 * DAY + 7 * HOUR + 10, 'license', 'free-no-key'),
    at(3 * DAY, 'pair', 'adopted a new browser pairing token'),
  ];
}

function baseState(now: number): MockState {
  return {
    status: {
      version: '0.5.0',
      testMode: false,
      dataDir: 'C:\\Users\\sam\\AppData\\Roaming\\SmartBlocker',
      daemon: { running: true, pid: 7412, startedAtMs: now - 3 * HOUR },
      lock: { settingsLocked: false, forceBlocking: false, reasons: [], until: null },
      pendingSession: null,
      browsers: [
        { kind: 'chrome', extVersion: '0.5.0', lastSeenMs: now - 3_000 },
        { kind: 'edge', extVersion: '0.5.0', lastSeenMs: now - 8_000 },
      ],
      appBlocklist: ['steam', 'discord', 'epicgameslauncher'],
      license: { pro: false, state: 'none', expiresAtMs: null, keyHint: null },
      policyProtected: false,
      autostart: true,
    },
    events: seedEvents(now),
    running: RUNNING_APPS.map((a) => ({ ...a })),
    ends: {},
  };
}

type Patch = (s: MockState, now: number) => void;

const SCENARIOS: Record<string, Patch> = {
  unlocked: () => {},
  locked: (s, now) => {
    s.ends.frozen = now + 3 * HOUR + 12 * MIN;
  },
  timer: (s, now) => {
    s.ends.timer = now + 45 * MIN;
  },
  password: (s) => {
    s.ends.password = null;
  },
  schedule: (s, now) => {
    const end = new Date(now);
    end.setHours(17, 0, 0, 0);
    s.ends.schedule = end.getTime() > now + 10 * MIN ? end.getTime() : now + 2 * HOUR;
  },
  pending: (s, now) => {
    const clicked = now - 18_000 * (UNDO_MS / 60_000);
    s.status.pendingSession = { untilMs: clicked + 4 * HOUR, commitAtMs: clicked + UNDO_MS, durationMs: 4 * HOUR };
  },
  'no-daemon': (s) => {
    s.status.daemon = { running: false, pid: null, startedAtMs: null };
    s.status.browsers = [];
  },
  'start-fails': (s) => {
    s.startError = "Couldn't start the companion: smartblocker-daemon wasn't found next to the app.";
  },
  'autostart-off': (s) => {
    s.status.autostart = false;
  },
  'browsers-missing': (s) => {
    s.status.browsers = [];
  },
  'all-browsers': (s, now) => {
    s.status.browsers = [
      { kind: 'chrome', extVersion: '0.5.0', lastSeenMs: now - 3_000 },
      { kind: 'edge', extVersion: '0.5.0', lastSeenMs: now - 8_000 },
      { kind: 'firefox', extVersion: '0.5.0', lastSeenMs: now - 14_000 },
    ];
  },
  pro: (s, now) => {
    s.status.license = { pro: true, state: 'valid', expiresAtMs: now + 300 * DAY, keyHint: 'SBPRO1…a3f9' };
    s.status.policyProtected = true;
  },
  grace: (s, now) => {
    s.status.license = { pro: true, state: 'grace', expiresAtMs: now - 2 * DAY, keyHint: 'SBPRO1…a3f9' };
  },
  expired: (s, now) => {
    s.status.license = { pro: false, state: 'expired', expiresAtMs: now - 20 * DAY, keyHint: 'SBPRO1…a3f9' };
  },
  'dev-open': (s) => {
    s.status.license = { pro: true, state: 'dev-open', expiresAtMs: null, keyHint: null };
  },
  'test-mode': (s) => {
    s.status.testMode = true;
    s.status.autostart = false; // test mode never enables autostart
    s.status.dataDir = 'C:\\Users\\sam\\AppData\\Local\\Temp\\smartblocker-test';
    s.events = s.events.map((e) => (e.kind === 'kill' ? { ...e, kind: 'kill-dry-run' } : e));
    s.events = s.events.map((e) => (e.kind === 'daemon-start' ? { ...e, detail: 'socket smartblocker-test' } : e));
  },
  empty: (s) => {
    s.status.appBlocklist = [];
    s.events = [];
  },
};

export const MOCK_SCENARIOS = Object.keys(SCENARIOS);

// ---------------------------------------------------------------------------
// State + derivation
// ---------------------------------------------------------------------------

function initialState(): MockState {
  const now = Date.now();
  const s = baseState(now);
  const names = (params.get('mock') ?? 'unlocked').split(',').map((n) => n.trim()).filter(Boolean);
  for (const n of names) SCENARIOS[n]?.(s, now);
  return s;
}

let state: MockState | null = null;
function getState(): MockState {
  state ??= initialState();
  return state;
}

/** Fold per-reason end times into the public lock shape (mirrors lock_math). */
function deriveLock(s: MockState, now: number): void {
  const reasons: LockReason[] = [];
  let until: number | null = null;
  let force = false;
  for (const r of ['frozen', 'timer', 'schedule', 'password'] as LockReason[]) {
    if (!(r in s.ends)) continue;
    const end = s.ends[r];
    if (end === null || end === undefined) {
      if (r === 'password') reasons.push(r);
      continue;
    }
    if (end <= now) {
      delete s.ends[r];
      continue;
    }
    reasons.push(r);
    until = until === null ? end : Math.max(until, end);
    if (r === 'frozen' || r === 'schedule') force = true;
  }
  s.status.lock = { settingsLocked: reasons.length > 0, forceBlocking: force, reasons, until };
}

/** Daemon-tick stand-in: commit a due pending session, refresh heartbeats. */
function tick(s: MockState, now: number): void {
  const p = s.status.pendingSession;
  if (p && now >= p.commitAtMs + COMMIT_LAG_MS) {
    s.status.pendingSession = null;
    s.ends.frozen = Math.max(s.ends.frozen ?? 0, p.untilMs);
    log(s, 'focus-session-start', `until ${p.untilMs}`);
  }
  if (s.status.daemon.running) {
    s.status.browsers = s.status.browsers.map((b) => ({ ...b, lastSeenMs: Math.max(b.lastSeenMs, now - 4_000) }));
  }
  deriveLock(s, now);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function requireDaemon(s: MockState): void {
  if (!s.status.daemon.running) {
    throw "The companion isn't running, so nothing can be locked right now. Reopen SmartBlocker or restart your computer, then try again.";
  }
}

function checkMinutes(minutes: unknown): number {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < 1) {
    throw 'Choose a duration of at least 1 minute.';
  }
  return Math.min(m, MAX_LOCK_MS / MIN); // Rust clamps to MAX_LOCK_MS
}

const KEY_RE = /^SBPRO1\.[0-9a-f]{8,}\.[0-9a-f]{16,}$/;

/** Payload is hex of `pro:<id>` or `pro:<id>:<expiry ms>` (license.rs payload_expiry). */
function keyExpiry(key: string): number | null {
  const hex = key.split('.')[1] ?? '';
  let payload = '';
  for (let i = 0; i + 1 < hex.length; i += 2) payload += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  const tail = Number(payload.slice(payload.lastIndexOf(':') + 1));
  return Number.isInteger(tail) && tail >= 1_000_000_000_000 ? tail : null;
}

function log(s: MockState, kind: string, detail: string): void {
  s.events.unshift({ tsMs: Date.now(), kind, detail });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const s = getState();
  await delay(cmd === 'list_running_apps' ? 280 : cmd === 'get_status' ? 15 : 120);
  const now = Date.now();
  tick(s, now);

  switch (cmd) {
    case 'get_status':
      return clone(s.status);

    case 'start_focus_session': {
      requireDaemon(s);
      const minutes = checkMinutes(args.minutes);
      if (s.status.pendingSession) throw 'A focus session is already starting — undo it first to pick a different length.';
      const durationMs = minutes * MIN;
      const session: PendingSession = { untilMs: now + durationMs, commitAtMs: now + UNDO_MS, durationMs };
      s.status.pendingSession = session;
      return clone(session);
    }

    case 'undo_focus_session': {
      const p = s.status.pendingSession;
      if (p && s.lateUndo) {
        s.lateUndo = false;
        p.commitAtMs = now;
      }
      if (!p || now >= p.commitAtMs) return false;
      s.status.pendingSession = null;
      return true;
    }

    case 'start_timer_lock': {
      requireDaemon(s);
      const minutes = checkMinutes(args.minutes);
      s.ends.timer = Math.max(s.ends.timer ?? 0, now + minutes * MIN);
      deriveLock(s, now);
      return undefined;
    }

    case 'set_app_blocklist': {
      const apps = Array.isArray(args.apps) ? (args.apps as unknown[]).map(String) : [];
      if (s.status.lock.settingsLocked) {
        const keptAll = s.status.appBlocklist.every((old) => apps.some((n) => n.toLowerCase() === old.toLowerCase()));
        if (!keptAll) throw 'Locked: apps can be added but not removed until the lock ends.';
      }
      s.status.appBlocklist = apps;
      return undefined;
    }

    case 'list_running_apps':
      return clone(s.running);

    case 'get_recent_activity': {
      const limit = Math.max(0, Number(args.limit) || 0);
      return clone(s.events.slice(0, limit));
    }

    case 'set_license_key': {
      const key = String(args.key ?? '').trim();
      if (key === '') {
        if (s.status.lock.settingsLocked && s.status.license.keyHint) {
          throw "Locked: the license key can't be removed until the lock ends.";
        }
        s.status.license = { pro: false, state: 'none', expiresAtMs: null, keyHint: null };
        s.status.policyProtected = false;
        log(s, 'license', 'free-no-key');
        return clone(s.status.license);
      }
      if (!KEY_RE.test(key)) {
        throw "That license key isn't valid. Check that you copied the whole key.";
      }
      // Same order as license.rs: invalid → past grace → locked replace.
      const expiresAtMs = keyExpiry(key);
      if (expiresAtMs !== null && now >= expiresAtMs + EXPIRED_GRACE_MS) {
        throw 'That license key has expired. Renew it to get a new key.';
      }
      if (s.status.lock.settingsLocked && s.status.license.keyHint && s.status.license.keyHint !== `SBPRO1…${key.slice(-4)}`) {
        throw "Locked: the license key can't be changed until the lock ends.";
      }
      const inGrace = expiresAtMs !== null && now >= expiresAtMs;
      const info: LicenseInfo = {
        pro: true,
        state: inGrace ? 'grace' : 'valid',
        expiresAtMs,
        keyHint: `SBPRO1…${key.slice(-4)}`,
      };
      s.status.license = info;
      log(s, 'license', inGrace ? 'pro-grace' : 'pro');
      return clone(info);
    }

    case 'install_integration':
      if (s.status.testMode) return 'Test mode: nothing was registered, and autostart was left off.';
      s.status.autostart = true;
      return 'Browser connection repaired for Chrome, Edge and Firefox. SmartBlocker will start with Windows.';

    case 'start_companion': {
      if (s.startError) throw s.startError;
      if (!s.status.daemon.running) {
        s.status.daemon = { running: true, pid: 9044, startedAtMs: now };
        s.status.browsers = baseState(now).status.browsers;
        log(s, 'daemon-start', s.status.testMode ? 'socket smartblocker-test' : 'socket smartblocker');
      }
      return undefined;
    }

    default:
      throw `Unknown command: ${cmd}`;
  }
}

// Test hook: lets Playwright flip state mid-flow (e.g. a lock starting while
// the Blocked apps page is open) without waiting on real time.
if (typeof window !== 'undefined') {
  (window as unknown as { __sbMock: unknown }).__sbMock = {
    get state() {
      return getState();
    },
    lockFor(reason: LockReason, ms: number | null) {
      getState().ends[reason] = ms === null ? null : Date.now() + ms;
      deriveLock(getState(), Date.now());
    },
    invoke: mockInvoke,
    loseNextUndo() {
      getState().lateUndo = true;
    },
    commitNow() {
      const p = getState().status.pendingSession;
      if (p) p.commitAtMs = Date.now();
    },
    undoMs: UNDO_MS,
  };
}
