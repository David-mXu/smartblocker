import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  ShieldCheck,
  LockKey,
  Crosshair,
  Snowflake,
  Flask,
  ClockCounterClockwise,
  Gauge,
  GearSix,
  WarningCircle,
  Sparkle,
} from '@phosphor-icons/react';
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

gsap.registerPlugin(useGSAP);

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
  const containerRef = useRef<HTMLDivElement>(null);

  const [focusGoal, setFocusGoal] = useState('');
  const [savedFocusGoal, setSavedFocusGoal] = useState('');
  const [useTabContext, setUseTabContext] = useState(true);
  const [labels, setLabels] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');

  const [settingsLocked, setSettingsLocked] = useState(false);
  const [lockText, setLockText] = useState('');
  const [confirmingMins, setConfirmingMins] = useState<number | null>(null);

  const [statusText, setStatusText] = useState('');
  const [outText, setOutText] = useState(
    'First "Test Pair" click downloads the model (~34MB) — watch the background console for progress.',
  );

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useGSAP(
    () => {
      gsap.from('.hud-panel', {
        y: 10,
        opacity: 0,
        duration: 0.45,
        stagger: 0.06,
        ease: 'power3.out',
      });
    },
    { scope: containerRef },
  );

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

    return () => {
      clearInterval(lockInterval);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
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
    setStatusText('Classifying... (first run downloads the model)');
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

  return (
    <main
      ref={containerRef}
      className="relative overflow-x-hidden w-full max-w-full min-h-[480px] bg-[#070709] text-zinc-50 p-4 flex flex-col gap-3.5"
    >
      {/* Ambient radial light */}
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-48 w-72 rounded-full bg-emerald-500/10 blur-3xl" />

      {/* Header bar */}
      <header className="hud-panel relative z-10 flex items-center justify-between border-b border-zinc-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900 text-zinc-100 shadow-inner">
            <ShieldCheck weight="duotone" className="h-4.5 w-4.5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-zinc-50 leading-none">
              SmartBlocker
            </h1>
            <p className="mt-1 text-[11px] font-mono text-zinc-400 leading-none">
              BGE-Small Local Centroid Engine
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={settingsLocked ? 'crimson' : 'emerald'} className="text-[11px]">
            {settingsLocked ? 'Locked' : 'Armed'}
          </Badge>
          <Button
            id="open-options"
            variant="secondary"
            size="sm"
            onClick={handleOpenOptions}
            className="h-7 px-2.5 text-xs"
            title="Open full Command Center"
          >
            <GearSix className="h-3.5 w-3.5" />
            Options
          </Button>
        </div>
      </header>

      {/* Active lock status line */}
      <div
        id="lock-line"
        style={{ display: settingsLocked ? 'flex' : 'none' }}
        className="hud-panel items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/12 px-3 py-2 text-xs font-medium text-red-200"
      >
        <LockKey weight="fill" className="h-4 w-4 shrink-0 text-red-400" />
        <span>{lockText}</span>
      </div>

      {/* Current Focus Context (System 1.5) */}
      <section className="hud-panel rounded-xl border border-zinc-800/90 bg-[#0d0d12]/90 p-3.5 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <label
            htmlFor="focus-goal"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-tight text-zinc-200"
          >
            <Crosshair className="h-3.5 w-3.5 text-emerald-400" />
            Current Focus Intention
          </label>
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
            System 1.5
          </span>
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
            placeholder="Current focus goal (e.g. Studying Rust)..."
            className="h-8 text-xs"
          />
          <Button
            id="save-focus-goal"
            variant={focusClearPending ? 'secondary' : 'default'}
            size="sm"
            disabled={settingsLocked}
            onClick={handleSubmitFocusGoal}
            className="h-8 px-3 text-xs shrink-0"
          >
            {focusClearPending ? 'Clear' : 'Set'}
          </Button>
        </div>
        <div className="mt-2.5 flex items-center justify-between pt-2 border-t border-zinc-800/60">
          <label
            htmlFor="use-tab-context"
            className="text-[11px] text-zinc-400 cursor-pointer select-none"
          >
            Use open tabs for context disambiguation
          </label>
          <Switch
            id="use-tab-context"
            checked={useTabContext}
            disabled={settingsLocked}
            onChange={handleToggleTabContext}
          />
        </div>
      </section>

      {/* Frozen Turkey Quick Commitment */}
      <section className="hud-panel rounded-xl border border-zinc-800/90 bg-[#0d0d12]/90 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Snowflake weight="duotone" className="h-3.5 w-3.5 text-amber-400" />
            <span
              className="text-xs font-semibold text-zinc-200"
              title="Force blocking ON for a set time — uncancellable"
            >
              Frozen Turkey
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {FROZEN_PRESETS.map(({ mins, label }) => {
              const isConfirming = confirmingMins === mins;
              return (
                <button
                  key={mins}
                  type="button"
                  data-mins={mins}
                  onClick={() => void handleFrozenClick(mins, label)}
                  className={`frozen-btn inline-flex items-center justify-center rounded-md px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
                    isConfirming
                      ? 'bg-red-500 text-zinc-950 font-semibold shadow-[0_0_16px_rgba(239,68,68,0.35)]'
                      : 'border border-zinc-700/80 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  {isConfirming ? 'Sure? Uncancellable' : label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* False-negative active tab training */}
      <section className="hud-panel rounded-xl border border-zinc-800/90 bg-[#0d0d12]/90 p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <WarningCircle className="h-3.5 w-3.5 text-zinc-400" />
          <span className="text-[11px] font-medium text-zinc-300">
            Active Tab Centroid Correction
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Select
            id="report-category"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            disabled={settingsLocked}
            className="h-8 flex-1 min-w-0 text-xs py-1 px-2.5"
          >
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
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
            className="h-8 px-2.5 text-xs shrink-0"
          >
            Should've been blocked
          </Button>
        </div>
      </section>

      {/* Diagnostics & Telemetry Actions */}
      <section className="hud-panel flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-1.5">
          <Button
            id="test-pair"
            variant="default"
            size="sm"
            onClick={() => void handleTestPair()}
            className="h-8 text-xs px-2"
          >
            <Flask weight="bold" className="h-3.5 w-3.5" />
            Test Pair
          </Button>
          <Button
            id="scan-history"
            variant="secondary"
            size="sm"
            onClick={() => void handleScanHistory()}
            className="h-8 text-xs px-2"
          >
            <ClockCounterClockwise className="h-3.5 w-3.5" />
            Scan History
          </Button>
          <Button
            id="latency-log"
            variant="secondary"
            size="sm"
            onClick={() => void handleLatencyLog()}
            className="h-8 text-xs px-2"
          >
            <Gauge className="h-3.5 w-3.5" />
            Latency Log
          </Button>
        </div>

        {/* Status feedback line */}
        <div
          id="status"
          className="min-h-[16px] text-[11px] font-medium text-emerald-400 px-0.5"
        >
          {statusText}
        </div>

        {/* Telemetry Console */}
        <div className="relative rounded-xl border border-zinc-800/90 bg-[#050507] p-3">
          <div className="flex items-center justify-between mb-1.5 pb-1.5 border-b border-zinc-900">
            <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
              <Sparkle className="h-3 w-3 text-zinc-400" />
              Inference & Telemetry Stream
            </span>
            <span className="text-[10px] font-mono text-zinc-600">q8 / WASM</span>
          </div>
          <pre
            id="out"
            className="m-0 max-h-[190px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300"
          >
            {outText}
          </pre>
        </div>
      </section>
    </main>
  );
}
