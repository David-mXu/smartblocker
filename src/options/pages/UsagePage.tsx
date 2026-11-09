import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadSimple, Trash } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import type { UsageStatsResponse } from '../../shared/messages';
import {
  emptyUsageBlockCounts,
  localUsageDate,
  summarizeUsageStats,
  USAGE_STATS_OTHER_CATEGORIES_BUCKET,
  USAGE_STATS_OTHER_SITES_BUCKET,
  USAGE_STATS_RETENTION_DAYS,
  type UsageBlockCounts,
  type UsageBucket,
  type UsageStatsExport,
  type UsageSummary,
} from '../../shared/usage-stats';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Select } from '../../components/ui/select';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

const TOP_N = 8;

const REASONS: {
  key: keyof UsageBlockCounts;
  label: string;
  description: string;
  barClass: string;
  swatchClass: string;
}[] = [
  {
    key: 'classifier',
    label: 'Classifier',
    description: 'The local model recognised a distraction.',
    barClass: 'bg-foreground/75',
    swatchClass: 'bg-foreground/75',
  },
  {
    key: 'deterministic',
    label: 'Your rules',
    description: 'A site, URL, or title rule matched instantly.',
    barClass: 'bg-muted-foreground/70',
    swatchClass: 'bg-muted-foreground/70',
  },
  {
    key: 'channel',
    label: 'Channels',
    description: 'A channel rule matched.',
    barClass: 'bg-warning/70',
    swatchClass: 'bg-warning/70',
  },
  {
    key: 'adult',
    label: 'Adult sites',
    description: 'The opt-in adult-site rule matched.',
    barClass: 'bg-warning',
    swatchClass: 'bg-warning',
  },
  {
    key: 'failClosed',
    label: 'Fail-closed',
    description: 'The classifier was unavailable during a hard lock.',
    barClass: 'bg-destructive/70',
    swatchClass: 'bg-destructive/70',
  },
  {
    key: 'unknown',
    label: 'Before upgrade',
    description: 'A block recorded before reason tracking shipped.',
    barClass: 'bg-faint/50',
    swatchClass: 'bg-faint/50',
  },
];

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

function formatChartDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(year, month - 1, date),
  );
}

function dayOffset(dayCount: number): string {
  const now = new Date();
  return localUsageDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayCount).getTime(),
  );
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

function bucketLabel(name: string): string {
  if (name === USAGE_STATS_OTHER_SITES_BUCKET) return 'Other sites (combined)';
  if (name === USAGE_STATS_OTHER_CATEGORIES_BUCKET) return 'Other categories (combined)';
  return name;
}

function isOtherBucket(name: string): boolean {
  return name === USAGE_STATS_OTHER_SITES_BUCKET || name === USAGE_STATS_OTHER_CATEGORIES_BUCKET;
}

function totalBlocks(blocks: UsageBlockCounts): number {
  return (
    blocks.classifier +
    blocks.deterministic +
    blocks.channel +
    blocks.adult +
    blocks.failClosed +
    blocks.unknown
  );
}

function coverage(summary: UsageSummary): number | null {
  const known = summary.protection.protectedMs + summary.protection.unprotectedMs;
  if (known <= 0) return null;
  return summary.protection.protectedMs / known;
}

interface ChartDay {
  date: string;
  blocks: UsageBlockCounts;
  total: number;
}

function buildChartDays(data: UsageStatsExport | null, now: number, dayCount: number): ChartDay[] {
  const today = new Date(now);
  if (!Number.isFinite(today.getTime())) return [];
  const byDate = new Map((data?.days ?? []).map((day) => [day.date, day]));
  const result: ChartDay[] = [];
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const date = localUsageDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).getTime(),
    );
    const day = byDate.get(date);
    const blocks = day?.blocks ?? emptyUsageBlockCounts();
    result.push({ date, blocks, total: totalBlocks(blocks) });
  }
  return result;
}

