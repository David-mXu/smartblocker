// Extension-only item10 authority. The background serializes this writer;
// daemon-connected callers use the mirrored Rust transitions instead.
import { api } from './api';
import { getLockStatus } from './lock';
import {
  allowanceStateHasLocalOnlyReceipts,
  allowanceStateIdentity,
  applyAllowanceCommand,
  cloneAllowanceAuthorityState,
  commitAllowanceCommandRevision,
  emptyAllowanceAuthorityState,
  normalizeAllowanceAuthorityState,
  type AllowanceAuthorityState,
  type AllowanceCommand,
  type AllowanceCommandResult,
} from './allowance-state';

export const ALLOWANCE_AUTHORITY_STORAGE_KEY = 'allowanceAuthority';

let localCommandQueue: Promise<void> = Promise.resolve();

/** Serialize a read/decide/write with ordinary fallback commands. Without
 * this, a bridge mirror and a fallback writer can both read revision R and
 * then land their writes in either order, losing the later command. */
function enqueueLocal<T>(task: () => Promise<T>): Promise<T> {
  const attempt = localCommandQueue.then(task);
  localCommandQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

export interface AllowanceSnapshotReconciliation {
  /** `accepted`: the daemon snapshot is now durable (or already identical).
   *  `local-newer`/`divergent`: the durable local snapshot wins and must be
   *  offered to the daemon. `retired`: the caller's connection changed before
   *  the write, so nothing was persisted. */
  decision: 'accepted' | 'local-newer' | 'divergent' | 'retired';
  state: AllowanceAuthorityState;
  /** Persistence failed; `state` is the pre-write durable value. */
  error?: Error;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function getLocalAllowanceAuthority(): Promise<AllowanceAuthorityState> {
  const stored = await api.storage.local.get(ALLOWANCE_AUTHORITY_STORAGE_KEY);
  return (
    normalizeAllowanceAuthorityState(stored[ALLOWANCE_AUTHORITY_STORAGE_KEY]) ??
    emptyAllowanceAuthorityState()
  );
}

/** Used only when the daemon applies its authoritative snapshot. Connection
 * epoch checks and old-value preservation belong to the bridge, not storage. */
export async function writeLocalAllowanceAuthority(state: AllowanceAuthorityState): Promise<void> {
  const clean = normalizeAllowanceAuthorityState(state);
  if (!clean) throw new Error('Invalid allowance authority snapshot.');
  await api.storage.local.set({ [ALLOWANCE_AUTHORITY_STORAGE_KEY]: cloneAllowanceAuthorityState(clean) });
}

/** Atomically fold a daemon snapshot into durable fallback state. Runs on the
 * same queue as fallback commands so the read/decide/write cannot interleave
 * with a command that starts after the bridge's first observation.
 *
 * The daemon wins only when it leads and the browser cannot prove a local-only
 * transition. Otherwise the local history is preserved and promoted above
 * both revisions so a strictly-greater recovery bootstrap can carry it. */
export async function reconcileLocalAllowanceSnapshot(
  incoming: AllowanceAuthorityState,
  stillCurrent?: () => boolean,
): Promise<AllowanceSnapshotReconciliation> {
  const clean = normalizeAllowanceAuthorityState(incoming);
  if (!clean) throw new Error('Invalid allowance authority snapshot.');
  const cleanIdentity = allowanceStateIdentity(clean);
  return enqueueLocal(async (): Promise<AllowanceSnapshotReconciliation> => {
    const local = await getLocalAllowanceAuthority();
    if (stillCurrent && !stillCurrent()) {
      return { decision: 'retired', state: local };
    }
    if (local.revision > clean.revision) {
      return { decision: 'local-newer', state: local };
    }
    if (local.revision === clean.revision && allowanceStateIdentity(local) === cleanIdentity) {
      return { decision: 'accepted', state: local };
    }
    const divergent =
      local.revision === clean.revision ||
      allowanceStateHasLocalOnlyReceipts(local, clean);
    if (divergent) {
      const target = Math.max(local.revision + 1, clean.revision + 1);
      if (local.revision >= Number.MAX_SAFE_INTEGER || target > Number.MAX_SAFE_INTEGER) {
        return { decision: 'divergent', state: local };
      }
      const promoted = cloneAllowanceAuthorityState(local);
      promoted.revision = target;
      try {
        await writeLocalAllowanceAuthority(promoted);
        return { decision: 'divergent', state: promoted };
      } catch (error) {
        return { decision: 'divergent', state: local, error: asError(error) };
      }
    }
    try {
      await writeLocalAllowanceAuthority(clean);
      return { decision: 'accepted', state: clean };
    } catch (error) {
      return { decision: 'accepted', state: clean, error: asError(error) };
    }
  });
}

export async function submitLocalAllowanceCommand(
  command: AllowanceCommand,
): Promise<AllowanceCommandResult> {
  return enqueueLocal(async (): Promise<AllowanceCommandResult> => {
    const current = await getLocalAllowanceAuthority();
    const applied = applyAllowanceCommand(current, command, current.revision);
    if (!applied.ok || applied.duplicate) return applied;
    if (command.kind === 'configure' && (await getLockStatus()).settingsLocked) {
      throw new Error('Allowance configuration cannot be changed while SmartBlocker is locked.');
    }
    const committed = commitAllowanceCommandRevision(
      applied.state,
      current.revision + 1,
      command,
    );
    await writeLocalAllowanceAuthority(committed);
    return { ...applied, state: committed };
  });
}

/** A divergent snapshot means this browser holds transitions the daemon did not
 * include. Keep the durable local history and promote above both revisions so
 * the daemon (which accepts strictly greater recovery revisions) adopts it.
 * The bump is serialized with ordinary fallback commands, and is skipped if
 * another command changed the expected snapshot first. */
export async function promoteLocalAllowanceAuthorityForConflict(
  expected: AllowanceAuthorityState,
  minimumRevision = 0,
): Promise<AllowanceAuthorityState> {
  const expectedIdentity = allowanceStateIdentity(expected);
  return enqueueLocal(async (): Promise<AllowanceAuthorityState> => {
    const current = await getLocalAllowanceAuthority();
    if (allowanceStateIdentity(current) !== expectedIdentity) return current;
    const target = Math.max(current.revision + 1, minimumRevision + 1);
    if (current.revision >= Number.MAX_SAFE_INTEGER || target > Number.MAX_SAFE_INTEGER) {
      return current;
    }
    const promoted = cloneAllowanceAuthorityState(current);
    promoted.revision = target;
    await writeLocalAllowanceAuthority(promoted);
    return promoted;
  });
}

/** Local calendar day for pure local-midnight pool rollover. This is a date
 * key only; scheduler timestamp math stays in their respective modules. */
export function allowanceLocalDayKey(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}
