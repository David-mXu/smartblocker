import { PROTOCOL_VERSION } from '../shared/companion-protocol';
import {
  allowanceStateHasLocalOnlyReceipts,
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
  let bootstrapAttempted = false;
  let fallbackAfterInitializationTimeout = false;
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

  function enqueue(task: () => Promise<void>): void {
    writeQueue = writeQueue.then(task).catch((error) => console.warn('[SmartBlocker] allowance bridge failed:', error));
  }

  function settleInitialization(state: AllowanceAuthorityState | null): void {
    for (const waiter of initializationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(state);
    }
  }

  function reset() {
    authority = undefined;
    bootstrapAttempted = false;
    fallbackAfterInitializationTimeout = false;
    settleInitialization(null);
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
      const live = hooks.getConnection();
      if (!live || live.epoch !== epoch) {
        completion?.call.reject(new Error('The allowance authority disconnected before persistence.'));
        return;
      }
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
      if (authority && incoming.revision < authority.revision) {
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
        return;
      }
      if (
        local.revision === incoming.revision &&
        allowanceStateHasLocalOnlyReceipts(local, incoming)
      ) {
        // Equal revision is not proof of equal history: both peers may have
        // applied different commands. Preserve the browser's durable offline
        // transition and promote only its revision so the daemon adopts it.
        const promoted = await promoteLocalAllowanceAuthorityForConflict(local);
        const sent = live.send({
          v: PROTOCOL_VERSION,
          type: 'allowanceBootstrap',
          allowance: promoted,
        });
        completion?.call.reject(new Error(
          sent
            ? 'Local allowance history conflicts with the daemon at the same revision; reconcile and retry.'
            : 'Local allowance history conflicts with the daemon and could not be offered.',
        ));
        authority = null;
        return;
      }
      // Reconciliation is complete: this snapshot does not erase a newer or
      // divergent local transition. Latch it before the mirror write so a
      // failed mirror cannot make the next authenticated command reuse an old
      // base revision; the command itself still waits for persistence below.
      if (!authority || incoming.revision >= authority.revision) {
        authority = incoming;
        settleInitialization(incoming);
        hooks.onAuthority(incoming);
      }
      try {
        await writeLocalAllowanceAuthority(incoming);
      } catch (error) {
        completion?.call.reject(error instanceof Error ? error : new Error(String(error)));
        console.warn('[SmartBlocker] authority snapshot was not persisted:', error);
        return;
      }
      completion?.call.resolve({
        ok: completion.ok,
        source: authority ? 'daemon' : 'fallback',
        state: current() ?? local,
        reason: completion.reason,
        duplicate: completion.duplicate,
      });
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
      bootstrap();
      return;
    }
    const next = normalizeAllowanceAuthorityState(allowance);
    if (next) observe(next, epoch);
  }

  function current(): AllowanceAuthorityState | null {
    return authority ? normalizeAllowanceAuthorityState(authority) : null;
  }

  function initializing(): boolean {
    return authority === null && bootstrapAttempted && !fallbackAfterInitializationTimeout;
  }

  async function waitForInitialization(): Promise<AllowanceAuthorityState | null> {
    if (fallbackAfterInitializationTimeout) return null;
    if (authority !== null) return authority ?? null;
    if (!hooks.getConnection()) return null;
    return new Promise((resolve) => {
      const epoch = hooks.getConnection()!.epoch;
      const timer = setTimeout(() => {
        const index = initializationWaiters.findIndex((waiter) => waiter.epoch === epoch);
        if (index >= 0) initializationWaiters.splice(index, 1);
        // Fallback is connection-scoped. Ignore a late authority reply rather
        // than letting it overwrite commands written after this timeout.
        authority = undefined;
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
      if (!connection || !observed) return null;
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

  return { current, initializing, onMessage, onStatus, reset, submit };
}
