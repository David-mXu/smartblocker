import React, { useEffect, useState } from 'react';
import { api } from '../../shared/api';
import { clearFeedback, getFeedback } from '../../shared/feedback';
import { FEEDBACK_ENDPOINT } from '../../shared/config';
import type { DeleteSharedFeedbackResponse, SharedFeedbackInfoResponse } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { LockedNote, Page } from './Page';

export function PrivacyPage({ state }: { state: OptionsState }) {
  const { settings, lock, save, flash } = state;
  const locked = lock.locked;

  const [feedbackCount, setFeedbackCount] = useState(0);
  const [clearConfirm, setClearConfirm] = useState(false);

  // Self-service erasure (#32 P3): installId reveal + delete flow.
  const [installId, setInstallId] = useState<string | null>(null);
  const [idRevealed, setIdRevealed] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [deleteResult, setDeleteResult] = useState<{ deleted: number } | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const refreshFeedbackCount = async () => {
    setFeedbackCount((await getFeedback()).length);
  };

  useEffect(() => {
    void refreshFeedbackCount();
    void (async () => {
      try {
        const resp = (await api.runtime.sendMessage({
          type: 'GET_SHARED_FEEDBACK_INFO',
        })) as SharedFeedbackInfoResponse;
        setInstallId(resp?.ok ? (resp.installId ?? null) : null);
      } catch {
        // Background unreachable during SW restart.
      }
    })();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes['feedback']) void refreshFeedbackCount();
    };
    api.storage.onChanged.addListener(onChanged);
    return () => api.storage.onChanged.removeListener(onChanged);
  }, []);

  if (!settings) return null;

  const handleExportFeedback = async () => {
    const records = await getFeedback();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartblocker-feedback-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearFeedback = async () => {
    if (locked) return;
    if (!clearConfirm) {
      setClearConfirm(true);
      setTimeout(() => setClearConfirm(false), 5000);
      return;
    }
    setClearConfirm(false);
    await clearFeedback();
    await refreshFeedbackCount();
    flash('Corrections cleared');
  };

  const copyInstallId = async () => {
    if (!installId) return;
    try {
      await navigator.clipboard.writeText(installId);
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable — the revealed text stays selectable.
    }
  };

  const runDeleteShared = async () => {
    if (deleteStage === 'idle') {
      setDeleteResult(null);
      setDeleteError('');
      setDeleteStage('confirm');
      return;
    }
    setDeleteStage('busy');
    try {
      const resp = (await api.runtime.sendMessage({
        type: 'DELETE_SHARED_FEEDBACK',
      })) as DeleteSharedFeedbackResponse;
      if (resp?.ok) {
        setDeleteResult({ deleted: resp.deleted ?? 0 });
        setDeleteError('');
      } else {
        setDeleteResult(null);
        setDeleteError(resp?.error ?? 'delete failed');
      }
    } catch (e) {
      setDeleteResult(null);
      setDeleteError(String(e));
    }
    setDeleteStage('idle');
  };

  return (
    <Page
      title="Privacy & data"
      description="Everything runs on this device. When you correct a block, SmartBlocker learns from it here. Nothing is shared unless you turn sharing on."
    >
      <SettingsSection title="What SmartBlocker has learned">
        <SettingsGroup>
          <SettingRow
            label={
              <>
                <span id="feedback-count" className="font-mono tabular-nums">
                  {feedbackCount}
                </span>{' '}
                {feedbackCount === 1 ? 'correction' : 'corrections'} learned
              </>
            }
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                'Stored only in this browser profile. Clearing them undoes what SmartBlocker learned.'
              )
            }
            control={
              <>
                <Button id="feedback-export" variant="ghost" size="sm" onClick={() => void handleExportFeedback()}>
                  Export as JSON
                </Button>
                <Button
                  id="feedback-clear"
                  variant={clearConfirm ? 'destructive' : 'secondary'}
                  size="sm"
                  disabled={locked || feedbackCount === 0}
                  onClick={() => void handleClearFeedback()}
                >
                  {clearConfirm ? 'Click again to clear' : 'Clear corrections'}
                </Button>
              </>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Sharing">
        <SettingsGroup>
          <SettingRow
            label="Share corrections to improve blocking"
            htmlFor="share-toggle"
            description="Off by default. Sends only the page title, site name and category — never full addresses or your history."
            control={
              <Switch
                id="share-toggle"
                checked={settings.shareFeedback}
                disabled={locked}
                onChange={(e) => void save({ shareFeedback: e.target.checked })}
              />
            }
          />
          <SettingRow
            label="Identify embedded YouTube videos"
            htmlFor="oembed-toggle"
            description="Off by default. Asks YouTube for the titles of videos embedded in other pages so they can be checked. Never used for privacy-enhanced embeds."
            control={
              <Switch
                id="oembed-toggle"
                checked={settings.resolveEmbedTitles}
                disabled={locked}
                onChange={(e) => void save({ resolveEmbedTitles: e.target.checked })}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {/* Danger zone — self-service erasure (#32 P3). The id only exists after
          the FIRST shared correction — never minted just for viewing. */}
      <SettingsSection title="Delete shared data">
        <SettingsGroup className="border-destructive/30">
          <SettingRow
            stacked
            label="Your shared feedback data"
            description="Deletes every record shared from this installation. Limited to once per hour; shared records also expire after 90 days."
            control={
              <Button
                variant={deleteStage === 'confirm' ? 'destructive' : 'secondary'}
                size="sm"
                disabled={deleteStage === 'busy' || (!FEEDBACK_ENDPOINT && deleteStage !== 'confirm')}
                onClick={() => void runDeleteShared()}
              >
                {deleteStage === 'busy'
                  ? 'Deleting…'
                  : deleteStage === 'confirm'
                    ? 'Click again to confirm delete'
                    : 'Delete shared data'}
              </Button>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs">
              <span className="text-faint">Install ID — random, not tied to you</span>
              {installId ? (
                <span className="flex items-center gap-1">
                  <code className="mr-1 font-mono text-xs text-muted-foreground">
                    {idRevealed ? installId : `${installId.slice(0, 8)}…••••`}
                  </code>
                  <Button variant="ghost" size="xs" onClick={() => setIdRevealed((v) => !v)}>
                    {idRevealed ? 'Hide' : 'Reveal'}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => void copyInstallId()}>
                    {idCopied ? 'Copied' : 'Copy'}
                  </Button>
                </span>
              ) : (
                <span className="text-faint">none yet — created the first time you share a correction</span>
              )}
            </div>
            {!FEEDBACK_ENDPOINT && (
              <p className="m-0 text-xs text-faint">
                Feedback sharing is not configured in this build — nothing was ever uploaded, so there is
                nothing to delete.
              </p>
            )}
            <div role="status" aria-live="polite" className="empty:hidden">
              {deleteResult && (
                <p className="m-0 text-xs text-success-soft">
                  Done — {deleteResult.deleted} record(s) deleted
                  {deleteResult.deleted === 0 ? ' (nothing had been shared)' : ''}.
                </p>
              )}
              {deleteError && <p className="m-0 text-xs text-destructive-soft">Could not delete: {deleteError}</p>}
            </div>
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
