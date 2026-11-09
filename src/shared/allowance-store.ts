// Extension-only item10 authority. The background serializes this writer;
// daemon-connected callers use the mirrored Rust transitions instead.
import { api } from './api';
import { getLockStatus } from './lock';
import {
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

export async function submitLocalAllowanceCommand(
  command: AllowanceCommand,
): Promise<AllowanceCommandResult> {
  const attempt = localCommandQueue.then(async (): Promise<AllowanceCommandResult> => {
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
  // A persistence/lock error belongs to this caller only; it must not poison
  // the single-flight chain for later independent commands.
  localCommandQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

/** A same-revision conflict means both peers applied different commands. The
 * browser keeps its durable offline transition and promotes only the snapshot
 * revision so the daemon (which accepts strictly greater recovery revisions)
 * adopts it. The bump is serialized with ordinary fallback commands, and is
 * skipped if another command changed the expected snapshot first. */
export async function promoteLocalAllowanceAuthorityForConflict(
  expected: AllowanceAuthorityState,
): Promise<AllowanceAuthorityState> {
  const expectedIdentity = allowanceStateIdentity(expected);
  const attempt = localCommandQueue.then(async (): Promise<AllowanceAuthorityState> => {
    const current = await getLocalAllowanceAuthority();
    if (allowanceStateIdentity(current) !== expectedIdentity) return current;
    if (current.revision >= Number.MAX_SAFE_INTEGER) return current;
    const promoted = cloneAllowanceAuthorityState(current);
    promoted.revision = current.revision + 1;
    await writeLocalAllowanceAuthority(promoted);
    return promoted;
  });
  localCommandQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

/** Local calendar day for pure local-midnight pool rollover. This is a date
 * key only; scheduler timestamp math stays in their respective modules. */
export function allowanceLocalDayKey(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, '0');
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}
