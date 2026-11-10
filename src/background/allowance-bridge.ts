import { PROTOCOL_VERSION } from '../shared/companion-protocol';
import {
  allowanceStateIdentity,
  normalizeAllowanceAuthorityState,
  type AllowanceAuthorityState,
  type AllowanceCommand,
} from '../shared/allowance-state';
import type { AllowanceResponse } from '../shared/messages';
import {
  getLocalAllowanceAuthority,
  reconcileLocalAllowanceSnapshot,
} from '../shared/allowance-store';

interface Connection {
  epoch: number;
  send: (message: unknown) => boolean;
}

interface Hooks {
  getConnection: () => Connection | null;
  onAuthority: (state: AllowanceAuthorityState) => void;
  /** Test/evidence control for bounded bootstrap negotiation; real value is 5s. */
  initializationTimeoutMs?: number;
}

interface Pending {
  epoch: number;
  resolve: (response: AllowanceResponse) => void;
  reject: (error: Error) => void;
}

/** Native-port-independent command/authority pump. The outer companion supplies
 * the current authenticated port/epoch and mirrors snapshot updates. */
export function createAllowanceBridge(hooks: Hooks) {
  let authority: AllowanceAuthorityState | null | undefined;
  let authorityEpoch: number | null = null;
  let bootstrapAttempted = false;
  let fallbackAfterInitializationTimeout = false;
  // A daemon snapshot that was accepted in memory but whose local mirror write
  // failed. It must be flushed before any fallback command reads/extends local
  // state, or a later reconnect would trade away a committed daemon command.
  let pendingMirror: AllowanceAuthorityState | null = null;
  // Command settlement and snapshot persistence have separate queues: an ack
  // must be able to finish its write so that the waiting command can settle.
  let commandQueue: Promise<void> = Promise.resolve();
  let writeQueue: Promise<void> = Promise.resolve();
  const initializationWaiters: {
    epoch: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (state: AllowanceAuthorityState | null) => void;
  }[] = [];
  const pending = new Map<string, Pending>();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const attempt = writeQueue.then(task);
    writeQueue = attempt.then(
      () => undefined,
      (error) => console.warn('[SmartBlocker] allowance bridge failed:', error),
    );
    return attempt;
  }

  function latchMirror(state: AllowanceAuthorityState): void {
    // A stale status reply must never replace a higher committed snapshot that
    // is still waiting to be persisted.
    if (!pendingMirror || state.revision >= pendingMirror.revision) {
      pendingMirror = state;
    }
  }

  function flushMirror(): Promise<void> {
    const pendingState = pendingMirror;
    if (!pendingState) return Promise.resolve();
    const pendingIdentity = allowanceStateIdentity(pendingState);
    return reconcileLocalAllowanceSnapshot(pendingState)
      .then((result) => {
        if (allowanceStateIdentity(pendingMirror) !== pendingIdentity) return;
        // `accepted` persisted it; `local-newer`/`divergent` means the
        // durable local snapshot already superseded it. Only a failed write
        // keeps the mirror pending for the next fallback attempt.
        if (!result.error) pendingMirror = null;
      })
      .catch((error) => {
        console.warn('[SmartBlocker] allowance mirror recovery failed:', error);
      });
  }

  function settleInitialization(state: AllowanceAuthorityState | null): void {
    for (const waiter of initializationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(state);
    }
  }

  function reset() {
    authority = undefined;
    authorityEpoch = null;
    bootstrapAttempted = false;
    fallbackAfterInitializationTimeout = false;
    settleInitialization(null);
    // Keep a failed mirror across the disconnect and try it once before this
    // connection is allowed to fall back.
    void flushMirror().catch((error) => {
      console.warn('[SmartBlocker] allowance mirror recovery failed:', error);
    });
    const error = new Error('The desktop allowance authority disconnected.');
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }

  function bootstrap() {
    if (bootstrapAttempted || fallbackAfterInitializationTimeout) return;
    bootstrapAttempted = true;
    const connection = hooks.getConnection();
    if (!connection) return;
    const epoch = connection.epoch;
    enqueue(async () => {
      const local = await getLocalAllowanceAuthority();
      const current = hooks.getConnection();
      if (!current || current.epoch !== epoch || authority !== null) return;
      // Older v2 daemons silently ignore this unknown type. New daemons accept
      // it only while their own state has never been initialized.
      current.send({ v: PROTOCOL_VERSION, type: 'allowanceBootstrap', allowance: local });
    });
  }

  function observe(
    incoming: AllowanceAuthorityState,
    epoch: number,
    completion?: { call: Pending; ok: boolean; reason?: string; duplicate: true | undefined },
  ) {
    enqueue(async () => {
      try {
        // A retired connection or a deliberate fallback still receives
        // daemon-committed snapshots. Mirror them best-effort on the shared
        // writer queue: a newer fallback snapshot wins, but a committed
        // command must not disappear merely because the reply arrived late.
        const liveNow = hooks.getConnection();
        if (fallbackAfterInitializationTimeout || !liveNow || liveNow.epoch !== epoch) {
          let mirrorError: Error | null = null;
          try {
            const mirrored = await reconcileLocalAllowanceSnapshot(incoming);
            if (mirrored.error) {
              latchMirror(incoming);
              mirrorError = mirrored.error;
            }
          } catch (error) {
            latchMirror(incoming);
            mirrorError = error instanceof Error ? error : new Error(String(error));
            console.warn('[SmartBlocker] late allowance snapshot was not mirrored:', error);
          }
          if (fallbackAfterInitializationTimeout) {
            if (mirrorError) {
              // `ok:true` must mean the acknowledged state is durable.
              completion?.call.reject(mirrorError);
              return;
            }
            completion?.call.resolve({
              ok: completion.ok,
              source: 'fallback',
              state: current() ?? (await getLocalAllowanceAuthority()),
              reason: completion.reason,
              duplicate: completion.duplicate,
            });
          } else {
            completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
          }
          return;
        }
        const reconciliation = await reconcileLocalAllowanceSnapshot(incoming, () => {
          const live = hooks.getConnection();
          return Boolean(live && live.epoch === epoch) && !fallbackAfterInitializationTimeout;
        });
        if (reconciliation.decision === 'retired') {
          // The connection retired while this snapshot was parked in its local
          // read. Mirror it best-effort anyway: a daemon commit must not
          // disappear just because its reply lost the epoch race. A newer
          // fallback snapshot wins inside reconcile, so this cannot overwrite
          // a later browser decision.
          try {
            const mirrored = await reconcileLocalAllowanceSnapshot(incoming);
            if (mirrored.error) latchMirror(incoming);
          } catch (error) {
            latchMirror(incoming);
            console.warn('[SmartBlocker] retired allowance snapshot was not mirrored:', error);
          }
          completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
          return;
        }
        if (fallbackAfterInitializationTimeout) {
          // This connection deliberately chose fallback after the bounded wait.
          // The queued mirror above preserved the daemon snapshot only when no
          // newer fallback command won, so it cannot replace later choices.
          if (reconciliation.error) {
            latchMirror(incoming);
            completion?.call.reject(reconciliation.error);
            return;
          }
          completion?.call.resolve({
            ok: completion.ok,
            source: 'fallback',
            state: reconciliation.state,
            reason: completion.reason,
            duplicate: completion.duplicate,
          });
          return;
        }
        const live = hooks.getConnection();
        if (!live || live.epoch !== epoch) {
          if (reconciliation.error) latchMirror(incoming);
          completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
          return;
        }
        if (reconciliation.decision !== 'accepted') {
          // The durable local snapshot is newer or holds a transition the
          // daemon did not include. Offer it and stay in reconciliation;
          // `current()` must not claim a revision the daemon has not adopted.
          if (!pendingMirror || incoming.revision >= pendingMirror.revision) pendingMirror = null;
          if (reconciliation.error) {
            completion?.call.reject(reconciliation.error);
            authority = null;
            authorityEpoch = null;
            return;
          }
          const sent = live.send({
            v: PROTOCOL_VERSION,
            type: 'allowanceBootstrap',
            allowance: reconciliation.state,
          });
          completion?.call.reject(new Error(
            sent
              ? 'Local allowance history is not included in the daemon snapshot; reconcile and retry.'
              : 'Local allowance history conflicts with the daemon and could not be offered.',
          ));
          authority = null;
          authorityEpoch = null;
          return;
        }
        if (reconciliation.error) {
          // The daemon accepted the snapshot, but the local mirror did not.
          // Latch it for the next authenticated base revision and keep it
          // pending so a fallback command flushes it first.
          latchMirror(incoming);
          if (!authority || authorityEpoch !== epoch || incoming.revision >= authority.revision) {
            authority = incoming;
            authorityEpoch = epoch;
            settleInitialization(incoming);
            hooks.onAuthority(incoming);
          }
          completion?.call.reject(reconciliation.error);
          return;
        }
        if (!pendingMirror || incoming.revision >= pendingMirror.revision) pendingMirror = null;
        if (!authority || authorityEpoch !== epoch || incoming.revision >= authority.revision) {
          authority = incoming;
          authorityEpoch = epoch;
          settleInitialization(incoming);
          hooks.onAuthority(incoming);
        }
        completion?.call.resolve({
          ok: completion.ok,
          source: authority ? 'daemon' : 'fallback',
          state: current() ?? reconciliation.state,
          reason: completion.reason,
          duplicate: completion.duplicate,
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        completion?.call.reject(failure);
        throw failure;
      }
    });
  }

  function onMessage(raw: unknown, epoch: number): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as {
      type?: unknown;
      allowance?: unknown;
      ok?: unknown;
      operationId?: unknown;
      reason?: unknown;
      duplicate?: unknown;
    };
    const completion = message.type === 'allowanceCommandResult' && typeof message.operationId === 'string'
      ? pending.get(message.operationId)
      : undefined;
    if (completion && completion.epoch !== epoch) return;
    if (completion) pending.delete(message.operationId as string);
    const next = normalizeAllowanceAuthorityState(message.allowance);
    if (message.type === 'allowanceStateSync' || message.type === 'allowanceCommandResult') {
      if (next) {
        observe(
          next,
          epoch,
          completion
            ? {
                call: completion,
                ok: message.ok === true,
                reason: typeof message.reason === 'string' ? message.reason : undefined,
                duplicate: message.duplicate === true || undefined,
              }
            : undefined,
        );
      } else {
        completion?.reject(new Error('The daemon returned an invalid allowance snapshot.'));
      }
    }
  }

  function onStatus(allowance: unknown, epoch: number): void {
    if (fallbackAfterInitializationTimeout) return;
    if (allowance === undefined) {
      authority = null;
      authorityEpoch = null;
      bootstrap();
      return;
    }
    const next = normalizeAllowanceAuthorityState(allowance);
    if (next) observe(next, epoch);
  }

  function current(): AllowanceAuthorityState | null {
    const connection = hooks.getConnection();
    if (!authority || !connection || authorityEpoch !== connection.epoch) return null;
    return normalizeAllowanceAuthorityState(authority);
  }

  function initializing(): boolean {
    return current() === null && bootstrapAttempted && !fallbackAfterInitializationTimeout;
  }

  async function waitForInitialization(): Promise<AllowanceAuthorityState | null> {
    if (fallbackAfterInitializationTimeout) return null;
    const live = current();
    if (live) return live;
    const connection = hooks.getConnection();
    if (!connection) return null;
    return new Promise((resolve) => {
      const epoch = connection.epoch;
      const timer = setTimeout(() => {
        const index = initializationWaiters.findIndex((waiter) => waiter.epoch === epoch);
        if (index >= 0) initializationWaiters.splice(index, 1);
        // Fallback is connection-scoped. Ignore a late authority reply rather
        // than letting it overwrite commands written after this timeout.
        authority = undefined;
        authorityEpoch = null;
        fallbackAfterInitializationTimeout = true;
        resolve(null);
      }, hooks.initializationTimeoutMs ?? 5_000);
      initializationWaiters.push({
        epoch,
        timer,
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
      });
    });
  }

  async function submit(command: AllowanceCommand): Promise<AllowanceResponse | null> {
    const attempt = commandQueue.then(async (): Promise<AllowanceResponse | null> => {
      const observed = await waitForInitialization();
      const connection = hooks.getConnection();
      if (
        !connection ||
        !observed ||
        authorityEpoch !== connection.epoch
      ) {
        // Persist any accepted-but-unmirrored daemon snapshot before a local
        // fallback command is allowed to extend a stale base.
        await flushMirror();
        return null;
      }
      const epoch = connection.epoch;
      return new Promise<AllowanceResponse>((resolve, reject) => {
        pending.set(command.operationId, { epoch, resolve, reject });
        if (!connection.send({
          v: PROTOCOL_VERSION,
          type: 'allowanceCommand',
          command,
          baseRevision: observed.revision,
        })) {
          pending.delete(command.operationId);
          reject(new Error('Could not send the allowance command to the desktop daemon.'));
        }
      });
    });
    // Crucially, the next command waits for the result + persistence of this
    // one, not just its send. It can never reuse an unsettled base revision.
    commandQueue = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  return { current, initializing, onMessage, onStatus, reset, submit, flushMirror };
}
