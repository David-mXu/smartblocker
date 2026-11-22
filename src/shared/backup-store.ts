// Browser-side orchestration for configuration backup/restore. The pure
// schema/merge rules live in backup.ts; this module owns storage.local, the
// settings-lock refusal, and the bounded pre-restore slot.
import { api } from './api';
import {
  BACKUP_MAX_BYTES,
  BACKUP_SCHEMA_VERSION,
  applySchedulesToLockState,
  buildBackup,
  buildBackupPreview,
  mergeBackupState,
  parseBackup,
  replaceBackupState,
  serializeBackup,
  type BackupAppliedState,
  type BackupCurrentState,
  type BackupDocument,
  type BackupIssue,
  type BackupMode,
  type BackupPreview,
  type BackupPreviewCounts,
} from './backup';
import { getLockState, getLockStatus } from './lock';
import { getProfilesState } from './profile-store';
import { PROFILES_STORAGE_KEY } from './profiles';
import { getDefaultSettings } from './settings';

/** One bounded recovery slot, replaced before every restore. The text is the
 *  exact downloadable backup, so a bad import can always be undone. */
export const PRE_RESTORE_STORAGE_KEY = 'backup:preRestore:v1';
export const PRE_RESTORE_VERSION = 1;

export interface PreRestoreSlot {
  version: number;
  savedAt: number;
  mode: BackupMode;
  text: string;
}

export interface PreRestoreInfo {
  savedAt: number;
  mode: BackupMode;
  text: string;
  document: BackupDocument | null;
  errors: BackupIssue[];
  profileCount: number;
  scheduleCount: number;
}

export interface BackupApplyResult {
  mode: BackupMode;
  applied: BackupAppliedState;
  preRestoreSavedAt: number;
  counts: BackupPreviewCounts;
}

export class BackupLockedError extends Error {
  readonly code = 'locked';
  constructor(message: string) {
    super(message);
    this.name = 'BackupLockedError';
  }
}

