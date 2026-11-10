import { PROTOCOL_VERSION } from '../shared/companion-protocol';
import {
  allowanceStateHasLocalOnlyReceipts,
  allowanceStateIdentity,
  normalizeAllowanceAuthorityState,
  type AllowanceAuthorityState,
  type AllowanceCommand,
} from '../shared/allowance-state';
import type { AllowanceResponse } from '../shared/messages';
import {
  getLocalAllowanceAuthority,
  promoteLocalAllowanceAuthorityForConflict,
  writeLocalAllowanceAuthority,
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

  function flushMirror(): Promise<void> {
    const pendingState = pendingMirror;
    if (!pendingState) return Promise.resolve();
    const pendingIdentity = allowanceStateIdentity(pendingState);
    return enqueue(async () => {
      const local = await getLocalAllowanceAuthority();
      if (local.revision > pendingState.revision) return;
      if (
        local.revision === pendingState.revision &&
        allowanceStateIdentity(local) !== pendingIdentity &&
        allowanceStateHasLocalOnlyReceipts(local, pendingState)
      ) {
        // A fallback command won the race. Preserve it; reconnect reconciliation
        // will promote the local history instead of silently dropping either.
        return;
      }
      if (allowanceStateIdentity(local) === pendingIdentity) {
        if (allowanceStateIdentity(pendingMirror) === pendingIdentity) pendingMirror = null;
        return;
      }
      await writeLocalAllowanceAuthority(pendingState);
      if (allowanceStateIdentity(pendingMirror) === pendingIdentity) pendingMirror = null;
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
        if (fallbackAfterInitializationTimeout) {
          // This connection deliberately chose fallback after the bounded wait.
          // A late observation must not replace commands written since then.
          completion?.call.resolve({
            ok: completion.ok,
            source: 'fallback',
            state: current() ?? (await getLocalAllowanceAuthority()),
            reason: completion.reason,
            duplicate: completion.duplicate,
          });
          return;
        }
        let live = hooks.getConnection();
        if (!live || live.epoch !== epoch) {
          completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
          return;
        }
        if (authority && authorityEpoch === epoch && incoming.revision < authority.revision) {
          // An in-flight observation can arrive after a newer one was already
          // accepted. It must not roll authority or fallback state backwards.
          completion?.call.resolve({
            ok: completion.ok,
            source: 'daemon',
            state: current() ?? incoming,
            reason: completion.reason,
            duplicate: completion.duplicate,
          });
          return;
        }
        const local = await getLocalAllowanceAuthority();
        if (fallbackAfterInitializationTimeout) {
          completion?.call.resolve({
            ok: completion.ok,
            source: 'fallback',
            state: local,
            reason: completion.reason,
            duplicate: completion.duplicate,
          });
          return;
        }
        live = hooks.getConnection();
        if (!live || live.epoch !== epoch) {
          completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
          return;
        }
        if (local.revision > incoming.revision) {
          // Never roll back fallback commands. Offer the newer durable snapshot
          // and stay in fallback until a real newer/equal authority arrives.
          // An older peer that ignores this additive message cannot erase it.
          const sent = live.send({ v: PROTOCOL_VERSION, type: 'allowanceBootstrap', allowance: local });
          completion?.call.reject(new Error(
            sent
              ? 'Local allowance usage is newer than the daemon; reconcile and retry.'
              : 'Local allowance usage is newer; the daemon could not receive it.',
          ));
          authority = null;
          authorityEpoch = null;
          return;
        }
        const divergent =
          local.revision < incoming.revision
            ? allowanceStateHasLocalOnlyReceipts(local, incoming)
            : local.revision === incoming.revision &&
              allowanceStateIdentity(local) !== allowanceStateIdentity(incoming);
        if (divergent) {
          // Revision equality (or a daemon lead) is not proof that this
          // browser's durable transitions are included. Preserve local history
          // and promote above the daemon so it adopts the complete local
          // snapshot instead of silently erasing offline consumption.
          const promoted = await promoteLocalAllowanceAuthorityForConflict(local, incoming.revision);
          if (fallbackAfterInitializationTimeout) {
            completion?.call.resolve({
              ok: completion.ok,
              source: 'fallback',
              state: promoted,
              reason: completion.reason,
              duplicate: completion.duplicate,
            });
            return;
          }
          live = hooks.getConnection();
          if (!live || live.epoch !== epoch) {
            completion?.call.reject(new Error('The allowance authority disconnected before reconciliation.'));
            return;
          }
          const sent = live.send({
            v: PROTOCOL_VERSION,
            type: 'allowanceBootstrap',
            allowance: promoted,
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
        if (fallbackAfterInitializationTimeout) {
          completion?.call.resolve({
            ok: completion.ok,
            source: 'fallback',
            state: local,
            reason: completion.reason,
            duplicate: completion.duplicate,
          });
          return;
        }
        // Reconciliation is complete: this snapshot does not erase a newer or
        // divergent local transition. Latch it before the mirror write so a
        // failed mirror cannot make the next authenticated command reuse an old
        // base revision; the command itself still waits for persistence below.
        if (!authority || authorityEpoch !== epoch || incoming.revision >= authority.revision) {
          authority = incoming;
          authorityEpoch = epoch;
          settleInitialization(incoming);
          hooks.onAuthority(incoming);
        }
        pendingMirror = incoming;
        try {
          await writeLocalAllowanceAuthority(incoming);
        } catch (error) {
          completion?.call.reject(error instanceof Error ? error : new Error(String(error)));
          console.warn('[SmartBlocker] authority snapshot was not persisted:', error);
          return;
        }
        if (allowanceStateIdentity(pendingMirror) === allowanceStateIdentity(incoming)) {
          pendingMirror = null;
        }
        completion?.call.resolve({
          ok: completion.ok,
          source: authority ? 'daemon' : 'fallback',
          state: current() ?? local,
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
    if (fallbackAfterInitializationTimeout || !raw || typeof raw !== 'object') return;
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
