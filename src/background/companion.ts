// Native Messaging bridge to the FlowGuard desktop companion (Phase 4).
// The companion is the HARD enforcer of the lock system: both sides keep a
// copy of the lock state and converge by merging (see companion-protocol.ts —
// each side re-broadcasts only when a merge CHANGED its state, so the sync
// cannot loop). No enforcement code lives here: merging into storage.local
// `lockState` is enough, lock-enforcer.ts reacts to the storage change.
//
// Most users won't have the companion installed (it ships with Pro), so the
// host-not-found path must stay silent and cheap: one console.info, no retry
// spam — re-attempt only on the next SW start and via a daily alarm. A real
// disconnect (companion crashed/restarting) reconnects with exponential
// backoff instead.
import { api, IS_FIREFOX } from '../shared/api';
import {
  HEARTBEAT_INTERVAL_MS,
  NM_HOST_NAME,
  PROTOCOL_VERSION,
} from '../shared/companion-protocol';
import type {
  CompanionMessage,
  CompanionSnapshot,
  CompanionStatus,
} from '../shared/companion-protocol';
import { getLockState, mergeRemoteLockState } from '../shared/lock';
import { EMPTY_LOCK_STATE } from '../shared/lock-math';
import type { LockState } from '../shared/lock-math';

const SNAPSHOT_KEY = 'companionSnapshot';
const RETRY_ALARM = 'companion-retry';
/** Chrome's connectNative SW-keepalive is best-effort (a long-standing bug
 *  can still reap the SW at ~5min); a dead SW stops heartbeating and the
 *  companion's watchdog would false-positive and close the browser. While a
 *  companion exists (connected or retrying), this alarm wakes the SW well
 *  inside the watchdog's 60s grace so port + heartbeat get re-established.
 *  Cleared on 'not-installed' — free-tier users get zero recurring wakeups. */
const KEEPALIVE_ALARM = 'companion-keepalive';
const KEEPALIVE_PERIOD_MIN = 0.5; // Chrome 120+ minimum period
/** Chrome connectNative to a MISSING host still returns a port and only then
 *  fires onDisconnect — so "connected" means first message received OR the
 *  port surviving this long. */
const CONNECT_CONFIRM_MS = 3_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

const EMPTY_SNAPSHOT: CompanionSnapshot = {
  state: 'connecting',
  status: null,
  lastConnectedAt: null,
};

let port: chrome.runtime.Port | null = null;
/** In-memory snapshot; mirrored to storage.local so the options page shows
 *  last-known state across SW restarts, even before a reconnect. */
let snapshot: CompanionSnapshot | null = null;
let confirmed = false;
let backoffMs = BACKOFF_MIN_MS;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let loggedNotInstalled = false;

export async function getCompanionSnapshot(): Promise<CompanionSnapshot> {
  if (snapshot) return snapshot;
  const stored = await api.storage.local.get(SNAPSHOT_KEY);
  snapshot = {
    ...EMPTY_SNAPSHOT,
    ...(stored[SNAPSHOT_KEY] as Partial<CompanionSnapshot> | undefined),
  };
  return snapshot;
}

function patchSnapshot(patch: Partial<CompanionSnapshot>): void {
  snapshot = { ...(snapshot ?? EMPTY_SNAPSHOT), ...patch };
  void api.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
}

function send(msg: CompanionMessage): void {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch {
    // Port died between onDisconnect scheduling and this call — the
    // onDisconnect handler owns the state transition, nothing to do here.
  }
}

