import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Clock,
  Coffee,
  Desktop,
  LockSimple,
  ShieldCheck,
} from '@phosphor-icons/react';
import { api } from '../../shared/api';
import {
  buildDashboard,
  buildDayTimeline,
  formatDashboardRemaining,
  type DashboardAllowanceInput,
  type DashboardModel,
  type DashboardTone,
} from '../../shared/dashboard';
import { getLocalAllowanceAuthority } from '../../shared/allowance-store';
import { normalizeAllowanceAuthorityState } from '../../shared/allowance-state';
import { Badge } from '../../components/ui/badge';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

const ALLOWANCE_POLL_MS = 2_000;

const badgeVariant: Record<DashboardTone, 'default' | 'success' | 'warning' | 'commit' | 'destructive'> = {
  success: 'success',
  warning: 'warning',
  commit: 'commit',
  neutral: 'default',
  destructive: 'destructive',
};

function laneSegmentClass(lane: 'global' | 'category'): string {
  return lane === 'global'
    ? 'border border-accent/50 bg-accent/40'
    : 'border border-accent/40 bg-accent/20';
}

function CountdownValue({ value, tone = 'commit' }: { value: string | null; tone?: DashboardTone }) {
  if (!value) return null;
  return (
    <span className={cn('font-mono text-xs tabular-nums', tone === 'commit' ? 'text-accent-soft' : 'text-muted-foreground')}>
      {value}
    </span>
  );
}

function TimelineLane({ model, laneId }: { model: DashboardModel; laneId: 'global' | 'category' }) {
  const lane = model.timeline.lanes.find((item) => item.id === laneId);
  if (!lane) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{lane.title}</span>
        <span className="text-[11px] text-faint">{lane.occurrences.length ? `${lane.occurrences.length} window${lane.occurrences.length === 1 ? '' : 's'} today` : 'Nothing scheduled'}</span>
      </div>
      <div
        id={`dashboard-timeline-${lane.id}`}
        aria-hidden
        className="relative h-7 overflow-hidden rounded-md border border-border bg-background"
      >
        {lane.segments.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-border/70 text-[10px] text-faint">
            No schedule
          </div>
        )}
        {lane.segments.map((segment, index) => (
          <div
            key={`${segment.start}-${index}`}
            className={cn('dashboard-timeline-segment absolute inset-y-1 rounded-sm', laneSegmentClass(lane.id))}
            style={{
              left: `${segment.leftPct}%`,
              width: `${Math.max(segment.widthPct, 0.35)}%`,
            }}
            title={segment.label}
          />
        ))}
        <div
          id={`dashboard-timeline-${lane.id}-marker`}
          className="absolute inset-y-0 z-10 w-px bg-foreground/80"
          style={{ left: `${model.timeline.nowPct}%` }}
        />
      </div>
    </div>
  );
}

