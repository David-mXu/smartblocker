import React, { useEffect, useRef, useState } from 'react';
import { LockSimple, Flask, ClockCounterClockwise, Gauge, GearSix } from '@phosphor-icons/react';
import { api } from '../shared/api';
import { getSettings, setSettings } from '../shared/settings';
import { getLockStatus, startFrozenTurkey } from '../shared/lock';
import type {
  HistoryScanState,
  LatencySample,
  TestPairResponse,
} from '../shared/messages';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const LOCK_REASON_NAMES: Record<string, string> = {
  timer: 'timer lock',
  password: 'password lock',
  frozen: 'Frozen Turkey',
  schedule: 'scheduled block',
};

function formatRemaining(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const FROZEN_PRESETS = [
  { mins: 60, label: '1h' },
  { mins: 240, label: '4h' },
  { mins: 480, label: '8h' },
] as const;

export function PopupApp() {
  const [enabled, setEnabled] = useState(true);
  const [allowedCount, setAllowedCount] = useState(0);
  const [focusGoal, setFocusGoal] = useState('');
  const [savedFocusGoal, setSavedFocusGoal] = useState('');
  const [useTabContext, setUseTabContext] = useState(true);
  const [labels, setLabels] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');

  const [settingsLocked, setSettingsLocked] = useState(false);
  const [lockText, setLockText] = useState('');
  const [confirmingMins, setConfirmingMins] = useState<number | null>(null);

  const [statusText, setStatusText] = useState('');
  // Empty until a diagnostic runs (the well hides itself via :empty).
  const [outText, setOutText] = useState('');

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshLockLine = async () => {
    const s = await getLockStatus();
    setSettingsLocked(s.settingsLocked);
    if (!s.settingsLocked) {
      setLockText('');
      return;
    }
    const reasons = s.reasons.map((r) => LOCK_REASON_NAMES[r]).join(', ');
    const tail = s.until ? ` — ${formatRemaining(s.until - Date.now())} left` : ' (password)';
    setLockText(`Locked: ${reasons}${tail}`);
  };

  useEffect(() => {
    void getSettings().then((s) => {
      setEnabled(s.enabled);
      setAllowedCount(s.whitelist.length);
      setSavedFocusGoal(s.focusGoal);
      setFocusGoal(s.focusGoal);
      setUseTabContext(s.useTabContext);
      setLabels(s.labels);
      if (s.labels.length > 0) {
        setSelectedCategory(s.labels[0]);
      }
    });

    void refreshLockLine();
    const lockInterval = setInterval(() => void refreshLockLine(), 1000);

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes['settings']) {
        void getSettings().then((s) => {
          setEnabled(s.enabled);
          setAllowedCount(s.whitelist.length);
          setLabels(s.labels);
          setUseTabContext(s.useTabContext);
          if (s.labels.length > 0) {
            setSelectedCategory((prev) => (s.labels.includes(prev) ? prev : s.labels[0]));
          }
          if (document.activeElement?.id !== 'focus-goal') {
            setSavedFocusGoal(s.focusGoal);
            setFocusGoal(s.focusGoal);
          }
        });
      }
    };
    api.storage.onChanged.addListener(onStorageChanged);

    return () => {
      clearInterval(lockInterval);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      api.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const focusClearPending =
    savedFocusGoal !== '' && focusGoal.trim() === savedFocusGoal;

  const persistFocusSettings = async (nextGoal: string, nextTabContext: boolean) => {
    try {
      const next = await setSettings({
        focusGoal: nextGoal.trim(),
        useTabContext: nextTabContext,
      });
      setSavedFocusGoal(next.focusGoal);
      setFocusGoal(next.focusGoal);
      setUseTabContext(next.useTabContext);
      setStatusText(
        next.focusGoal
          ? `Focus goal set: ${next.focusGoal}`
          : 'Focus goal cleared.',
      );
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmitFocusGoal = () => {
    const targetGoal = focusClearPending ? '' : focusGoal;
    if (focusClearPending) setFocusGoal('');
    void persistFocusSettings(targetGoal, useTabContext);
  };

  const handleToggleEnabled = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setEnabled(next);
    void setSettings({ enabled: next })
      .then(() => {
        setStatusText(next ? 'SmartBlocker enabled.' : 'SmartBlocker paused.');
      })
      .catch((err) => {
        setEnabled(!next);
        setStatusText(err instanceof Error ? err.message : String(err));
      });
  };

  const handleToggleTabContext = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextChecked = e.target.checked;
    setUseTabContext(nextChecked);
    void persistFocusSettings(focusGoal, nextChecked);
  };

  const handleFrozenClick = async (mins: number, label: string) => {
    if (confirmingMins !== mins) {
      setConfirmingMins(mins);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => {
        setConfirmingMins((prev) => (prev === mins ? null : prev));
      }, 3000);
      return;
    }
    setConfirmingMins(null);
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    await startFrozenTurkey(mins * 60_000);
    await refreshLockLine();
    setStatusText(`Frozen Turkey on — distractions blocked for ${label}.`);
  };

  const handleReportFn = async () => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.title || !tab.url) {
      setStatusText('No reportable page in the active tab.');
      return;
    }
    const res = await api.runtime.sendMessage({
      type: 'REPORT_FN' as const,
      title: tab.title,
      url: tab.url,
      correctedLabel: selectedCategory,
    });
    setStatusText(
      res?.ok
        ? `Recorded: "${tab.title}" -> ${selectedCategory}`
        : `Report failed: ${res?.error ?? 'no response'}`,
    );
  };

  const handleTestPair = async () => {
    setStatusText('Classifying… the first run downloads the model (~34 MB).');
    setOutText('');
    const res: TestPairResponse = await api.runtime.sendMessage({ type: 'TEST_PAIR' });
    setStatusText('');
    if (!res?.ok || !res.results) {
      setOutText(`Error: ${res?.error ?? 'no response from background'}`);
      return;
    }
    setOutText(
      res.results
        .map((r) => {
          const dist = r.all.labels
            .map((l, i) => `  ${pct(r.all.scores[i]).padStart(4)} ${l}`)
            .join('\n');
          return (
            `"${r.text}"\n-> ${r.label} (${pct(r.score)})` +
            `${r.cached ? ' [cached]' : ` [load ${Math.round(r.loadMs)}ms, infer ${Math.round(r.inferMs)}ms]`}\n${dist}`
          );
        })
        .join('\n\n'),
    );
  };

  const renderScan = (s: HistoryScanState | undefined) => {
    if (!s) {
      setOutText('No scan data yet.');
      return;
    }
    const counts = Object.entries(s.categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => `  ${String(n).padStart(4)}  ${label}`)
      .join('\n');
    const zeroHint =
      s.status === 'done' && s.total === 0
        ? s.historyCount === 0
          ? '\n(No browsing history found.)'
          : `\n(Found ${s.historyCount} history entries, but all were on your whitelist, ` +
            `already-seen titles, or too generic to classify.)`
        : '';
    setOutText(
      `Scan ${s.status}: ${s.done}/${s.total} titles in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
        (s.error ? `Error: ${s.error}\n` : '') +
        zeroHint +
        `\nCategories:\n${counts || '  (none yet)'}\n\nLatest:\n` +
        s.items
          .slice(-10)
          .map((i) => `  [${i.label} ${pct(i.score)}] ${i.title}`)
          .join('\n'),
    );
  };

  const handleScanHistory = async () => {
    setStatusText('Scanning history...');
    await api.runtime.sendMessage({ type: 'SCAN_HISTORY' });
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = setInterval(async () => {
      const { historyScan } = await api.storage.local.get('historyScan');
      renderScan(historyScan);
      if (historyScan && historyScan.status !== 'running') {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setStatusText('');
      }
    }, 1000);
  };

  const handleLatencyLog = async () => {
    setStatusText('');
    const { latencySamples = [] } = await api.storage.local.get('latencySamples');
    if (!latencySamples.length) {
      setOutText('No latency samples yet — visit a YouTube/Reddit page.');
      return;
    }
    setOutText(
      (latencySamples as LatencySample[])
        .slice()
        .reverse()
        .map(
          (s) =>
            `${s.blocked ? 'BLOCK' : 'allow'} [${s.label} ${pct(s.score)}] "${s.title}"\n` +
            `  pageDelay ${s.pageDelayMs}ms | load ${Math.round(s.loadMs)}ms | ` +
            `infer ${Math.round(s.inferMs)}ms | inject ${Math.round(s.injectMs)}ms | ` +
            `total ${Math.round(s.totalMs)}ms${s.cached ? ' (cached)' : ''}`,
        )
        .join('\n\n'),
    );
  };

  const handleOpenOptions = () => {
    api.runtime.openOptionsPage();
  };

  const confirmingPreset = FROZEN_PRESETS.find((p) => p.mins === confirmingMins);

  return (
    <main className="flex w-full max-w-full flex-col overflow-x-hidden bg-background text-foreground">
      {/* Header */}
      <header className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <LockSimple weight="bold" className="size-3.5" />
          </span>
          <h1 className="m-0 text-sm font-semibold tracking-tight">SmartBlocker</h1>
        </div>
        <Button
          id="open-options"
          variant="ghost"
          size="icon"
          onClick={handleOpenOptions}
          title="Open settings"
          aria-label="Open settings"
        >
          <GearSix className="size-4" />
        </Button>
      </header>

      <div className="flex flex-col gap-3 p-4">
        {/* Status — the focal element */}
        <div
          id="lock-line"
          role="status"
          style={{ display: settingsLocked ? 'flex' : 'none' }}
          className="items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/10 px-3.5 py-3 text-[13px] font-medium text-accent-soft"
        >
          <LockSimple weight="fill" className="mt-0.5 size-4 shrink-0 text-accent" />
          <span className="tabular-nums">{lockText}</span>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-3.5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span
                aria-hidden
                className={`size-2 rounded-full ${enabled ? 'bg-success' : 'bg-faint'}`}
              />
              {enabled ? 'Blocking on' : 'Paused'}
            </span>
            <span className="text-xs text-muted-foreground">
              {enabled
                ? `Checking every site except ${allowedCount} allowed`
                : 'Nothing is being blocked right now'}
            </span>
          </div>
          <Switch
            id="popup-enabled-toggle"
            checked={enabled}
            disabled={settingsLocked}
            onChange={handleToggleEnabled}
            aria-label="Block distracting pages"
          />
        </div>

        {/* Focus */}
        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5">
          <div className="flex items-center justify-between">
            <label htmlFor="focus-goal" className="text-[13px] font-medium">
              What are you working on?
            </label>
            {savedFocusGoal && (
              <Badge variant="commit" dot>
                Focusing
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              id="focus-goal"
              value={focusGoal}
              disabled={settingsLocked}
              onChange={(e) => setFocusGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmitFocusGoal();
                }
              }}
              placeholder="e.g. Studying for my Rust exam"
              className="h-8 text-[13px]"
            />
            <Button
              id="save-focus-goal"
              variant={focusClearPending ? 'ghost' : 'secondary'}
              size="sm"
              disabled={settingsLocked}
              onClick={handleSubmitFocusGoal}
              className="shrink-0"
            >
              {focusClearPending ? 'Clear' : 'Set'}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="use-tab-context"
              className="cursor-pointer text-xs text-muted-foreground select-none"
            >
              Use my open tabs as context
            </label>
            <Switch
              id="use-tab-context"
              checked={useTabContext}
              disabled={settingsLocked}
              onChange={handleToggleTabContext}
            />
          </div>
        </section>

        {/* Frozen Turkey */}
        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium">Frozen Turkey</span>
              <span className="text-xs text-muted-foreground">Force blocking on. Can't be undone.</span>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background p-0.5">
              {FROZEN_PRESETS.map(({ mins, label }) => {
                const isConfirming = confirmingMins === mins;
                return (
                  <button
                    key={mins}
                    type="button"
                    data-mins={mins}
                    aria-pressed={isConfirming}
                    onClick={() => void handleFrozenClick(mins, label)}
                    className={`frozen-btn h-7 min-w-10 cursor-pointer rounded-md px-2 text-xs font-medium tabular-nums transition-colors ${
                      isConfirming
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {isConfirming ? 'Sure?' : label}
                  </button>
                );
              })}
            </div>
          </div>
          {confirmingPreset && (
            <p className="m-0 text-xs text-accent-soft">
              Click again to lock for {confirmingPreset.label}. You won't be able to cancel it.
            </p>
          )}
        </section>

        {/* Missed one? */}
        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">Should this tab have been blocked?</span>
            <span className="text-xs text-muted-foreground">Pick what it is — SmartBlocker learns from it.</span>
          </div>
          <div className="flex items-center gap-2">
            <Select
              id="report-category"
              aria-label="Category"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              disabled={settingsLocked}
              className="h-8 flex-1 text-[13px]"
            >
              {labels.map((label) => (
                <option key={label} value={label}>
                  {label.charAt(0).toUpperCase() + label.slice(1)}
                </option>
              ))}
            </Select>
            <Button
              id="report-fn"
              variant="secondary"
              size="sm"
              onClick={() => void handleReportFn()}
              disabled={settingsLocked}
              title={
                settingsLocked
                  ? 'Locked — corrections are disabled until the lock ends'
                  : 'Records a correction SmartBlocker learns from'
              }
              className="shrink-0"
            >
              Report
            </Button>
          </div>
        </section>

        <div id="status" role="status" className="min-h-4 px-0.5 text-xs text-muted-foreground">
          {statusText}
        </div>
      </div>

      {/* Diagnostics — demoted, but visible (e2e clicks these) */}
      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-faint">Diagnostics</span>
          <div className="flex items-center gap-0.5">
            <Button id="test-pair" variant="ghost" size="xs" onClick={() => void handleTestPair()}>
              <Flask className="size-3.5" />
              Test
            </Button>
            <Button id="scan-history" variant="ghost" size="xs" onClick={() => void handleScanHistory()}>
              <ClockCounterClockwise className="size-3.5" />
              History
            </Button>
            <Button id="latency-log" variant="ghost" size="xs" onClick={() => void handleLatencyLog()}>
              <Gauge className="size-3.5" />
              Latency
            </Button>
          </div>
        </div>
        <pre
          id="out"
          className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-2.5 font-mono text-[11px] leading-relaxed tabular-nums text-muted-foreground empty:hidden"
        >
          {outText}
        </pre>
      </footer>
    </main>
  );
}