/** First message received or the port outlived CONNECT_CONFIRM_MS. */
function markConnected(): void {
  if (confirmed || !port) return;
  confirmed = true;
  clearTimeout(confirmTimer);
  backoffMs = BACKOFF_MIN_MS;
  patchSnapshot({ state: 'connected', lastConnectedAt: Date.now() });
  void api.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  // Liveness signal for the companion's watchdog. Side effect we accept: an
  // open NM port keeps the Chrome (>=116) SW alive while the companion runs.
  heartbeatTimer = setInterval(() => {
    send({ v: PROTOCOL_VERSION, type: 'heartbeat', now: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
}

/** Incoming messages are untrusted (another process) and forward-compat:
 *  validate shape defensively, ignore unknown types silently. */
function onPortMessage(raw: unknown): void {
  markConnected();
  if (raw === null || typeof raw !== 'object') return;
  const msg = raw as { type?: unknown; lockState?: unknown; status?: unknown; running?: unknown };
  if (msg.type === 'lockStateSync') {
    // Merge-only; lock-enforcer.ts picks up the storage change. A change here
    // re-broadcasts via our storage.onChanged listener; the companion's merge
    // of its own echo is a no-op, so the exchange converges.
    void mergeRemoteLockState(msg.lockState).catch((e) =>
      console.warn('[FlowGuard] companion lock merge failed:', e),
    );
  } else if (msg.type === 'companionStatus') {
    const status = msg.status;
    if (status === null || typeof status !== 'object') return;
    // running === false = the nm-host relay is up but the daemon is not —
    // surface as 'disconnected' (options page: "installed but not running";
    // it distinguishes that from never-installed via the cached status).
    patchSnapshot({
      status: status as CompanionStatus,
      state: msg.running === false ? 'disconnected' : 'connected',
    });
    void mergeRemoteLockState((status as CompanionStatus).lockState).catch((e) =>
      console.warn('[FlowGuard] companion lock merge failed:', e),
    );
  }
}

function onPortDisconnect(p: chrome.runtime.Port): void {
  // Chrome reports the reason via runtime.lastError, Firefox via port.error.
  const err =
    api.runtime.lastError?.message ??
    (p as { error?: { message?: string } }).error?.message ??
    '';
  port = null;
  confirmed = false;
  clearTimeout(confirmTimer);
  clearInterval(heartbeatTimer);

  // Chrome: "Specified native messaging host not found." / Firefox: "No such
  // native application ...". Not an error — most installs have no companion.
  if (/not found|no such native application/i.test(err)) {
    if (!loggedNotInstalled) {
      loggedNotInstalled = true;
      console.info('[FlowGuard] desktop companion not installed; hard enforcement unavailable');
    }
    patchSnapshot({ state: 'not-installed' });
    void api.alarms.clear(KEEPALIVE_ALARM);
    return; // no backoff loop — daily alarm / next SW start only
  }

  // Companion crashed or is restarting (e.g. mid-update): backoff reconnect.
  // Keepalive stays armed (alarms persist across SW restarts) so a reaped SW
  // still comes back to retry — create, not just rely on markConnected's.
  patchSnapshot({ state: 'disconnected' });
  void api.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect(): void {
  if (port) return;
  patchSnapshot({ state: 'connecting' });
  let p: chrome.runtime.Port;
  try {
    p = api.runtime.connectNative(NM_HOST_NAME);
  } catch {
    // Some platforms throw instead of returning a doomed port.
    patchSnapshot({ state: 'not-installed' });
    void api.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  port = p;
  p.onMessage.addListener(onPortMessage);
  p.onDisconnect.addListener(() => onPortDisconnect(p));
  confirmTimer = setTimeout(markConnected, CONNECT_CONFIRM_MS);

  send({
    v: PROTOCOL_VERSION,
    type: 'hello',
    extVersion: api.runtime.getManifest().version,
    browser: IS_FIREFOX ? 'firefox' : navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome',
    extensionId: api.runtime.id,
  });
  void getLockState().then((lockState) => {
    if (port === p) send({ v: PROTOCOL_VERSION, type: 'lockStateSync', lockState });
  });
}

/** MV3: called synchronously from index.ts startup. */
export function initCompanionBridge(): void {
  // Outgoing sync: any local lockState write (popup, options, a merge of the
  // companion's own sync) goes back out. Merge-changed guards on both sides
  // keep this from looping.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lockState'] || !port) return;
    const lockState: LockState = { ...EMPTY_LOCK_STATE, ...changes['lockState'].newValue };
    send({ v: PROTOCOL_VERSION, type: 'lockStateSync', lockState });
  });

  // RETRY: daily re-attempt for the not-installed case (the user may install
  // the companion while the browser stays open; disconnects use backoff).
  // KEEPALIVE: wakes a possibly-reaped SW while a companion exists — with the
  // port gone, reconnect immediately; while connected it's a pure no-op.
  api.alarms.onAlarm.addListener((alarm) => {
    if ((alarm.name === RETRY_ALARM || alarm.name === KEEPALIVE_ALARM) && !port) connect();
  });

  void (async () => {
    // Hydrate the mirrored snapshot BEFORE connecting so a not-installed
    // verdict doesn't wipe the last-known companion status from storage.
    await getCompanionSnapshot();
    await api.alarms.create(RETRY_ALARM, { periodInMinutes: 24 * 60 });
    connect();
  })().catch((e) => console.warn('[FlowGuard] companion bridge init failed:', e));
}