function TimelineTicks({ model }: { model: DashboardModel }) {
  return (
    <div className="relative h-5 text-[10px] tabular-nums text-faint">
      {model.timeline.ticks.map((tick, index) => (
        <span
          key={`${tick.at}-${index}`}
          className="absolute top-0 whitespace-nowrap"
          style={{
            left: `${tick.pct}%`,
            transform: index === 0 ? 'translateX(0)' : index === model.timeline.ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
          }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

export function DashboardPage({ state }: { state: OptionsState }) {
  const { settings, lockState, pendingFocus, companion, now } = state;
  const [allowance, setAllowance] = useState<DashboardAllowanceInput>({ state: null, source: null });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = (await api.runtime.sendMessage({
          type: 'GET_ALLOWANCE_AUTHORITY',
        })) as { ok?: boolean; state?: unknown; source?: DashboardAllowanceInput['source'] };
        if (cancelled) return;
        const stateFromMessage = normalizeAllowanceAuthorityState(response?.state);
        if (response?.ok && stateFromMessage) {
          setAllowance({ state: stateFromMessage, source: response.source ?? null });
          return;
        }
      } catch {
        // Background unreachable (SW restart). Fall through to storage.local.
      }
      try {
        const local = await getLocalAllowanceAuthority();
        if (!cancelled) setAllowance({ state: local, source: null });
      } catch {
        // Keep the last authority snapshot.
      }
    };

    void load();
    const timer = setInterval(() => void load(), ALLOWANCE_POLL_MS);
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes['allowanceAuthority']) void load();
    };
    api.storage.onChanged.addListener(onStorageChanged);
    return () => {
      cancelled = true;
      clearInterval(timer);
      api.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const dayToken = new Date(now).toDateString();
  const baseTimeline = useMemo(
    () => buildDayTimeline(lockState, now),
    // The timeline is day-stable; `now` only selects the day and is refreshed
    // into the marker below on every tick.
    [lockState.schedules, lockState.categorySchedules, dayToken], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const timeline = useMemo(() => {
    const span = baseTimeline.dayEnd - baseTimeline.dayStart;
    const clamped = Math.min(Math.max(now, baseTimeline.dayStart), baseTimeline.dayEnd);
    return {
      ...baseTimeline,
      now,
      nowPct: span > 0 ? ((clamped - baseTimeline.dayStart) / span) * 100 : 0,
    };
  }, [baseTimeline, now]);

  const model = useMemo(
    () =>
      buildDashboard({
        now,
        settings: {
          enabled: settings?.enabled ?? true,
          focusGoal: settings?.focusGoal ?? '',
          resumeMode: settings?.resumeMode ?? 'off',
          resumeAt: settings?.resumeAt ?? null,
          breakMode: settings?.breakMode ?? 'off',
          breakDelayMinutes: settings?.breakDelayMinutes ?? 1,
          breakDurationMinutes: settings?.breakDurationMinutes ?? 10,
          breakTextLength: settings?.breakTextLength ?? 100,
        },
        lockState,
        pendingFocus,
        companion,
        allowance,
        timeline,
      }),
    [now, settings, lockState, pendingFocus, companion, allowance, timeline],
  );

  return (
    <Page
      title="Now"
      description="What is happening right now, what happens next, and what relief can do. Every value comes from this browser's live extension state."
    >
      <SettingsSection
        id="dashboard-now"
        title="Now"
        description="Countdowns use the same clock as the locks they describe."
        aside={<span className="font-mono text-xs tabular-nums text-faint">{model.nowLabel}</span>}
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <p className="m-0 text-xs font-medium text-faint">Right now</p>
              <p
                id="dashboard-blocking"
                className="m-0 mt-1 text-lg font-semibold tracking-tight text-foreground"
              >
                {model.blocking.title}
              </p>
              <p id="dashboard-blocking-detail" className="m-0 mt-1 text-[13px] text-muted-foreground">
                {model.blocking.detail}
              </p>
            </div>
            <Badge variant={badgeVariant[model.blocking.tone]} dot>
              {model.blocking.forced ? 'Locked' : model.blocking.enabled ? 'Protection on' : 'Paused'}
            </Badge>
          </div>

          <div id="dashboard-lock" className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <LockSimple weight="fill" aria-hidden className={cn('size-4 shrink-0', model.lock.active ? 'text-accent' : 'text-faint')} />
              <p id="dashboard-lock-summary" className="m-0 text-sm font-medium text-foreground">
                {model.lock.summary}
              </p>
            </div>
            {model.lock.until && (
              <p className="m-0 pl-6 font-mono text-xs tabular-nums text-accent-soft">
                {model.lock.until.text}
              </p>
            )}
            {model.lock.reasons.length > 0 && (
              <ul id="dashboard-lock-reasons" className="m-0 flex list-none flex-col gap-2 p-0 pl-6">
                {model.lock.reasons.map((reason) => (
                  <li key={reason.reason} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <span className="text-[13px] font-medium text-foreground">{reason.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {reason.detail}
                      {reason.countdown && (
                        <span className="ml-1 font-mono tabular-nums text-accent-soft">{reason.countdown.text}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <SettingRow
            label={model.focus.title}
            description={model.focus.detail}
            control={
              model.focus.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.focus.countdown.remainingMs)} />
              ) : undefined
            }
          />

          <SettingRow
            label={model.break.title}
            description={model.break.detail}
            control={
              model.break.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.break.countdown.remainingMs)} />
              ) : undefined
            }
          />

          <SettingRow
            label={model.globalWindow.title}
            description={model.globalWindow.detail}
            control={
              model.globalWindow.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.globalWindow.countdown.remainingMs)} />
              ) : model.globalWindow.configured ? (
                <Badge variant="outline">{model.globalWindow.ruleCount} rule{model.globalWindow.ruleCount === 1 ? '' : 's'}</Badge>
              ) : undefined
            }
          />

          <SettingRow
            label={model.categoryWindow.title}
            description={model.categoryWindow.detail}
            control={
              model.categoryWindow.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.categoryWindow.countdown.remainingMs)} />
              ) : model.categoryWindow.configured ? (
                <Badge variant="outline">{model.categoryWindow.ruleCount} rule{model.categoryWindow.ruleCount === 1 ? '' : 's'}</Badge>
              ) : undefined
            }
          />

          <SettingRow
            label={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    model.companion.tone === 'success'
                      ? 'bg-success'
                      : model.companion.tone === 'warning'
                        ? 'bg-warning'
                        : 'bg-faint',
                  )}
                />
                <span id="dashboard-companion">{model.companion.title}</span>
              </span>
            }
            description={model.companion.detail}
            control={<Desktop aria-hidden className="size-4 text-faint" />}
          />

          {model.profile && (
            <SettingRow label="Profile" description={model.profile.detail ?? 'Current profile'} control={<Badge variant="outline">{model.profile.name}</Badge>} />
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="dashboard-next"
        title="Next"
        description="Only transitions the extension can derive from saved state appear here."
        aside={<ArrowRight aria-hidden className="size-4 text-faint" />}
      >
        <SettingsGroup>
          <SettingRow
            label="Next focus-hours transition"
            description={
              <span id="dashboard-next-global">
                {model.next.global.text}
                {model.next.global.ruleSummary ? ` · ${model.next.global.ruleSummary}` : ''}
              </span>
            }
            control={
              model.next.global.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.next.global.countdown.remainingMs)} />
              ) : undefined
            }
          />
          <SettingRow
            label="Next category-schedule transition"
            description={
              <span id="dashboard-next-category">
                {model.next.category.text}
                {model.next.category.categories.length > 0 ? ` · ${model.next.category.categories.join(', ')}` : ''}
                {model.next.category.ruleSummary ? ` · ${model.next.category.ruleSummary}` : ''}
              </span>
            }
            control={
              model.next.category.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.next.category.countdown.remainingMs)} />
              ) : undefined
            }
          />
          <SettingRow
            label="Auto-resume"
            description={<span id="dashboard-next-resume">{model.next.autoResume.detail}</span>}
            control={
              model.next.autoResume.countdown ? (
                <CountdownValue value={formatDashboardRemaining(model.next.autoResume.countdown.remainingMs)} />
              ) : (
                <Badge variant="outline">{model.next.autoResume.title}</Badge>
              )
            }
          />
          {model.next.pendingFocus && (
            <SettingRow
              label="Pending focus commit"
              description={<span id="dashboard-next-focus">{model.next.pendingFocus.detail}</span>}
              control={
                model.next.pendingFocus.countdown ? (
                  <CountdownValue value={formatDashboardRemaining(model.next.pendingFocus.countdown.remainingMs)} />
                ) : undefined
              }
            />
          )}
          {model.next.pendingBreak && (
            <SettingRow
              label="Pending break"
              description={model.next.pendingBreak.detail}
              control={
                model.next.pendingBreak.countdown ? (
                  <CountdownValue value={formatDashboardRemaining(model.next.pendingBreak.countdown.remainingMs)} />
                ) : undefined
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="dashboard-relief"
        title="Relief"
        description="What can relax a block — and what cannot."
        aside={<Coffee aria-hidden className="size-4 text-faint" />}
      >
        <SettingsGroup>
          <SettingRow
            label={model.relief.breakMode.title}
            description={<span id="dashboard-relief-break">{model.relief.breakMode.detail}</span>}
            control={<Badge variant="outline">{model.relief.breakMode.mode === 'off' ? 'Off' : 'Configured'}</Badge>}
          />
          <SettingRow
            stacked
            label={
              <span className="flex items-center gap-2">
                <ShieldCheck aria-hidden className="size-4 text-faint" />
                <span id="dashboard-relief-allowance">{model.relief.allowanceTitle}</span>
              </span>
            }
            description={model.relief.allowanceDetail}
            control={
              model.relief.allowanceSource ? (
                <Badge variant={model.relief.allowanceSource === 'daemon' ? 'success' : 'outline'}>
                  {model.relief.allowanceSource === 'daemon'
                    ? 'Desktop authority'
                    : model.relief.allowanceSource === 'pending'
                      ? 'Initializing'
                      : 'Browser-only'}
                </Badge>
              ) : undefined
            }
          >
            {model.relief.grants.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {model.relief.grants.map((grant) => (
                  <li key={`${grant.category}-${grant.endsAt}`} className="flex flex-col gap-0.5 rounded-md border border-border bg-background px-3 py-2">
                    <span className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-foreground">
                      <span>{grant.title}</span>
                      <CountdownValue value={grant.countdown.text} />
                    </span>
                    <span className="text-xs text-muted-foreground">{grant.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </SettingRow>
        </SettingsGroup>
        <Callout id="dashboard-relief-statement" tone="neutral">
          {model.relief.statement}
        </Callout>
      </SettingsSection>

      <SettingsSection
        id="dashboard-timeline"
        title="Today"
        description="A 24-hour local-time view of the same schedule rules. Hover a block for its time range; the list below is the textual equivalent."
        aside={<Clock aria-hidden className="size-4 text-faint" />}
      >
        <SettingsGroup>
          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="m-0 text-sm font-medium text-foreground">{model.timeline.label}</p>
              <p id="dashboard-timeline-now" className="m-0 font-mono text-xs tabular-nums text-faint">
                Now · {model.nowLabel}
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <TimelineLane model={model} laneId="global" />
              <TimelineLane model={model} laneId="category" />
            </div>
            <TimelineTicks model={model} />
            <div id="dashboard-timeline-text" className="flex flex-col gap-3 border-t border-border pt-3">
              {model.timeline.lanes.map((lane) => (
                <div key={lane.id} className="flex flex-col gap-1">
                  <p className="m-0 text-xs font-medium text-muted-foreground">{lane.title}</p>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-muted-foreground">
                    {lane.text.map((line) => (
                      <li key={line} className="flex gap-1.5">
                        <span aria-hidden className="text-faint">·</span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
