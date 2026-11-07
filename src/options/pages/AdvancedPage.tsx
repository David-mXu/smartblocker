import React, { useEffect, useRef, useState } from 'react';
import { Flask, ClockCounterClockwise, Gauge } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import type { HistoryScanState, LatencySample, TestPairResponse } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { pct } from '../format';
import { LockedNote, Page } from './Page';
import { presetFor } from './BlockingPage';

export function AdvancedPage({ state }: { state: OptionsState }) {
  const { settings, lock, save } = state;
  const locked = lock.locked;

  // Slider drafts locally and persists on release-equivalent change events.
  const [threshold, setThreshold] = useState<number | null>(null);
  useEffect(() => {
    if (settings) setThreshold(settings.blockThreshold);
  }, [settings?.blockThreshold]);

  // Diagnostics — logic and output formats carried over verbatim from the
  // old popup footer (the e2e suites parse #out).
  const [statusText, setStatusText] = useState('');
  const [outText, setOutText] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(
    () => () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    },
    [],
  );

  if (!settings || threshold === null) return null;

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
          const dist = r.all.labels.map((l, i) => `  ${pct(r.all.scores[i]).padStart(4)} ${l}`).join('\n');
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
      renderScan(historyScan as HistoryScanState | undefined);
      if (historyScan && (historyScan as HistoryScanState).status !== 'running') {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setStatusText('');
      }
    }, 1000);
  };

  const handleLatencyLog = async () => {
    setStatusText('');
    const { latencySamples = [] } = await api.storage.local.get('latencySamples');
    if (!(latencySamples as LatencySample[]).length) {
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

  const preset = presetFor(threshold);

  return (
    <Page
      title="Advanced"
      description="Fine-tuning and troubleshooting. Most people never need this page."
    >
      <SettingsSection title="Sensitivity">
        <SettingsGroup>
          <SettingRow
            stacked
            label="Exact blocking threshold"
            htmlFor="threshold"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                <>
                  A page is blocked when SmartBlocker is at least this sure it's a distraction.{' '}
                  {preset ? (
                    <>
                      Matches the <span className="text-foreground">{preset.name}</span> level on{' '}
                      <a href="#blocking" className="text-foreground underline underline-offset-2">
                        Blocking
                      </a>
                      .
                    </>
                  ) : (
                    'Shows as Custom on the Blocking page.'
                  )}
                </>
              )
            }
            control={
              <span id="threshold-val" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {pct(threshold)}
              </span>
            }
          >
            <div className="flex flex-col gap-1.5">
              <input
                type="range"
                id="threshold"
                min="0.3"
                max="0.9"
                step="0.05"
                value={threshold}
                disabled={locked}
                style={{ ['--fill' as string]: `${((threshold - 0.3) / 0.6) * 100}%` }}
                onChange={(e) => {
                  const next = parseFloat(e.target.value);
                  setThreshold(next);
                  void save({ blockThreshold: next });
                }}
                className="sb-range"
              />
              <div className="flex justify-between text-xs text-faint">
                <span>Stricter · blocks more</span>
                <span>Relaxed · blocks less</span>
              </div>
            </div>
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Diagnostics"
        description="Check that the on-device model works and see how fast pages are checked. Results stay on this device."
      >
        <SettingsGroup>
          <SettingRow
            label="Test classifier"
            description="Runs two sample titles through the model."
            control={
              <Button id="test-pair" variant="secondary" size="sm" onClick={() => void handleTestPair()}>
                <Flask className="size-3.5" />
                Test classifier
              </Button>
            }
          />
          <SettingRow
            label="Scan history"
            description="Raw output of the history review, with the latest titles."
            control={
              <Button id="scan-history" variant="secondary" size="sm" onClick={() => void handleScanHistory()}>
                <ClockCounterClockwise className="size-3.5" />
                Scan history
              </Button>
            }
          />
          <SettingRow
            label="Latency log"
            description="Timing for recently checked pages."
            control={
              <Button id="latency-log" variant="secondary" size="sm" onClick={() => void handleLatencyLog()}>
                <Gauge className="size-3.5" />
                Latency log
              </Button>
            }
          />
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-xs font-medium text-faint">Output</span>
              <div id="status" role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {statusText}
              </div>
            </div>
            <pre
              id="out"
              className="m-0 max-h-[360px] min-h-16 overflow-auto empty:before:text-faint empty:before:content-['Results_appear_here.'] whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed tabular-nums text-muted-foreground"
            >
              {outText}
            </pre>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
