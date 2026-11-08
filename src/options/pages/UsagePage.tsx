import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadSimple, Trash } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import type { UsageStatsResponse } from '../../shared/messages';
import {
  localUsageDate,
  summarizeUsageStats,
  USAGE_STATS_OTHER_CATEGORIES_BUCKET,
  USAGE_STATS_OTHER_SITES_BUCKET,
  USAGE_STATS_RETENTION_DAYS,
  type UsageBucket,
  type UsageStatsExport,
} from '../../shared/usage-stats';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/select';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year, month - 1, date));
}

function sortedBuckets(map: Record<string, UsageBucket>): [string, UsageBucket][] {
  return Object.entries(map).sort(
    ([aName, a], [bName, b]) =>
      b.activeMs - a.activeMs ||
      b.pagesSilenced - a.pagesSilenced ||
      b.overrides - a.overrides ||
      aName.localeCompare(bName),
  );
}

function UsageTable({
  id,
  label,
  buckets,
}: {
  id: string;
  label: string;
  buckets: Record<string, UsageBucket>;
}) {
  const rows = sortedBuckets(buckets);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-[13px] font-medium text-foreground">{label}</h3>
      <div id={id} className="overflow-x-auto rounded-lg border border-border bg-background">
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">{label}</caption>
          <thead className="text-xs text-faint">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium">{label === 'Sites' ? 'Site' : 'Category'}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Active</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Silenced</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Overrides</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length ? (
              rows.map(([name, bucket]) => (
                <tr key={name}>
                  <th scope="row" className="max-w-[240px] truncate px-3 py-2.5 font-mono text-xs font-normal text-foreground" title={name}>
                    {name === USAGE_STATS_OTHER_SITES_BUCKET
                      ? 'Other sites (combined)'
                      : name === USAGE_STATS_OTHER_CATEGORIES_BUCKET
                        ? 'Other categories (combined)'
                        : name}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDuration(bucket.activeMs)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {bucket.pagesSilenced}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {bucket.overrides}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-3 py-5 text-center text-xs text-faint">
                  No activity recorded for this day.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsagePage({ state }: { state: OptionsState }) {
  const { flash } = state;
  const today = localUsageDate(Date.now());
  const [data, setData] = useState<UsageStatsExport | null>(null);
  const [selectedDate, setSelectedDate] = useState(today);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [clearStage, setClearStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const response = (await api.runtime.sendMessage({ type: 'GET_USAGE_STATS' })) as UsageStatsResponse;
      if (!response?.ok || !response.stats) throw new Error(response?.error ?? 'No response from background');
      setData(response.stats);
      setError('');
      return response.stats;
    } catch (cause) {
      setError(`Could not load usage statistics: ${String(cause)}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [load]);

  const dates = useMemo(() => {
    const values = new Set<string>([today]);
    for (const day of data?.days ?? []) values.add(day.date);
    return [...values].sort((a, b) => b.localeCompare(a));
  }, [data, today]);

  useEffect(() => {
    if (!dates.includes(selectedDate)) setSelectedDate(dates[0] ?? today);
  }, [dates, selectedDate, today]);

  const summary = data ? summarizeUsageStats(data, Date.now(), 7) : null;
  const selectedDay = data?.days.find((day) => day.date === selectedDate);

  const handleExport = async () => {
    setExporting(true);
    const latest = await load();
    if (latest) {
      const blob = new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `smartblocker-usage-${localUsageDate(Date.now())}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    setExporting(false);
  };

  const handleClear = async () => {
    if (clearStage === 'idle') {
      setClearStage('confirm');
      clearTimer.current = setTimeout(() => setClearStage('idle'), 5000);
      return;
    }
    if (clearStage !== 'confirm') return;
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setClearStage('busy');
    try {
      const response = (await api.runtime.sendMessage({ type: 'CLEAR_USAGE_STATS' })) as UsageStatsResponse;
      if (!response?.ok || !response.stats) throw new Error(response?.error ?? 'No response from background');
      setData(response.stats);
      setSelectedDate(localUsageDate(Date.now()));
      setError('');
      flash('Usage statistics cleared');
    } catch (cause) {
      setError(`Could not clear usage statistics: ${String(cause)}`);
    } finally {
      setClearStage('idle');
    }
  };

  return (
    <Page
      title="Usage"
      description="Approximate active time and blocking decisions, computed from tab activity on this device — never from browser history."
    >
      <SettingsSection
        title="Pages silenced this week"
        description="The last 7 local days, including today. Active time is checkpoint-based and can conservatively undercount interruptions."
      >
        <SettingsGroup aria-busy={loading}>
          <SettingRow
            label={
              <span className="flex items-baseline gap-2">
                <span id="usage-pages-silenced" className="font-mono text-xl font-semibold tabular-nums">
                  {summary?.totals.pagesSilenced ?? '—'}
                </span>
                <span>pages silenced</span>
              </span>
            }
            description="Distinct page or navigation decisions that became blocked. Repeated heartbeats of the same screen count once."
          />
          <SettingRow
            label="Override rate"
            description="Completed block-screen overrides ÷ pages silenced this week. A dash means there were no silenced pages; older saved allow rules are not new overrides."
            control={
              <span id="usage-override-rate" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {summary ? formatRate(summary.overrideRate) : '—'}
              </span>
            }
          />
          <SettingRow
            label="Active time"
            description="Only the focused window’s active http/https tab while the system reports active. Idle, background, shutdown, and stale checkpoint gaps are not charged."
            control={
              <span id="usage-active-time" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {summary ? formatDuration(summary.totals.activeMs) : '—'}
              </span>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Daily activity" description="Hostname and category totals are grouped by local calendar day.">
        <SettingsGroup>
          <SettingRow
            stacked
            label="Site and category totals"
            htmlFor="usage-day"
            description="Active time is approximate; silenced pages and overrides are event counters."
            control={
              <Select id="usage-day" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="w-auto max-w-full">
                {dates.map((day) => (
                  <option key={day} value={day}>{formatDay(day)}</option>
                ))}
              </Select>
            }
          >
            {selectedDay && (
              <p className="m-0 text-xs tabular-nums text-faint">
                {formatDuration(selectedDay.totals.activeMs)} active · {selectedDay.totals.pagesSilenced} silenced · {selectedDay.totals.overrides} overrides
              </p>
            )}
            <UsageTable id="usage-sites" label="Sites" buckets={selectedDay?.sites ?? {}} />
            <UsageTable id="usage-categories" label="Categories" buckets={selectedDay?.categories ?? {}} />
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Local data"
        description={`Daily aggregates are kept for ${USAGE_STATS_RETENTION_DAYS} local days, then pruned. Nothing here is uploaded.`}
      >
        <SettingsGroup>
          <SettingRow
            stacked
            label="Usage statistics stay in this browser profile"
            description="Only hostnames, categories, time totals, decision counters, and bounded opaque duplicate-suppression IDs are stored — never full URLs, paths, query strings, page titles, or a page-history log. Incognito/private activity is intentionally included when the extension can run there. Clearing browser history does not clear these aggregates; Clear usage below does. Collection resumes with new activity after clearing."
            control={
              <div className="flex flex-wrap gap-2">
                <Button id="usage-export" size="sm" disabled={exporting || loading} onClick={() => void handleExport()}>
                  <DownloadSimple className="size-3.5" />
                  {exporting ? 'Preparing…' : 'Export JSON'}
                </Button>
                <Button
                  id="usage-clear"
                  variant={clearStage === 'confirm' ? 'destructive' : 'secondary'}
                  size="sm"
                  disabled={clearStage === 'busy' || !data?.days.length}
                  onClick={() => void handleClear()}
                >
                  <Trash className="size-3.5" />
                  {clearStage === 'busy'
                    ? 'Clearing…'
                    : clearStage === 'confirm'
                      ? 'Click again to clear'
                      : 'Clear usage'}
                </Button>
              </div>
            }
          >
            <p className="m-0 text-xs text-faint">
              Clear usage permanently removes all local usage aggregates from this browser profile. It does not clear browser history, corrections, or settings.
            </p>
            <div id="usage-status" role="status" aria-live="polite" className="empty:hidden">
              {loading && <p className="m-0 text-xs text-muted-foreground">Loading local usage…</p>}
              {error && <p className="m-0 text-xs text-destructive-soft">{error}</p>}
            </div>
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
