// Native Messaging bridge to the SmartBlocker desktop companion (Phase 4).
// The companion is the HARD enforcer of the lock system: both sides keep a
// copy of the lock state and converge by merging (see companion-protocol.ts —
// each side re-broadcasts only when a merge CHANGED its state, so the sync
// cannot loop). No enforcement code lives here: merging into storage.local
// `lockState` is enough, lock-enforcer.ts reacts to the storage change.
//
// Most users won't have the companion installed (it ships with Pro), so the
// host-not-found path must stay silent and cheap: one console.info, then no
// fresh native-port attempt on each event-page restart (its onDisconnect would
// itself reawaken Firefox forever). A scheduled daily alarm still re-checks;
// a real disconnect (companion crashed/restarting) uses exponential backoff.
import { api, IS_FIREFOX } from '../shared/api';
import {
  HEARTBEAT_INTERVAL_MS,
  NM_HOST_NAME,
  PROTOCOL_VERSION,
} from '../shared/companion-protocol';
import type {
  CompanionBlockingState,
  CompanionMessage,
  CompanionSnapshot,
  CompanionStatus,
} from '../shared/companion-protocol';
import { getLockState, mergeRemoteLockState } from '../shared/lock';
import { EMPTY_LOCK_STATE } from '../shared/lock-math';
import type { LockState } from '../shared/lock-math';
import type { PartnerCommandResponse, Request as ExtensionRequest } from '../shared/messages';
import { observeExtensionGrace } from '../shared/grace-math';
import { createAllowanceBridge } from './allowance-bridge';
import {
  COMPANION_BLOCKING_ECHO_KEY,
  getSettings,
  setCompanionBlockingEnabled,
} from '../shared/settings';
import {
  BlockingIntentLedger,
  parseCompanionBlockingState,
  sameBlockingAuthority,
  shouldAcceptBlockingAuthority,
} from '../shared/companion-blocking';

const SNAPSHOT_KEY = 'companionSnapshot';
/** Bearer token authenticating this browser profile to the daemon (TOFU):
 *  generated once per profile, sent in every hello, persisted daemon-side.
 *  Without it the daemon redacts password fields, ignores our heartbeats for
 *  watchdog purposes, and strips password writes — the IPC channel is local
 *  but otherwise unauthenticated (red-team 2026-11). */
const PAIRING_KEY = 'companionPairing';
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
  extensionLoss: null,
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
/** undefined = no live daemon observation yet; null = initialized-state field
 * absent, so this browser may offer its local value exactly once. */
let daemonBlocking: CompanionBlockingState | null | undefined;
/** True only after the daemon's authenticated, recipient-specific hello
 * response. The redacted accept-time greeting is not mutation authority. */
let browserAuthenticated = false;
/** Incremented whenever daemon authority is reset. Async lock merges and
 * settings writes must prove they still belong to the originating epoch. */
let blockingConnectionEpoch = 0;
let blockingApplySequence = 0;
/** Last value this bridge actually finished writing. It distinguishes an old
 * daemon write still visible in storage from a newer, untagged local write. */
let lastCompanionStoredEnabled: boolean | null = null;
const blockingEchoIds = new Set<string>();
let blockingAuthorityQueue: Promise<void> = Promise.resolve();
const blockingIntents = new BlockingIntentLedger();
let blockingIntentPump: Promise<void> | null = null;
let blockingIntentPumpAgain = false;

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
  const previous = snapshot;
  snapshot = { ...(snapshot ?? EMPTY_SNAPSHOT), ...patch };
  // Firefox emits storage.onChanged even for an identical storage.local.set.
  // Repeated no-op snapshot writes can therefore wake the event page again on
  // every idle shutdown, preventing a quiet event-page lifecycle entirely.
  if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
  void api.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
}

function send(msg: CompanionMessage): boolean {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch {
    // Port died between onDisconnect scheduling and this call — the
    // onDisconnect handler owns the state transition, nothing to do here.
    return false;
  }
}