function UsageChart({ days }: { days: ChartDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.total));
  const labelEvery = days.length > 14 ? 7 : 1;
  const summary = days
    .filter((day) => day.total > 0)
    .map((day) => `${formatChartDay(day.date)}: ${day.total}`)
    .join(', ');

  return (
    <div className="flex flex-col gap-2">
      <div
        id="usage-chart"
        role="img"
        aria-label={summary ? `Daily blocked pages: ${summary}` : 'No blocked pages in this range.'}
        className="flex flex-col gap-2"
      >
        <div aria-hidden className="flex h-36 items-end gap-1">
          {days.map((day) => (
            <div
              key={day.date}
              data-day={day.date}
              className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${formatDay(day.date)} — ${day.total} blocked`}
            >
              <div
                className={cn(
                  'flex h-full flex-col justify-end overflow-hidden rounded-sm',
                  day.total > 0 && 'bg-muted/40',
                )}
              >
                {REASONS.map((reason) => {
                  const count = day.blocks[reason.key];
                  if (!count) return null;
                  return (
                    <div
                      key={reason.key}
                      className={cn('w-full shrink-0', reason.barClass)}
                      style={{ height: `${(count / max) * 100}%` }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div aria-hidden className="flex gap-1">
          {days.map((day, index) => (
            <span
              key={day.date}
              className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] tabular-nums text-faint"
            >
              {index % labelEvery === 0 || index === days.length - 1
                ? formatChartDay(day.date)
                : ''}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>Daily blocked pages by reason</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {REASONS.map((reason) => (
              <th key={reason.key} scope="col">{reason.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{formatDay(day.date)}</th>
              {REASONS.map((reason) => (
                <td key={reason.key}>{day.blocks[reason.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {REASONS.filter((reason) => reason.key !== 'unknown' || days.some((day) => day.blocks.unknown)).map(
          (reason) => (
            <span key={reason.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span aria-hidden className={cn('size-2 rounded-full', reason.swatchClass)} />
              {reason.label}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function UsageTable({
  id,
  label,
  buckets,
  showAll,
  onToggleShowAll,
  showOther,
}: {
  id: string;
  label: string;
  buckets: Record<string, UsageBucket>;
  showAll: boolean;
  onToggleShowAll: () => void;
  showOther: boolean;
}) {
  const allRows = sortedBuckets(buckets).filter(([name]) => showOther || !isOtherBucket(name));
  const rows = showAll ? allRows : allRows.slice(0, TOP_N);
  const hiddenCount = allRows.length - rows.length;
  const toggleId = `${id}-toggle`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[13px] font-medium text-foreground">{label}</h3>
        {allRows.length > TOP_N && (
          <Button
            id={toggleId}
            size="xs"
            variant="ghost"
            aria-expanded={showAll}
            onClick={onToggleShowAll}
          >
            {showAll ? `Show top ${TOP_N}` : `Show all ${allRows.length}`}
          </Button>
        )}
      </div>
      <div id={id} className="overflow-x-auto rounded-lg border border-border bg-background">
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">{label}</caption>
          <thead className="text-xs text-faint">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium">
                {label === 'Sites' ? 'Site' : 'Category'}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Active</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Silenced</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Overrides</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length ? (
              rows.map(([name, bucket]) => (
                <tr key={name}>
                  <th
                    scope="row"
                    className="max-w-[240px] truncate px-3 py-2.5 font-mono text-xs font-normal text-foreground"
                    title={bucketLabel(name)}
                  >
                    {bucketLabel(name)}
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
      {hiddenCount > 0 && (
        <p className="m-0 text-[11px] text-faint">
          {hiddenCount} more{' '}
          {label === 'Sites'
            ? hiddenCount === 1 ? 'site' : 'sites'
            : hiddenCount === 1 ? 'category' : 'categories'}{' '}
          hidden. Totals above still include them.
        </p>
      )}
    </div>
  );
}

function ReasonBreakdown({ blocks }: { blocks: UsageBlockCounts }) {
  const total = totalBlocks(blocks);
  return (
    <div className="flex flex-col gap-2">
      {REASONS.map((reason) => {
        const count = blocks[reason.key];
        const share = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={reason.key} className="grid grid-cols-[minmax(0,1fr)_4rem_3rem] items-center gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', reason.swatchClass)} />
              <span className="truncate text-[13px] text-foreground">{reason.label}</span>
              <span className="hidden truncate text-[11px] text-faint min-[520px]:inline">
                {reason.description}
              </span>
            </div>
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', reason.barClass)} style={{ width: `${share}%` }} />
            </div>
            <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type UsageTab = 'blocks' | 'websites';

export function UsagePage({ state }: { state: OptionsState }) {
  const { flash } = state;
  const today = localUsageDate(Date.now());
  const yesterday = dayOffset(-1);
  const [data, setData] = useState<UsageStatsExport | null>(null);
  const [selectedDate, setSelectedDate] = useState(today);
  const [rangeDays, setRangeDays] = useState<7 | 35>(7);
  const [tab, setTab] = useState<UsageTab>('blocks');
  const [showAllSites, setShowAllSites] = useState(false);
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [showOther, setShowOther] = useState(true);
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
    const values = new Set<string>([today, yesterday]);
    for (const day of data?.days ?? []) values.add(day.date);
    return [...values].sort((a, b) => b.localeCompare(a));
  }, [data, today, yesterday]);

  useEffect(() => {
    if (!dates.includes(selectedDate)) setSelectedDate(dates[0] ?? today);
  }, [dates, selectedDate, today]);

  const now = Date.now();
  const summary = data ? summarizeUsageStats(data, now, rangeDays) : null;
  const selectedDay = data?.days.find((day) => day.date === selectedDate);
  const chartDays = useMemo(() => buildChartDays(data, now, rangeDays), [data, now, rangeDays]);
  const activeCoverage = summary ? coverage(summary) : null;

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

  const moveTab = (next: UsageTab) => {
    setTab(next);
    const id = next === 'blocks' ? 'usage-tab-blocks' : 'usage-tab-websites';
    document.getElementById(id)?.focus();
  };

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveTab(tab === 'blocks' ? 'websites' : 'blocks');
    }
  };

  return (
    <Page
      title="Usage"
      description="Approximate browser activity and blocking decisions, computed locally from tab events — never from browser history. Desktop-app usage is tracked separately."
    >
      <SettingsSection
        title="Protection overview"
        description={`${rangeDays === 7 ? 'Last 7' : 'Last 35'} local days, including today. Lock and break values are portions of active time, not additional time.`}
        aside={
          <div
            role="group"
            aria-label="Summary range"
            className="flex rounded-lg border border-border bg-muted p-0.5"
          >
            {([7, 35] as const).map((days) => (
              <button
                key={days}
                id={`usage-range-${days}`}
                type="button"
                aria-pressed={rangeDays === days}
                onClick={() => setRangeDays(days)}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs font-medium transition-colors',
                  rangeDays === days
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {days} days
              </button>
            ))}
          </div>
        }
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
            description="Distinct page or navigation decisions that became blocked. Repeated heartbeats of the same screen count once; the reason breakdown below still adds up to this total."
          />
          <SettingRow
            label="Correction rate"
            description="Completed block-screen overrides ÷ pages silenced. A dash means there were no silenced pages; older saved allow rules are not new overrides."
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
          <SettingRow
            stacked
            label="Protection coverage"
            description="Share of active time with a recorded protection state that had blocking on. “On” means the master switch is enabled or a lock is forcing blocking; it does not mean the current page was blocked."
            control={
              <span id="usage-protection-coverage" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {summary ? formatRate(activeCoverage) : '—'}
              </span>
            }
          >
            {summary && (
              <p className="m-0 text-xs tabular-nums text-faint">
                <span id="usage-protected-time">{formatDuration(summary.protection.protectedMs)}</span> protected ·{' '}
                <span id="usage-unprotected-time">{formatDuration(summary.protection.unprotectedMs)}</span> unprotected
                {summary.protection.unknownMs > 0 && (
                  <> · {formatDuration(summary.protection.unknownMs)} before upgrade</>
                )}
              </p>
            )}
          </SettingRow>
          <SettingRow
            label="Time under lock"
            description="Active time inside a focus session, timer, password, schedule, or other lock. Already included in active time."
            control={
              <span id="usage-locked-time" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {summary ? formatDuration(summary.protection.lockedMs) : '—'}
              </span>
            }
          />
          <SettingRow
            label="Break relief"
            description="Active time inside a break. Breaks relax classifier blocks only; deterministic rules and fail-closed results stay blocked."
            control={
              <span id="usage-break-time" className="font-mono text-sm font-medium tabular-nums text-foreground">
                {summary ? formatDuration(summary.protection.breakMs) : '—'}
              </span>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Daily activity"
        description="Block reasons are disjoint; site and category totals are grouped by local calendar day."
      >
        <SettingsGroup>
          <div role="tablist" aria-label="Usage detail" className="flex gap-1 px-4 pt-3">
            {([
              ['blocks', 'Blocks', 'usage-tab-blocks', 'usage-panel-blocks'],
              ['websites', 'Sites and categories', 'usage-tab-websites', 'usage-panel-websites'],
            ] as const).map(([id, label, buttonId, panelId]) => (
              <button
                key={id}
                id={buttonId}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={panelId}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={handleTabKey}
                className={cn(
                  'h-8 rounded-md px-3 text-[13px] font-medium transition-colors',
                  tab === id
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            id="usage-panel-blocks"
            role="tabpanel"
            aria-labelledby="usage-tab-blocks"
            hidden={tab !== 'blocks'}
            className="flex flex-col gap-4 px-4 py-3.5"
          >
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] font-medium text-foreground">Daily blocks</h3>
              <p className="m-0 text-[13px] text-muted-foreground">
                Stacked by why the page was blocked across the selected range.
              </p>
            </div>
            <UsageChart days={chartDays} />
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] font-medium text-foreground">Why pages were blocked</h3>
              <p className="m-0 text-[13px] text-muted-foreground">
                One class per block trigger; the counts add up to pages silenced for the same range.
              </p>
            </div>
            <ReasonBreakdown blocks={summary?.blocks ?? emptyUsageBlockCounts()} />
          </div>

          <div
            id="usage-panel-websites"
            role="tabpanel"
            aria-labelledby="usage-tab-websites"
            hidden={tab !== 'websites'}
            className="flex flex-col gap-4 px-4 py-3.5"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-[13px] font-medium text-foreground">Day detail</h3>
                <p className="m-0 text-[13px] text-muted-foreground">
                  Hostname and category totals for one local calendar day.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label="Day presets" className="flex gap-1">
                  <Button
                    id="usage-day-today"
                    size="xs"
                    variant={selectedDate === today ? 'secondary' : 'ghost'}
                    aria-pressed={selectedDate === today}
                    onClick={() => setSelectedDate(today)}
                  >
                    Today
                  </Button>
                  <Button
                    id="usage-day-yesterday"
                    size="xs"
                    variant={selectedDate === yesterday ? 'secondary' : 'ghost'}
                    aria-pressed={selectedDate === yesterday}
                    onClick={() => setSelectedDate(yesterday)}
                  >
                    Yesterday
                  </Button>
                </div>
                <label htmlFor="usage-day" className="sr-only">Choose a day</label>
                <Select
                  id="usage-day"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="w-auto max-w-full"
                >
                  {dates.map((day) => (
                    <option key={day} value={day}>{formatDay(day)}</option>
                  ))}
                </Select>
              </div>
            </div>

            {selectedDay ? (
              <p className="m-0 text-xs tabular-nums text-faint">
                {formatDuration(selectedDay.totals.activeMs)} active · {selectedDay.totals.pagesSilenced} silenced ·{' '}
                {selectedDay.totals.overrides} overrides
              </p>
            ) : (
              <p className="m-0 text-xs text-faint">No activity recorded for this day.</p>
            )}

            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                id="usage-show-other"
                checked={showOther}
                onChange={(event) => setShowOther(event.target.checked)}
              />
              Show combined “other” rows
            </label>

            <UsageTable
              id="usage-sites"
              label="Sites"
              buckets={selectedDay?.sites ?? {}}
              showAll={showAllSites}
              onToggleShowAll={() => setShowAllSites((value) => !value)}
              showOther={showOther}
            />
            <UsageTable
              id="usage-categories"
              label="Categories"
              buckets={selectedDay?.categories ?? {}}
              showAll={showAllCategories}
              onToggleShowAll={() => setShowAllCategories((value) => !value)}
              showOther={showOther}
            />
            <p className="m-0 text-[11px] text-faint">
              Top {TOP_N} rows are shown by default by active time; “other” rows are explicit overflow
              buckets, not a privacy-redacted list. Only hostnames are stored, never URLs or page titles.
            </p>
          </div>
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
            description="Only hostnames, categories, time totals, protection/lock/break annotations, reason counters, and bounded opaque duplicate-suppression IDs are stored — never full URLs, paths, query strings, page titles, scores, or rule text. Incognito/private activity is intentionally included when the extension can run there. Clearing browser history does not clear these aggregates; Clear usage below does. Collection resumes with new activity after clearing."
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
              Clear usage permanently removes all local usage aggregates from this browser profile. It does not clear
              browser history, corrections, or settings.
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
