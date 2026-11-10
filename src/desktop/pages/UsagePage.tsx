import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowsClockwise, DownloadSimple, Trash } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { Callout, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { errorText, invoke, type UsageAppTotal, type UsageSummary } from '../api';
import { friendlyAppName } from '../apps';
import { dayHeading } from '../format';
import { FormMessage, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

// Desktop app usage: local foreground-app active time. Deliberately a
// separate page from Activity (what the companion did) — this one is what
// the user did. Same one-surface Lamplight layout as the other pages.

const PERIODS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 35, label: '35 days' },
] as const;

const TOP_APPS = 8;

export function UsagePage() {
  const { now } = useStatus();
  const [period, setPeriod] = useState(7);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const [clearStage, setClearStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  // Period switches can overlap: only the newest request may install a
  // summary. Without this, a slow 7-day reply can overwrite 35-day data.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (showBusy = false) => {
      const seq = ++requestSeq.current;
      if (showBusy) setLoading(true);
      try {
        const next = await invoke('get_desktop_usage', { periodDays: period });
        if (alive.current && seq === requestSeq.current) {
          setSummary(next);
          setLoadError(null);
        }
      } catch (e) {
        if (alive.current && seq === requestSeq.current) {
          setLoadError(errorText(e));
        }
      } finally {
        if (alive.current && seq === requestSeq.current) setLoading(false);
      }
    },
    [period],
  );

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  // A confirmation should not stay armed forever.
  useEffect(() => {
    if (clearStage !== 'confirm') return;
    clearTimer.current = setTimeout(() => setClearStage('idle'), 5_000);
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [clearStage]);

  const exportJson = async () => {
    setExporting(true);
    setMsg(null);
    try {
      const data = await invoke('export_desktop_usage', { periodDays: period });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `smartblocker-app-usage-${localDateStamp()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg({ tone: 'ok', text: 'Exported usage data.' });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setExporting(false);
    }
  };

  const clear = async () => {
    if (clearStage === 'idle') {
      setClearStage('confirm');
      return;
    }
    if (clearStage !== 'confirm') return;
    if (clearTimer.current) clearTimeout(clearTimer.current);
    // Invalidate any summary request that started before the clear, so a
    // pre-clear reply cannot reappear after the authoritative empty one.
    requestSeq.current += 1;
    setClearStage('busy');
    setMsg(null);
    try {
      const next = await invoke('clear_desktop_usage', { periodDays: period });
      if (alive.current) {
        setSummary(next);
        setLoadError(null);
      }
      setMsg({ tone: 'ok', text: 'App usage cleared.' });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      if (alive.current) setLoading(false);
      setClearStage('idle');
    }
  };

  const hasData = (summary?.totals.activeMs ?? 0) > 0 || (summary?.apps.length ?? 0) > 0;
  const topApps = summary?.apps.slice(0, TOP_APPS) ?? [];
  const rest = summary?.apps.slice(TOP_APPS) ?? [];

  return (
    <Page
      title="Usage"
      description="Time in the app that was in front of you, counted while you were active. It stays on this computer."
      aside={
        <div className="flex flex-col items-end gap-2">
          <div role="group" aria-label="Period" className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
            {PERIODS.map((p) => (
              <Button
                key={p.days}
                id={`usage-period-${p.days}`}
                variant={period === p.days ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={period === p.days}
                onClick={() => setPeriod(p.days)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Button
            id="usage-refresh"
            variant="ghost"
            size="xs"
            onClick={() => void load(true)}
            disabled={loading}
          >
            <ArrowsClockwise className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
            Refresh
          </Button>
        </div>
      }
    >
      {summary && !summary.available && (
        <Callout id="usage-unavailable" tone="neutral">
          The companion can’t see the foreground app on this system yet. App usage is measured
          on Windows; elsewhere this page stays empty rather than guessing.
        </Callout>
      )}

      <SettingsSection
        title="At a glance"
        description={
          summary?.available === false
            ? 'Foreground-app tracking is unavailable here.'
            : `Local day totals for ${period === 1 ? 'today' : `the last ${period} days`}.`
        }
      >
        <SettingsGroup>
          <div className="grid grid-cols-1 gap-0 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat
              id="usage-total"
              label="Active app time"
              value={summary ? formatUsage(summary.totals.activeMs) : '—'}
              hint={summary ? `${formatPercent(summary.totals.activeMs, summary.totals.wallMs)} of observed time` : undefined}
            />
            <Stat
              id="usage-wall"
              label="At the computer"
              value={summary ? formatUsage(summary.totals.wallMs) : '—'}
              hint="Awake time, including idle"
            />
            <Stat
              id="usage-top-app"
              label="Most used"
              value={topApps[0] ? friendlyAppName(topApps[0].id) : '—'}
              hint={topApps[0] ? formatUsage(topApps[0].activeMs) : 'Nothing recorded yet'}
            />
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="usage-apps-section"
        title="Top apps"
        description="Only the executable’s name is stored — never a window title, document or URL."
        aside={
          loadError && summary ? (
            <span className="text-xs text-destructive-soft" title={loadError}>
              Couldn’t refresh
            </span>
          ) : hasData ? (
            <span className="text-xs tabular-nums text-faint">{summary?.apps.length} apps</span>
          ) : undefined
        }
      >
        {summary === null ? (
          loadError ? (
            <div
              id="usage-error"
              className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-5 py-8 text-center"
            >
              <p className="m-0 text-sm font-medium">Couldn’t read app usage</p>
              <p className="m-0 max-w-[46ch] text-[13px] text-muted-foreground">{loadError}</p>
              <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={loading}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="min-h-[160px]" aria-busy="true" aria-label="Loading usage" />
          )
        ) : !hasData ? (
          <div
            id="usage-empty"
            className="flex flex-col gap-1 rounded-xl border border-dashed border-border px-5 py-8 text-center"
          >
            <p className="m-0 text-sm font-medium">Nothing recorded yet</p>
            <p className="m-0 text-[13px] text-muted-foreground">
              {summary.available
                ? 'Work in any app while SmartBlocker runs. Time adds up in five-second samples, and idle or asleep time is left out.'
                : 'Foreground-app tracking needs Windows. Nothing is guessed on this system.'}
            </p>
          </div>
        ) : (
          <SettingsGroup>
            <ul id="usage-apps" aria-label="Top apps by active time" className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {topApps.map((app, i) => (
                <AppRow key={app.id} app={app} total={summary.totals.activeMs} rank={i + 1} />
              ))}
              {rest.length > 0 && (
                <OtherRow apps={rest} total={summary.totals.activeMs} />
              )}
            </ul>
          </SettingsGroup>
        )}
      </SettingsSection>

      {summary && hasData && (
        <SettingsSection
          title="By day"
          description="Local calendar days split at midnight and daylight-saving changes. The bar and first figure are active time; the lighter figure includes idle."
        >
          <SettingsGroup>
            <ul id="usage-days" aria-label="Daily active time" className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {summary.days.map((day) => (
                <DayRow
                  key={day.date}
                  date={day.date}
                  activeMs={day.activeMs}
                  wallMs={day.wallMs}
                  maxMs={maxActive(summary.days)}
                  now={now}
                />
              ))}
            </ul>
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Your data"
        description="Everything is local to this companion data folder. Nothing is uploaded."
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Export or clear</span>
              <span className="text-[13px] leading-snug text-muted-foreground">
                The JSON export contains app names and durations for the selected period. It never
                includes a title, path, document or URL. Kept for {summary?.retentionDays ?? 35} local days.
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button id="usage-export" variant="secondary" size="sm" onClick={() => void exportJson()} disabled={exporting || !summary}>
                <DownloadSimple className="size-3.5" aria-hidden />
                {exporting ? 'Preparing…' : 'Export JSON'}
              </Button>
              <Button
                id="usage-clear"
                variant={clearStage === 'confirm' ? 'destructive' : 'secondary'}
                size="sm"
                onClick={() => void clear()}
                disabled={clearStage === 'busy' || !hasData}
              >
                <Trash className="size-3.5" aria-hidden />
                {clearStage === 'busy' ? 'Clearing…' : clearStage === 'confirm' ? 'Click again to clear' : 'Clear usage'}
              </Button>
            </div>
          </div>
          <p className="m-0 px-4 py-3 text-xs leading-relaxed text-faint">
            Clearing removes every local app-usage total. It does not change your blocked apps,
            focus sessions, locks or the separate Activity log.
          </p>
          <FormMessage id="usage-status" message={msg} className="px-4 pb-3.5" />
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}

function Stat({
  id,
  label,
  value,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div id={id} className="flex flex-col gap-1 px-4 py-4">
      <span className="text-xs text-faint">{label}</span>
      <span className="block truncate text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function AppRow({ app, total, rank }: { app: UsageAppTotal; total: number; rank: number }) {
  const share = total > 0 ? app.activeMs / total : 0;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">{rank}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium text-foreground">{friendlyAppName(app.id)}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatUsage(app.activeMs)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.max(1, share * 100)}%` }} />
        </div>
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
        {Math.round(share * 100)}%
      </span>
    </li>
  );
}