export class BackupValidationError extends Error {
  readonly code = 'invalid';
  readonly errors: BackupIssue[];
  constructor(errors: BackupIssue[]) {
    super(errors.map((issue) => issue.message).join(' '));
    this.name = 'BackupValidationError';
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestVersion(): string {
  try {
    return api.runtime.getManifest().version ?? '';
  } catch {
    return '';
  }
}

function lockRefusalMessage(status: Awaited<ReturnType<typeof getLockStatus>>): string {
  const until = status.until
    ? ` until ${new Date(status.until).toLocaleString()}`
    : status.reasons.includes('password')
      ? ' until you enter your password'
      : '';
  const forced = status.forceBlocking && status.reasons.includes('schedule')
    ? ' A focus-hours window is forcing blocking right now.'
    : status.forceBlocking && status.reasons.includes('frozen')
      ? ' A focus session is forcing blocking right now.'
      : '';
  return (
    `SmartBlocker is locked${until}. Restore writes settings, profiles and focus hours, ` +
    `so it is refused until the lock ends.${forced}`
  );
}

export async function getBackupCurrentState(): Promise<BackupCurrentState> {
  const [settings, profiles, lockState] = await Promise.all([
    getDefaultSettings(),
    getProfilesState(),
    getLockState(),
  ]);
  return {
    settings,
    profiles,
    schedules: lockState.schedules ?? [],
    schedulesUpdatedAt: lockState.schedulesUpdatedAt ?? 0,
    categorySchedules: lockState.categorySchedules ?? [],
    categorySchedulesUpdatedAt: lockState.categorySchedulesUpdatedAt ?? 0,
    categorySchedulesPresent: lockState.categorySchedules !== undefined,
  };
}

/** Build the exact bytes the Download button writes. */
export async function createBackupText(now = Date.now()): Promise<string> {
  const [settings, profiles, lockState] = await Promise.all([
    getDefaultSettings(),
    getProfilesState(),
    getLockState(),
  ]);
  const document = buildBackup({
    settings,
    profiles,
    lockState,
    exportedAt: new Date(now).toISOString(),
    appVersion: manifestVersion(),
    now,
  });
  const text = serializeBackup(document);
  if (text.length > BACKUP_MAX_BYTES) {
    throw new Error(
      `This configuration is too large to back up (${Math.round(text.length / 1024)} KB; ` +
        `the limit is ${Math.round(BACKUP_MAX_BYTES / 1024)} KB).`,
    );
  }
  return text;
}

function applyOptions(now: number) {
  return {
    now,
    tzOffsetMinutes: -new Date(now).getTimezoneOffset(),
    tzName: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

export type BackupPreviewResult =
  | { ok: true; preview: BackupPreview }
  | { ok: false; errors: BackupIssue[] };

export async function previewBackupText(
  text: string,
  mode: BackupMode,
  now = Date.now(),
): Promise<BackupPreviewResult> {
  const parsed = parseBackup(text, now);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const current = await getBackupCurrentState();
  const preview = buildBackupPreview(current, parsed.document, mode, applyOptions(now));
  return {
    ok: true,
    preview: {
      ...preview,
      warnings: [...parsed.warnings, ...preview.warnings],
    },
  };
}

async function assertUnlocked(now: number): Promise<void> {
  const status = await getLockStatus(now);
  if (status.settingsLocked) throw new BackupLockedError(lockRefusalMessage(status));
}

function lockStateSource(state: Awaited<ReturnType<typeof getLockState>>) {
  return {
    schedules: state.schedules ?? [],
    schedulesUpdatedAt: state.schedulesUpdatedAt ?? 0,
    categorySchedules: state.categorySchedules ?? [],
    categorySchedulesUpdatedAt: state.categorySchedulesUpdatedAt ?? 0,
  };
}

/** Parse, preview, capture the pre-restore slot, then commit settings,
 *  profiles and the schedule lists in one storage transaction. Refuses BEFORE
 *  any write while settings are locked. */
export async function applyBackupText(
  text: string,
  mode: BackupMode,
  now = Date.now(),
): Promise<BackupApplyResult> {
  const parsed = parseBackup(text, now);
  if (!parsed.ok) throw new BackupValidationError(parsed.errors);
  await assertUnlocked(now);

  const [current, lockState] = await Promise.all([getBackupCurrentState(), getLockState()]);
  const options = applyOptions(now);
  const applied =
    mode === 'merge'
      ? mergeBackupState(current, parsed.document, options)
      : replaceBackupState(current, parsed.document, options);

  // Capture the reversible slot before touching the live config. This is the
  // first write, and it contains the exact pre-restore bytes.
  const preText = serializeBackup(
    buildBackup({
      settings: current.settings,
      profiles: current.profiles,
      lockState: lockStateSource(lockState),
      exportedAt: new Date(now).toISOString(),
      appVersion: manifestVersion(),
      now,
    }),
  );
  if (preText.length > BACKUP_MAX_BYTES) {
    throw new Error('The current configuration is too large to capture a pre-restore backup.');
  }
  const slot: PreRestoreSlot = {
    version: PRE_RESTORE_VERSION,
    savedAt: now,
    mode,
    text: preText,
  };

  // Final lock check BEFORE overwriting the previous recovery point: a refused
  // restore must leave the user's old pre-restore slot intact (it used to be
  // destroyed by a slot write that preceded this check).
  await assertUnlocked(Date.now());

  // Re-read the lock at COMMIT time. The snapshot above was taken before an
  // awaited pre-restore write and the second lock check; a timer/password/
  // frozen lock armed in that window must survive the restore. Writing the
  // stale snapshot erased it (2026-11-21 audit). Residual: this write still
  // bypasses lock.ts's serialized queue, so a lock armed in the few
  // instructions between this read and the set remains theoretically
  // racy — the window is now milliseconds, not an entire UI round-trip.
  const latestLock = await getLockState();
  await api.storage.local.set({
    [PRE_RESTORE_STORAGE_KEY]: slot,
    settings: applied.settings,
    [PROFILES_STORAGE_KEY]: applied.profiles,
    lockState: applySchedulesToLockState(latestLock, applied),
  });

  const preview = buildBackupPreview(current, parsed.document, mode, options);
  return {
    mode,
    applied,
    preRestoreSavedAt: now,
    counts: preview.counts,
  };
}

export async function readPreRestoreInfo(
  now = Date.now(),
): Promise<PreRestoreInfo | null> {
  const stored = await api.storage.local.get(PRE_RESTORE_STORAGE_KEY);
  const raw = stored[PRE_RESTORE_STORAGE_KEY];
  if (!isRecord(raw) || raw.version !== PRE_RESTORE_VERSION) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const savedAt =
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
  const mode: BackupMode = raw.mode === 'replace' ? 'replace' : 'merge';
  const parsed = parseBackup(text, now);
  return {
    savedAt,
    mode,
    text,
    document: parsed.ok ? parsed.document : null,
    errors: parsed.ok ? [] : parsed.errors,
    profileCount: parsed.ok ? parsed.document.profiles.length : 0,
    scheduleCount: parsed.ok
      ? parsed.document.schedules.rules.length + parsed.document.categorySchedules.rules.length
      : 0,
  };
}

/** Restore the recovery slot as an explicit replace. Capturing the current
 *  config into the slot first means this is itself reversible. */
export async function restorePreRestore(now = Date.now()): Promise<BackupApplyResult> {
  const info = await readPreRestoreInfo(now);
  if (!info || info.document === null) {
    throw new BackupValidationError([
      { path: 'preRestore', message: 'No readable pre-restore backup is available.' },
    ]);
  }
  return applyBackupText(info.text, 'replace', now);
}

/** The pre-restore slot is a cache, not user data; expose a clear for tests
 *  and a future "forget snapshot" control. */
export async function clearPreRestore(): Promise<void> {
  await api.storage.local.remove(PRE_RESTORE_STORAGE_KEY);
}

export const BACKUP_STORAGE_VERSION = BACKUP_SCHEMA_VERSION;
