import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GearSix, LockSimple } from '@phosphor-icons/react';
import { api } from '../shared/api';
import { getSettings, setSettings } from '../shared/settings';
import { getLockStatus } from '../shared/lock';
import {
  commitFocusSessionIfDue,
  getPendingFocusSession,
  startFocusSession,
  undoFocusSession,
} from '../shared/focus-session';
import { getTabStatus } from '../shared/tab-status';
import { mergeEntries } from '../shared/domains';
import { hostnameOf } from '../shared/url-signals';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { ThisPageCard } from './ThisPageCard';
import { FocusSession } from './FocusSession';
import { ExtensionGraceNotice } from '../components/ExtensionGraceNotice';
import { BreakControl } from './BreakControl';
import {
  derivePageView,
  getActiveTab,
  loadCompanionSnapshot,
  loadFrozenUntil,
  loadPopupData,
  lockLineText,
  lockedReason,
  type PopupData,
} from './popup-model';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PopupApp({ initial }: { initial: PopupData | null }) {
  const [data, setData] = useState<PopupData | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [statusText, setStatusText] = useState('');

  // Focus goal draft (persisted value lives in data.settings.focusGoal).
  const [focusGoal, setFocusGoal] = useState(initial?.settings.focusGoal ?? '');
  const [selectedMins, setSelectedMins] = useState(60);
  const [sessionBusy, setSessionBusy] = useState(false);

  const dataRef = useRef(data);
  dataRef.current = data;

  const patch = useCallback((p: Partial<PopupData>) => {
    setData((prev) => (prev ? { ...prev, ...p } : prev));
  }, []);

  const refreshTab = useCallback(async () => {
    const tab = await getActiveTab();
    const tabStatus = tab ? await getTabStatus(tab.id, tab.url) : null;
    patch({ tab, tabStatus });
  }, [patch]);

  const refreshLock = useCallback(async () => {
    const [lock, frozenUntil] = await Promise.all([getLockStatus(), loadFrozenUntil()]);
    patch({ lock, frozenUntil });
  }, [patch]);

  const refreshCompanion = useCallback(async () => {
    patch({ companion: await loadCompanionSnapshot() });
  }, [patch]);

  // First load (only when popup.ts couldn't preload in time).
  useEffect(() => {
    if (initial) return;
    void loadPopupData().then((d) => {
      setData(d);
      setFocusGoal(d.settings.focusGoal);
    });
  }, [initial]);

  // Live updates: settings, locks, pending session, and this tab's verdict.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') {
        if (changes['settings']) {
          void getSettings().then((settings) => {
            patch({ settings });
            if (document.activeElement?.id !== 'focus-goal') setFocusGoal(settings.focusGoal);
          });
        }
        if (changes['lockState']) void refreshLock();
        if (changes['companionSnapshot']) void refreshCompanion();
        if (changes['pendingFocusSession']) {
          void getPendingFocusSession().then((pending) => patch({ pending }));
        }
      } else if (area === 'session') {
        const tabId = dataRef.current?.tab?.id;
        if (tabId !== undefined && changes[`tabStatus:${tabId}`]) void refreshTab();
      }
    };
    api.storage.onChanged.addListener(onChanged);

    const onTabUpdated = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === dataRef.current?.tab?.id && (info.url || info.title || info.status === 'complete')) {
        void refreshTab();
      }
    };
    api.tabs.onUpdated.addListener(onTabUpdated);

    return () => {
      api.storage.onChanged.removeListener(onChanged);
      api.tabs.onUpdated.removeListener(onTabUpdated);
    };
  }, [patch, refreshCompanion, refreshLock, refreshTab]);

  // Re-read the existing background companion cache while this popup is open.
  // This is not a daemon request: v2 has no cheap status-request/reply pair.
  useEffect(() => {
    const id = setInterval(() => void refreshCompanion(), 10_000);
    return () => clearInterval(id);
  }, [refreshCompanion]);

  // One clock for every countdown. Lock status is re-derived each tick so
  // schedule windows and timers start/end without a storage event.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      void refreshLock();
      const pending = dataRef.current?.pending;
      if (pending && t >= pending.commitAt) {
        void commitFocusSessionIfDue().then(async () => {
          patch({ pending: await getPendingFocusSession() });
          await refreshLock();
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [patch, refreshLock]);

  const settings = data?.settings ?? null;
  const lock = data?.lock ?? null;
  const locked = !!lock?.settingsLocked;
  const reason = lock ? lockedReason(lock, now) : '';
  const lockText = lock ? lockLineText(lock, now) : '';
  const blockingOn = !!settings && (settings.enabled || !!lock?.forceBlocking);

  const view = useMemo(() => (data ? derivePageView(data) : null), [data]);
  const reportLabels = useMemo(() => {
    if (!settings) return [];
    const blocked = settings.labels.filter((l) => settings.blockedLabels.includes(l));
    return blocked.length > 0 ? blocked : settings.labels;
  }, [settings]);

  // ---- actions ------------------------------------------------------------

  const saveSettings = async (p: Parameters<typeof setSettings>[0]): Promise<boolean> => {
    try {
      const next = await setSettings(p);
      patch({ settings: next });
      return true;
    } catch (e) {
      setStatusText(errorText(e));
      return false;
    }
  };

  const setEnabled = async (next: boolean) => {
    if (await saveSettings({ enabled: next })) {
      setStatusText(next ? 'Blocking is on.' : 'Blocking is paused.');
    }
  };

  const savedGoal = settings?.focusGoal ?? '';
  const focusClearPending = savedGoal !== '' && focusGoal.trim() === savedGoal;

  const submitFocusGoal = async () => {
    const target = focusClearPending ? '' : focusGoal.trim();
    if (await saveSettings({ focusGoal: target })) {
      setFocusGoal(target);
      setStatusText(target ? `Focus goal set: ${target}` : 'Focus goal cleared.');
    }
  };

  const toggleTabContext = async (next: boolean) => {
    if (await saveSettings({ useTabContext: next })) {
      setStatusText(next ? 'Using your open tabs as context.' : 'Open tabs are no longer used as context.');
    }
  };

  const allowSite = async () => {
    const url = data?.tab?.url;
    if (!settings || !url) return;
    const host = hostnameOf(url);
    const merged = mergeEntries(settings.whitelist, [host], 'domain');
    if (merged.invalid.length > 0) {
      setStatusText(merged.invalid[0].error);
      return;
    }
    if (merged.added.length === 0) {
      setStatusText(`${host} is already on your allowed sites.`);
      return;
    }
    if (await saveSettings({ whitelist: merged.items })) {
      setStatusText(`Added ${merged.added[0]} to your allowed sites.`);
    }
  };

  const removeAllowed = async () => {
    if (!settings || !view || view.allowedBy.length === 0) return;
    const drop = new Set(view.allowedBy);
    if (await saveSettings({ whitelist: settings.whitelist.filter((e) => !drop.has(e)) })) {
      setStatusText(`Removed ${view.allowedBy.join(', ')} from your allowed sites. Reload the page to check it.`);
    }
  };

  const reportMissed = async (label: string): Promise<boolean> => {
    const tab = data?.tab;
    if (!tab?.title || !tab.url) {
      setStatusText('This tab has no page to report.');
      return false;
    }
    try {
      const res = await api.runtime.sendMessage({
        type: 'REPORT_FN' as const,
        title: tab.title,
        url: tab.url,
        correctedLabel: label,
      });
      if (res?.ok) {
        setStatusText(`Thanks — SmartBlocker will treat pages like this as ${label}.`);
        return true;
      }
      setStatusText(
        res?.error === 'locked'
          ? 'Reports are paused while SmartBlocker is locked.'
          : `Couldn’t save the report (${res?.error ?? 'no response'}).`,
      );
    } catch (e) {
      setStatusText(`Couldn’t save the report (${errorText(e)}).`);
    }
    return false;
  };

  const startSession = async () => {
    setSessionBusy(true);
    try {
      const pending = await startFocusSession(selectedMins * 60_000);
      patch({ pending });
      setNow(Date.now());
      setStatusText('Focus session locks in 1 minute. Undo now if you didn’t mean it.');
    } catch (e) {
      setStatusText(errorText(e));
    } finally {
      setSessionBusy(false);
    }
  };

  const undoSession = async () => {
    setSessionBusy(true);
    try {
      const undone = await undoFocusSession();
      patch({ pending: null });
      await refreshLock();
      setStatusText(undone ? 'Focus session cancelled.' : 'Too late — the focus session already started.');
    } finally {
      setSessionBusy(false);
    }
  };

  // ---- render -------------------------------------------------------------

  return (
    <main className="flex w-full max-w-full flex-col overflow-x-hidden bg-background text-foreground">
      <header className="flex h-12 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <LockSimple weight="bold" className="size-3.5" aria-hidden />
          </span>
          <h1 className="m-0 text-sm font-semibold tracking-tight">SmartBlocker</h1>
        </div>
        <div className="flex items-center gap-1">
          <label
            htmlFor="popup-enabled-toggle"
            className="mr-1.5 cursor-pointer text-xs text-muted-foreground select-none"
            title={locked ? reason : undefined}
          >
            {settings ? (blockingOn ? 'Blocking on' : 'Paused') : ''}
          </label>
          <Switch
            id="popup-enabled-toggle"
            aria-label="Blocking"
            checked={blockingOn}
            disabled={!settings || locked}
            title={locked ? reason : undefined}
            onChange={(e) => void setEnabled(e.target.checked)}
          />
          <Button
            id="open-options"
            variant="ghost"
            size="icon"
            className="ml-1"
            onClick={() => void api.runtime.openOptionsPage()}
            title="Settings"
            aria-label="Settings"
          >
            <GearSix className="size-4" />
          </Button>
        </div>
      </header>

      <div
        id="lock-line"
        role="status"
        style={{ display: locked ? 'flex' : 'none' }}
        className="items-start gap-2 border-b border-accent/30 bg-accent/10 px-4 py-2.5 text-[13px] font-medium text-accent-soft"
      >
        <LockSimple weight="fill" className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="tabular-nums">{lockText}</span>
      </div>

      <ExtensionGraceNotice
        id="extension-grace"
        locked={locked}
        companion={data?.companion ?? null}
        now={now}
        className="rounded-none border-x-0 border-t-0 px-4 py-2.5"
      />

      <div className="flex flex-col gap-4 p-4">
        <ThisPageCard
          view={view}
          locked={locked}
          lockedReason={reason}
          reportLabels={reportLabels}
          onTurnOn={() => void setEnabled(true)}
          onAllowSite={() => void allowSite()}
          onRemoveAllowed={() => void removeAllowed()}
          onReport={reportMissed}
        />

        <section aria-labelledby="focus-goal-label" className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <label id="focus-goal-label" htmlFor="focus-goal" className="text-[13px] font-medium">
              What are you working on?
            </label>
            {locked && (
              <span className="flex items-center gap-1 text-xs text-faint">
                <LockSimple weight="fill" className="size-3 self-center text-accent" aria-hidden />
                {reason}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="focus-goal"
              value={focusGoal}
              disabled={!settings || locked}
              title={locked ? reason : undefined}
              onChange={(e) => setFocusGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitFocusGoal();
                }
              }}
              placeholder="e.g. Studying for my Rust exam"
              className="h-8 text-[13px]"
            />
            <Button
              id="save-focus-goal"
              variant={focusClearPending ? 'ghost' : 'secondary'}
              size="sm"
              className="w-16 shrink-0"
              disabled={!settings || locked}
              title={locked ? reason : undefined}
              onClick={() => void submitFocusGoal()}
            >
              {focusClearPending ? 'Clear' : 'Set'}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="use-tab-context" className="cursor-pointer text-xs text-muted-foreground select-none">
              Use my open tabs as context
            </label>
            <Switch
              id="use-tab-context"
              checked={settings?.useTabContext ?? false}
              disabled={!settings || locked}
              title={locked ? reason : undefined}
              onChange={(e) => void toggleTabContext(e.target.checked)}
            />
          </div>
        </section>

        <div className="h-px bg-border" aria-hidden />

        <FocusSession
          now={now}
          selectedMins={selectedMins}
          onSelect={setSelectedMins}
          pending={data?.pending ?? null}
          frozenUntil={data?.frozenUntil ?? null}
          busy={sessionBusy || !data}
          onStart={() => void startSession()}
          onUndo={() => void undoSession()}
        />

        {settings && lock && (
          <BreakControl
            now={now}
            mode={settings.breakMode}
            delayMinutes={settings.breakDelayMinutes}
            durationMinutes={settings.breakDurationMinutes}
            lock={lock}
            onLock={(nextLock) => patch({ lock: nextLock })}
            onStatus={setStatusText}
          />
        )}

        <p id="status" role="status" aria-live="polite" className="m-0 min-h-4 text-xs text-muted-foreground">
          {statusText}
        </p>
      </div>
    </main>
  );
}