function OtherRow({ apps, total }: { apps: UsageAppTotal[]; total: number }) {
  const active = apps.reduce((sum, app) => sum + app.activeMs, 0);
  const share = total > 0 ? active / total : 0;
  return (
    <li id="usage-other" className="flex items-center gap-3 px-4 py-3">
      <span className="w-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm text-muted-foreground">
            Other ({apps.length} {apps.length === 1 ? 'app' : 'apps'})
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {formatUsage(active)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-muted-foreground/40" style={{ width: `${Math.max(1, share * 100)}%` }} />
        </div>
      </div>
      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
        {Math.round(share * 100)}%
      </span>
    </li>
  );
}

function DayRow({
  date,
  activeMs,
  wallMs,
  maxMs,
  now,
}: {
  date: string;
  activeMs: number;
  wallMs: number;
  maxMs: number;
  now: number;
}) {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
  const share = maxMs > 0 ? activeMs / maxMs : 0;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <time
        dateTime={date}
        className="w-[132px] shrink-0 whitespace-nowrap text-[13px] text-muted-foreground"
      >
        {dayHeading(at, now)}
      </time>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        {activeMs > 0 && (
          <div className="h-full rounded-full bg-foreground/60" style={{ width: `${Math.max(1, share * 100)}%` }} />
        )}
      </div>
      <span className="w-[76px] shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
        {activeMs > 0 ? formatUsage(activeMs) : '—'}
      </span>
      <span className="hidden w-[70px] shrink-0 text-right font-mono text-[11px] tabular-nums text-faint sm:block">
        {wallMs > 0 ? formatUsage(wallMs) : ''}
      </span>
    </li>
  );
}

function localDateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatUsage(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function formatPercent(active: number, wall: number): string {
  if (wall <= 0) return '0%';
  return `${Math.min(100, Math.round((active / wall) * 100))}%`;
}

function maxActive(days: UsageSummary['days']): number {
  return days.reduce((max, day) => Math.max(max, day.activeMs), 0);
}