const allowanceBridge = createAllowanceBridge({
  getConnection: () => {
    if (!port || !browserAuthenticated) return null;
    return {
      epoch: blockingConnectionEpoch,
      send: (message: unknown) => send(message as CompanionMessage),
    };
  },
  onAuthority: (allowance) => {
    if (!snapshot?.status) return;
    patchSnapshot({ status: { ...snapshot.status, allowance } });
  },
});

/** Undefined = fallback/unsupported, not daemon confirmation. */
export function getLiveAllowanceAuthority() {
  return allowanceBridge.current();
}

export function isAllowanceAuthorityInitializing(): boolean {
  return allowanceBridge.initializing();
}

export function submitCompanionAllowanceCommand(command: Parameters<typeof allowanceBridge.submit>[0]) {
  return allowanceBridge.submit(command);
}

type PartnerRequest = Extract<ExtensionRequest, { type: 'PARTNER_COMMAND' }>['command'];
interface PendingPartnerCommand {
  epoch: number;
  resolve: (response: PartnerCommandResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
let pendingPartnerCommand: PendingPartnerCommand | null = null;
let partnerCommandQueue: Promise<void> = Promise.resolve();
let partnerCommandTimeoutMs = 15_000;

/** Deterministic focused harness hook; null restores the production delay. */
export function setPartnerCommandTimeoutForTest(timeoutMs: number | null): void {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('Partner command test timeout must be positive.');
  }
  partnerCommandTimeoutMs = timeoutMs ?? 15_000;
}

/** Only one partner mutation can be outstanding per connection: legacy
 * CommandResult has no operation ID and must never match another epoch. */
export function submitPartnerCommand(command: PartnerRequest): Promise<PartnerCommandResponse> {
  const attempt = partnerCommandQueue.then(() => new Promise<PartnerCommandResponse>((resolve, reject) => {
    if (!port || !browserAuthenticated) {
      reject(new Error('The desktop partner authority is unavailable.'));
      return;
    }
    const epoch = blockingConnectionEpoch;
    const timer = setTimeout(() => {
      if (pendingPartnerCommand?.epoch !== epoch) return;
      pendingPartnerCommand = null;
      const retiredPort = port;
      // Legacy CommandResult has no request ID. Retire AND close authority so
      // a same-port late status/result cannot re-authenticate or resolve a
      // queued command. Reconnect requires a new authenticated hello epoch.
      resetBlockingConnection();
      reject(new Error('The companion did not acknowledge in time; the partner epoch was retired.'));
      try {
        retiredPort?.disconnect();
      } catch {
        // A concurrently closed port runs the ordinary disconnect path.
      }
    }, partnerCommandTimeoutMs);
    pendingPartnerCommand = { epoch, resolve, reject, timer };
    let action: CompanionMessage;
    switch (command.action) {
      case 'add-key':
        action = { v: PROTOCOL_VERSION, type: 'addKey', publicKey: command.publicKey };
        break;
      case 'arm':
        action = { v: PROTOCOL_VERSION, type: 'arm' };
        break;
      case 'begin-operation':
        action = { v: PROTOCOL_VERSION, type: 'beginOperation' };
        break;
      case 'redeem':
        action = { v: PROTOCOL_VERSION, type: 'redeem', token: command.token };
        break;
    }
    if (!send(action)) {
      clearTimeout(timer);
      pendingPartnerCommand = null;
      reject(new Error('The desktop partner authority disconnected before the command was sent.'));
    }
  }));
  partnerCommandQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

function resetBlockingConnection(): void {
  blockingConnectionEpoch++;
  daemonBlocking = undefined;
  browserAuthenticated = false;
  // Echo receipts from writes already in flight stay recognized: their storage
  // events may arrive after a new connection has been established.
  blockingIntents.reset();
  blockingIntentPumpAgain = false;
  allowanceBridge.reset();
  if (pendingPartnerCommand) {
    clearTimeout(pendingPartnerCommand.timer);
    pendingPartnerCommand.reject(new Error('The desktop partner authority disconnected.'));
    pendingPartnerCommand = null;
  }
}

function isCurrentBlockingConnection(
  epoch: number,
  activePort: chrome.runtime.Port,
): boolean {
  return epoch === blockingConnectionEpoch && port === activePort;
}

async function pumpBlockingIntent(): Promise<void> {
  const activePort = port;
  const epoch = blockingConnectionEpoch;
  const observed = daemonBlocking;
  if (
    !activePort ||
    !browserAuthenticated ||
    observed === undefined ||
    blockingIntents.hasInFlight
  ) {
    return;
  }
  const pending = blockingIntents.pendingLocalValue;
  const storedEnabled = (await getSettings()).enabled;
  if (
    !isCurrentBlockingConnection(epoch, activePort) ||
    !browserAuthenticated ||
    !sameBlockingAuthority(observed, daemonBlocking) ||
    blockingIntents.hasInFlight
  ) {
    blockingIntentPumpAgain = true;
    return;
  }
  // A recorded user choice wins over a daemon write that may since have
  // changed storage. A later storage event can supersede `pending`; the single
  // in-flight rule then rebases that newest choice after the reply.
  const enabled = pending ?? storedEnabled;
  const intent = blockingIntents.prepare(observed, enabled);
  if (!intent) return;
  if (
    !send({
      v: PROTOCOL_VERSION,
      type: 'blockingStateUpdate',
      enabled: intent.enabled,
      baseRevision: intent.baseRevision,
    })
  ) {
    blockingIntents.failInFlight();
  }
}

/** Serialize async reads and permit only one outstanding base revision. New
 * settings events request another drain instead of racing a second update. */
function reportLocalBlockingIntent(): Promise<void> {
  if (blockingIntentPump) {
    blockingIntentPumpAgain = true;
    return blockingIntentPump;
  }
  blockingIntentPump = (async () => {
    try {
      do {
        blockingIntentPumpAgain = false;
        await pumpBlockingIntent();
      } while (blockingIntentPumpAgain);
    } finally {
      blockingIntentPump = null;
    }
  })();
  return blockingIntentPump;
}

function requestBlockingIntentReport(): void {
  void reportLocalBlockingIntent().catch((e) =>
    console.warn('[SmartBlocker] companion blocking update failed:', e),
  );
}

function initializeBlockingIfNeeded(): void {
  if (daemonBlocking !== null || !port || !browserAuthenticated) return;
  requestBlockingIntentReport();
}

async function applyBlockingAuthority(
  incoming: CompanionBlockingState,
  epoch: number,
  activePort: chrome.runtime.Port,
): Promise<void> {
  if (
    !isCurrentBlockingConnection(epoch, activePort) ||
    !shouldAcceptBlockingAuthority(daemonBlocking, incoming)
  ) {
    return;
  }
  daemonBlocking = incoming;
  const resolution = blockingIntents.resolve(incoming);
  if (snapshot?.status) {
    patchSnapshot({ status: { ...snapshot.status, blocking: incoming } });
  }
  if (!resolution.applyToStorage) {
    requestBlockingIntentReport();
    return;
  }
  const enabled = (await getSettings()).enabled;
  // A newer status, local event, disconnect, or reconnect may have arrived
  // while storage was read. No continuation from the old epoch has authority.
  if (!isCurrentBlockingConnection(epoch, activePort) || daemonBlocking !== incoming) return;
  const pending = blockingIntents.pendingLocalValue;
  if (pending !== null && pending !== incoming.enabled) {
    requestBlockingIntentReport();
    return;
  }
  if (
    enabled !== incoming.enabled &&
    resolution.resolvedInFlight &&
    enabled !== lastCompanionStoredEnabled
  ) {
    // The response resolved an older request and storage contains a value
    // other than our own last completed write. Preserve that newer local
    // choice instead of mistaking an older daemon write for a user decision.
    blockingIntents.noteLocal(enabled);
    requestBlockingIntentReport();
    return;
  }
  if (enabled !== incoming.enabled) {
    const echoId = `${epoch}:${++blockingApplySequence}`;
    blockingEchoIds.add(echoId);
    try {
      await setCompanionBlockingEnabled(incoming.enabled, echoId);
      lastCompanionStoredEnabled = incoming.enabled;
    } catch (e) {
      // A rejected write cannot produce an echo. A successful write's receipt
      // remains recognized even if its event arrives after this promise or a
      // disconnect/reconnect boundary.
      blockingEchoIds.delete(echoId);
      if (isCurrentBlockingConnection(epoch, activePort)) {
        // Defensive race handling: a lock landing between reads also forbids a
        // disable locally. Capture the value, then revalidate EVERY authority
        // and ledger precondition: the read itself can span a user write,
        // newer daemon state, or a disconnect/reconnect.
        console.warn('[SmartBlocker] companion blocking state was not applied:', e);
        const storedEnabled = (await getSettings()).enabled;
        if (
          isCurrentBlockingConnection(epoch, activePort) &&
          daemonBlocking === incoming &&
          blockingIntents.pendingLocalValue === null
        ) {
          blockingIntents.noteLocal(storedEnabled);
        }
      }
    }
  }
  if (!isCurrentBlockingConnection(epoch, activePort) || daemonBlocking !== incoming) return;
  // User writes that occurred during the application were recorded by their
  // lack of our receipt. Clear only a choice equal to this authority; a newer
  // opposite choice remains queued and is rebased against this revision.
  blockingIntents.resolve(incoming);
  requestBlockingIntentReport();
}

/** Exactly one authority application writes settings at a time. Every queued
 * continuation is bound to both its originating port and connection epoch, so
 * an old daemon cannot cross a disconnect and outrank a restarted daemon. */
function queueBlockingAuthority(
  incoming: CompanionBlockingState,
  epoch: number,
  activePort: chrome.runtime.Port,
): void {
  if (!isCurrentBlockingConnection(epoch, activePort)) return;
  blockingAuthorityQueue = blockingAuthorityQueue
    .then(() => applyBlockingAuthority(incoming, epoch, activePort))
    .catch((e) => console.warn('[SmartBlocker] companion blocking merge failed:', e));
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
  const activePort = port;
  if (!activePort) return;
  const epoch = blockingConnectionEpoch;
  markConnected();
  if (raw === null || typeof raw !== 'object') return;
  const msg = raw as {
    type?: unknown;
    lockState?: unknown;
    status?: unknown;
    running?: unknown;
    blocking?: unknown;
    ok?: unknown;
    message?: unknown;
  };
  if (msg.type === 'lockStateSync') {
    // Merge-only; lock-enforcer.ts picks up the storage change. A change here
    // re-broadcasts via our storage.onChanged listener; the companion's merge
    // of its own echo is a no-op, so the exchange converges.
    void mergeRemoteLockState(msg.lockState).catch((e) =>
      console.warn('[SmartBlocker] companion lock merge failed:', e),
    );
  } else if (msg.type === 'commandResult') {
    if (pendingPartnerCommand?.epoch === epoch) {
      clearTimeout(pendingPartnerCommand.timer);
      const call = pendingPartnerCommand;
      pendingPartnerCommand = null;
      const status = msg.status as PartnerCommandResponse['status'];
      if (!browserAuthenticated || !status) {
        call.reject(new Error('The companion returned an invalid partner result.'));
      } else {
        // Command responses and status broadcasts must not make the initiator
        // weaker than its own UI. Arm/release reaches merged browser storage
        // BEFORE this promise resolves, not merely companionSnapshot.
        void mergeRemoteLockState(status.lockState).then(() => {
          if (!isCurrentBlockingConnection(epoch, activePort) || !browserAuthenticated) {
            call.reject(new Error('The partner result crossed a retired authority epoch.'));
            return;
          }
          patchSnapshot({ status });
          call.resolve({
            ok: msg.ok === true,
            message: typeof msg.message === 'string' ? msg.message : '',
            status,
          });
        }).catch((error) => call.reject(error));
      }
    }
  } else if (msg.type === 'blockingStateSync') {
    const incoming = parseCompanionBlockingState(msg.blocking);
    if (incoming) queueBlockingAuthority(incoming, epoch, activePort);
  } else if (msg.type === 'allowanceStateSync' || msg.type === 'allowanceCommandResult') {
    if (browserAuthenticated) allowanceBridge.onMessage(msg, epoch);
  } else if (msg.type === 'error') {
    // Errors carry no new base revision. Drop the send slot so a later status
    // or genuine settings event can retry, but never spin on an immediate
    // replay of a refused/failed update.
    blockingIntents.failInFlight();
  } else if (msg.type === 'companionStatus') {
    const status = msg.status;
    if (status === null || typeof status !== 'object') return;
    // running === false = the nm-host relay is up but the daemon is not —
    // surface as 'disconnected' (options page: "installed but not running";
    // it distinguishes that from never-installed via the cached status).
    const running = msg.running !== false;
    const typedStatus = status as CompanionStatus;
    let acceptedAuthority: CompanionBlockingState | null = null;
    if (!running) {
      // The relay has no authority while the daemon is gone. Reset revision
      // memory so a restarted daemon can re-establish its persisted state.
      resetBlockingConnection();
    } else {
      // `extensionLoss` exists only in the daemon's authenticated,
      // recipient-specific replies. The redacted accept greeting may arrive
      // while pairing-token storage is still pending; it must not trigger an
      // initialization update before hello has authenticated this port.
      if (typedStatus.extensionLoss !== undefined) browserAuthenticated = true;
      if (typedStatus.blocking === undefined) {
        // Both a fresh daemon and an older daemon omit this additive v2 field.
        // Offering an update is safe: an older daemon silently ignores its type.
        daemonBlocking = null;
        initializeBlockingIfNeeded();
      } else {
        const incoming = parseCompanionBlockingState(typedStatus.blocking);
        if (incoming && shouldAcceptBlockingAuthority(daemonBlocking, incoming)) {
          acceptedAuthority = incoming;
        }
      }
    }
    const statusForSnapshot =
      typedStatus.blocking !== undefined && acceptedAuthority === null && daemonBlocking
        ? { ...typedStatus, blocking: daemonBlocking }
        : typedStatus;
    patchSnapshot({
      status: statusForSnapshot,
      state: running ? 'connected' : 'disconnected',
      // The relay's synthetic running:false payload is not enforcement
      // authority, and an absent field from an older daemon means unknown.
      extensionLoss: running
        ? observeExtensionGrace(typedStatus.extensionLoss, Date.now())
        : null,
    });
    if (running && browserAuthenticated) {
      allowanceBridge.onStatus(typedStatus.allowance, epoch);
    }
    // Lock state lands first: if this status also carries ordinary blocking,
    // the local settings guard sees the same lock before applying that value.
    void mergeRemoteLockState(typedStatus.lockState)
      .then(() => {
        if (
          acceptedAuthority &&
          isCurrentBlockingConnection(epoch, activePort)
        ) {
          queueBlockingAuthority(acceptedAuthority, epoch, activePort);
        }
      })
      .catch((e) => console.warn('[SmartBlocker] companion status merge failed:', e));
  }
}

function onPortDisconnect(p: chrome.runtime.Port): void {
  if (port !== p) return;
  // Chrome reports the reason via runtime.lastError, Firefox via port.error.
  const err =
    api.runtime.lastError?.message ??
    (p as { error?: { message?: string } }).error?.message ??
    '';
  port = null;
  confirmed = false;
  resetBlockingConnection();
  clearTimeout(confirmTimer);
  clearInterval(heartbeatTimer);

  // Chrome: "Specified native messaging host not found." / Firefox: "No such
  // native application ...". Not an error — most installs have no companion.
  if (/not found|no such native application/i.test(err)) {
    if (!loggedNotInstalled) {
      loggedNotInstalled = true;
      console.info('[SmartBlocker] desktop companion not installed; hard enforcement unavailable');
    }
    patchSnapshot({ state: 'not-installed', extensionLoss: null });
    void api.alarms.clear(KEEPALIVE_ALARM);
    return; // no backoff loop or doomed-port restart cycle — daily retry only
  }

  // Companion crashed or is restarting (e.g. mid-update): backoff reconnect.
  // Keepalive stays armed (alarms persist across SW restarts) so a reaped SW
  // still comes back to retry — create, not just rely on markConnected's.
  // A disconnected extension cannot observe its own live daemon countdown.
  // Drop the numeric observation; the notice retains its honest unknown path.
  patchSnapshot({ state: 'disconnected', extensionLoss: null });
  void api.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

/** Get-or-create the per-profile pairing token. */
async function pairingToken(): Promise<string> {
  const stored = await api.storage.local.get(PAIRING_KEY);
  const existing = stored[PAIRING_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const token = crypto.randomUUID();
  await api.storage.local.set({ [PAIRING_KEY]: token });
  return token;
}

function connect(): void {
  if (port) return;
  clearTimeout(reconnectTimer);
  if (snapshot?.state === 'not-installed') {
    // Still probe the real native host on every intended retry, but keep an
    // already-established missing-host verdict quiet. Persisting a transient
    // connecting state here would immediately change it back on failure and
    // emit a storage-wake cycle on every Firefox event-page restart.
    patchSnapshot({ extensionLoss: null });
  } else {
    patchSnapshot({ state: 'connecting', extensionLoss: null });
  }
  let p: chrome.runtime.Port;
  try {
    p = api.runtime.connectNative(NM_HOST_NAME);
  } catch {
    // Some platforms throw instead of returning a doomed port.
    patchSnapshot({ state: 'not-installed', extensionLoss: null });
    void api.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  port = p;
  p.onMessage.addListener((message) => {
    // A queued callback from a retired port must not capture the NEW epoch.
    if (port === p) onPortMessage(message);
  });
  p.onDisconnect.addListener(() => onPortDisconnect(p));
  confirmTimer = setTimeout(markConnected, CONNECT_CONFIRM_MS);

  void pairingToken()
    .then((pairing) => {
      if (port !== p) return;
      send({
        v: PROTOCOL_VERSION,
        type: 'hello',
        extVersion: api.runtime.getManifest().version,
        browser: IS_FIREFOX ? 'firefox' : navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome',
        extensionId: api.runtime.id,
        pairing,
      });
      // Only after hello auths the connection: the daemon strips password
      // fields from unauthenticated syncs.
      return getLockState();
    })
    .then((lockState) => {
      if (port === p && lockState) {
        send({ v: PROTOCOL_VERSION, type: 'lockStateSync', lockState });
      }
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

  // Ordinary blocking is daemon-owned whenever a live authority exists. A
  // genuine enabled change is remembered independently of daemon-applied
  // storage echoes, so rapid off→on→off sequences cannot lose their last value.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Consume each unique receipt exactly once, even if its settings value did
    // not change or the port disappeared before delivery. Undelivered receipts
    // remain recognized across epochs, but delivered ones cannot accumulate.
    const echoId = changes[COMPANION_BLOCKING_ECHO_KEY]?.newValue;
    if (typeof echoId === 'string' && blockingEchoIds.delete(echoId)) return;
    const change = changes['settings'];
    if (!change || !port) return;
    const oldEnabled = (change.oldValue as { enabled?: boolean } | undefined)?.enabled ?? true;
    const newEnabled = (change.newValue as { enabled?: boolean } | undefined)?.enabled ?? true;
    if (oldEnabled === newEnabled) return;
    blockingIntents.noteLocal(newEnabled);
    requestBlockingIntentReport();
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
    // An already-established missing-host result has no reason to create
    // another doomed native port on every event-page restart: its disconnect
    // event is itself a primed wake source. Scheduled retries still call
    // connect(), and connected/disconnected states retain normal recovery.
    if (snapshot?.state !== 'not-installed') connect();
  })().catch((e) => console.warn('[SmartBlocker] companion bridge init failed:', e));
}
