import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, DownloadSimple, UploadSimple } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import {
  BACKUP_MAX_BYTES,
  parseBackup,
  type BackupIssue,
  type BackupMode,
  type BackupPreview,
} from '../../shared/backup';
import {
  applyBackupText,
  createBackupText,
  previewBackupText,
  readPreRestoreInfo,
  restorePreRestore,
  type PreRestoreInfo,
} from '../../shared/backup-store';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { formatClock } from '../format';
import { LockedNote, Page } from './Page';

// Configuration backup/restore. Export writes a versioned JSON file; import
// validates, previews the exact merge/replace diff, and refuses while locked
// BEFORE any live write. The pre-restore slot is the undo for a bad import.

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function changeLabel(change: BackupPreview['changes'][number]): string {
  const verb = change.action === 'add' ? 'Add' : change.action === 'update' ? 'Update' : 'Remove';
  const kind =
    change.kind === 'default'
      ? 'Default settings'
      : change.kind === 'profile'
        ? 'Profile'
        : change.kind === 'schedule'
          ? 'Focus hours'
          : 'Category window';
  return `${verb} ${kind.toLowerCase()}: ${change.name}`;
}

export function BackupPage({ state }: { state: OptionsState }) {
  const { lock, refreshProfiles, refreshLock, flash } = state;
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<BackupMode>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [errors, setErrors] = useState<BackupIssue[]>([]);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [preRestore, setPreRestore] = useState<PreRestoreInfo | null>(null);
  const [preRestoreBusy, setPreRestoreBusy] = useState(false);
  const [preRestoreConfirm, setPreRestoreConfirm] = useState(false);
  const [preRestoreMessage, setPreRestoreMessage] = useState('');
  const [preRestoreError, setPreRestoreError] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refreshPreRestore = useCallback(async () => {
    setPreRestore(await readPreRestoreInfo());
  }, []);

  useEffect(() => {
    void refreshPreRestore();
  }, [refreshPreRestore]);

  const announce = (value: string, error = false) => {
    setMessage(value);
    setMessageError(error);
  };

  const computePreview = useCallback(
    async (content: string, nextMode: BackupMode) => {
      const parsed = parseBackup(content, Date.now());
      if (!parsed.ok) {
        setErrors(parsed.errors);
        setPreview(null);
        return;
      }
      const result = await previewBackupText(content, nextMode);
      if (!result.ok) {
        setErrors(result.errors);
        setPreview(null);
        return;
      }
      setErrors([]);
      setPreview(result.preview);
    },
    [],
  );

  const handleExport = async () => {
    setExporting(true);
    setMessage('');
    try {
      const content = await createBackupText();
      downloadText(content, `smartblocker-backup-${fileNameDate()}.json`);
      announce('Backup downloaded.');
    } catch (error) {
      announce(errorText(error), true);
    } finally {
      setExporting(false);
    }
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setMessage('');
    setErrors([]);
    setPreview(null);
    setConfirmReplace(false);
    if (file.size > BACKUP_MAX_BYTES) {
      setErrors([
        {
          path: 'file',
          message: `This file is larger than the ${Math.round(BACKUP_MAX_BYTES / (1024 * 1024))} MB limit.`,
        },
      ]);
      setText('');
      return;
    }
    const content = await file.text();
    setText(content);
    setBusy(true);
    try {
      await computePreview(content, mode);
    } finally {
      setBusy(false);
    }
  };

  const handleMode = (next: BackupMode) => {
    setMode(next);
    setConfirmReplace(false);
    if (!text) return;
    void (async () => {
      setBusy(true);
      try {
        await computePreview(text, next);
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleApply = async () => {
    if (!preview) return;
    if (mode === 'replace' && !confirmReplace) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await applyBackupText(text, mode);
      await Promise.all([refreshProfiles(), refreshLock(), refreshPreRestore()]);
      const profileCount = result.applied.profiles.profiles.length;
      announce(
        `${mode === 'replace' ? 'Replaced' : 'Merged'} ${profileCount} ${
          profileCount === 1 ? 'profile' : 'profiles'
        }.`,
      );
      // The file no longer describes a pending change; recompute against the
      // freshly applied state so the preview is honest.
      await computePreview(text, mode);
    } catch (error) {
      announce(errorText(error), true);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadPreRestore = () => {
    if (!preRestore) return;
    downloadText(
      preRestore.text,
      `smartblocker-pre-restore-${new Date(preRestore.savedAt).toISOString().slice(0, 10)}.json`,
    );
  };

  const handleRestorePreRestore = async () => {
    if (!preRestore) return;
    if (!preRestoreConfirm) {
      setPreRestoreConfirm(true);
      setPreRestoreMessage('Click Restore pre-restore again to replace the current configuration.');
      setPreRestoreError(false);
      return;
    }
    setPreRestoreConfirm(false);
    setPreRestoreBusy(true);
    setPreRestoreMessage('');
    try {
      await restorePreRestore();
      await Promise.all([refreshProfiles(), refreshLock(), refreshPreRestore()]);
      setPreRestoreMessage('Pre-restore snapshot applied.');
      setPreRestoreError(false);
      flash('Restored');
    } catch (error) {
      setPreRestoreMessage(errorText(error));
      setPreRestoreError(true);
    } finally {
      setPreRestoreBusy(false);
    }
  };

  const locked = lock.locked;
  const replaceNeedsConfirm = mode === 'replace' && !confirmReplace;
  const canApply = Boolean(preview) && !busy && !replaceNeedsConfirm;

  return (
    <Page
      title="Backup"
      description="Save your categories, sites, rules, named profiles and focus hours to a file — then restore them later or on another install. The file stays on this device unless you share it."
    >
      {locked && (
        <LockedNote
          id="backup-lock-note"
          className="px-1"
          reason={`Restore is refused while SmartBlocker is locked — ${lock.reason.toLowerCase()}.`}
        />
      )}

      <SettingsSection
        title="Save a copy"
        description="A versioned JSON file with your Default settings, named profiles (including desktop apps), and configured focus hours."
        aside={
          <span className="text-xs tabular-nums text-faint">schema v1</span>
        }
      >
        <SettingsGroup>
          <SettingRow
            label="Download configuration"
            description="Includes policy, categories, sites, rules, named profiles, desktop-app associations, and focus-hour rules. It does not include active locks, passwords, usage statistics, corrections, or session state."
            control={
              <Button
                id="backup-export"
                size="sm"
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                <DownloadSimple className="size-3.5" />
                {exporting ? 'Preparing…' : 'Export JSON'}
              </Button>
            }
          />
        </SettingsGroup>
        <p className="m-0 px-1 text-xs text-faint">
          Keep the file somewhere you trust: it contains your allowed and blocked sites, rules,
          focus goals, and optional block-screen note.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Restore from a file"
        description="Nothing is written until you apply. Merge keeps local profiles and rules and adds or updates from the file; replace swaps the managed configuration."
        aside={
          <span className="text-xs tabular-nums text-faint">
            {preview
              ? `${preview.changes.length} ${preview.changes.length === 1 ? 'change' : 'changes'}`
              : 'no file loaded'}
          </span>
        }
      >
        <SettingsGroup>
          <SettingRow
            stacked
            label="Choose a backup file"
            description="JSON exported by SmartBlocker. A corrupt, oversized, or newer-schema file is rejected before anything changes."
            control={
              <Button
                id="backup-pick"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <UploadSimple className="size-3.5" />
                Choose file
              </Button>
            }
          >
            <input
              ref={fileInput}
              id="backup-import"
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void handleFile(event)}
            />
            <p id="backup-file" className="m-0 min-h-4 truncate font-mono text-xs text-muted-foreground">
              {fileName || 'No file chosen'}
            </p>
          </SettingRow>

          <fieldset className="m-0 flex flex-col gap-2 border-0 px-4 py-3.5">
            <legend className="p-0 text-sm font-medium text-foreground">Restore mode</legend>
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-muted-foreground">
              <input
                id="backup-mode-merge"
                type="radio"
                name="backup-mode"
                value="merge"
                checked={mode === 'merge'}
                onChange={() => handleMode('merge')}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span>
                <span className="font-medium text-foreground">Merge</span> — add and update from
                the file, keep local-only profiles and rules. Lists are unioned with the imported
                entries first.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-muted-foreground">
              <input
                id="backup-mode-replace"
                type="radio"
                name="backup-mode"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => handleMode('replace')}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span>
                <span className="font-medium text-foreground">Replace</span> — swap the managed
                configuration. Local profiles and focus hours not in the file are deleted.
              </span>
            </label>
          </fieldset>

          {mode === 'replace' && (
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <Callout tone="warning" id="backup-confirm-replace-note">
                Replace deletes local profiles and focus hours that are not in this file. The
                current configuration is saved to the pre-restore slot first.
              </Callout>
              <label className="flex w-fit cursor-pointer items-center gap-2.5 text-[13px] text-foreground">
                <Checkbox
                  id="backup-confirm-replace"
                  checked={confirmReplace}
                  onChange={(event) => setConfirmReplace(event.target.checked)}
                />
                I understand replace removes local-only configuration.
              </label>
            </div>
          )}
        </SettingsGroup>

        <div id="backup-errors" role="alert" className="flex flex-col gap-1 px-1 empty:hidden">
          {errors.map((issue, index) => (
            <p key={`${issue.path}-${index}`} className="m-0 text-[13px] text-destructive-soft">
              {issue.message}
            </p>
          ))}
        </div>

        <SettingsGroup>
          <div
            id="backup-preview"
            role="region"
            aria-label="Restore preview"
            aria-live="polite"
            className="flex flex-col gap-3 px-4 py-3.5"
          >
            <div className="flex flex-col gap-0.5">
              <h3 className="m-0 text-sm font-medium text-foreground">Preview</h3>
              <p id="backup-preview-summary" className="m-0 text-[13px] tabular-nums text-muted-foreground">
                {preview
                  ? preview.summary
                  : 'Choose a valid backup file to see exactly what will change.'}
              </p>
            </div>

            {preview && preview.changes.length > 0 && (
              <ul
                id="backup-preview-changes"
                className="m-0 flex list-none flex-col divide-y divide-border border-y border-border p-0"
              >
                {preview.changes.map((change, index) => (
                  <li
                    key={`${change.kind}-${change.action}-${change.name}-${index}`}
                    data-kind={change.kind}
                    data-action={change.action}
                    className="py-2.5"
                  >
                    <p className="m-0 text-[13px] font-medium text-foreground">
                      {changeLabel(change)}
                    </p>
                    {change.details.length > 0 && (
                      <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">

                        {change.details.map((detail) => (
                          <li key={detail} className="text-xs text-muted-foreground">
                            {detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {preview && preview.warnings.length > 0 && (
              <ul id="backup-preview-warnings" className="m-0 flex list-none flex-col gap-1 p-0">
                {preview.warnings.map((warning) => (
                  <li key={warning} className="text-xs text-warning-soft">
                    {warning}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                id="backup-apply"
                variant="secondary"
                disabled={!canApply}
                title={replaceNeedsConfirm ? 'Confirm that replace removes local-only configuration' : undefined}
                onClick={() => void handleApply()}
              >
                <ArrowClockwise className="size-3.5" />
                {busy ? 'Applying…' : mode === 'replace' ? 'Replace configuration' : 'Merge configuration'}
              </Button>
              <span
                id="backup-msg"
                role="status"
                aria-live="polite"
                className={cn(
                  'min-h-4 text-xs font-medium',
                  messageError ? 'text-destructive-soft' : 'text-success-soft',
                )}
              >
                {message}
              </span>
            </div>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Pre-restore snapshot"
        description="Every restore first saves the configuration it is about to replace here. Download it for safekeeping or put it back if an import went wrong."
        aside={
          preRestore ? (
            <span className="text-xs tabular-nums text-faint">
              {preRestore.profileCount} profiles · {preRestore.scheduleCount} rules
            </span>
          ) : undefined
        }
      >
        <SettingsGroup id="backup-pre-restore">
          <div className="flex flex-col gap-3 px-4 py-3.5">
            {preRestore ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <p className="m-0 text-sm font-medium text-foreground">
                    Saved before the last {preRestore.mode === 'replace' ? 'replace' : 'merge'}
                  </p>
                  <p id="backup-pre-restore-info" className="m-0 text-[13px] text-muted-foreground">
                    {preRestore.savedAt
                      ? formatClock(preRestore.savedAt, Date.now(), state.settings?.hour24 ?? false)
                      : 'unknown time'}{' '}
                    · {preRestore.profileCount}{' '}
                    {preRestore.profileCount === 1 ? 'profile' : 'profiles'} ·{' '}
                    {preRestore.scheduleCount}{' '}
                    {preRestore.scheduleCount === 1 ? 'focus-hour rule' : 'focus-hour rules'}
                  </p>
                  {preRestore.errors.length > 0 && (
                    <p className="m-0 text-xs text-destructive-soft">
                      This snapshot is unreadable: {preRestore.errors[0].message}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    id="backup-pre-restore-download"
                    size="sm"
                    variant="secondary"
                    onClick={handleDownloadPreRestore}
                  >
                    <DownloadSimple className="size-3.5" />
                    Download snapshot
                  </Button>
                  <Button
                    id="backup-pre-restore-apply"
                    size="sm"
                    variant={preRestoreConfirm ? 'destructive' : 'outline'}
                    disabled={preRestoreBusy || preRestore.document === null}
                    onClick={() => void handleRestorePreRestore()}
                  >
                    <ArrowClockwise className="size-3.5" />
                    {preRestoreBusy
                      ? 'Restoring…'
                      : preRestoreConfirm
                        ? 'Confirm restore'
                        : 'Restore pre-restore'}
                  </Button>
                  <span
                    id="backup-pre-restore-msg"
                    role="status"
                    aria-live="polite"
                    className={cn(
                      'min-h-4 text-xs font-medium',
                      preRestoreError ? 'text-destructive-soft' : 'text-success-soft',
                    )}
                  >
                    {preRestoreMessage}
                  </span>
                </div>
                <p className="m-0 text-xs text-faint">
                  Restoring this snapshot is a replace operation, and it captures the current
                  configuration here first — so the undo is itself undoable.
                </p>
              </>
            ) : (
              <p className="m-0 text-[13px] text-muted-foreground">
                No snapshot yet. One is created automatically before your first restore.
              </p>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
