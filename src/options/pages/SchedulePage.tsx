import React, { useEffect, useState } from 'react';
import { Plus, X, MoonStars } from '@phosphor-icons/react';
import { getLockState, setSchedules } from '../../shared/lock';
import { isInScheduleWindow, validateScheduleRule, type ScheduleRule } from '../../shared/lock-math';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { hhmmToMinutes, minutesToClock, minutesToHHMM } from '../format';
import { LockedNote, Page } from './Page';
import { CategoryScheduleSection } from './CategoryScheduleSection';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PRESETS: { name: string; days: number[]; start: number; end: number }[] = [
  { name: 'Weekdays 9–5', days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 },
  { name: 'Every evening 7–10 PM', days: [0, 1, 2, 3, 4, 5, 6], start: 19 * 60, end: 22 * 60 },
];

function daysSummary(days: number[]): string {
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '') return 'No days picked';
  if (set === '0,1,2,3,4,5,6') return 'Every day';
  if (set === '1,2,3,4,5') return 'Weekdays';
  if (set === '0,6') return 'Weekends';
  // Mon-first reading order.
  return [...days]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => DAY_SHORT[d])
    .join(', ');
}

function ruleSummary(r: ScheduleRule): string {
  return `${daysSummary(r.days)} · ${minutesToClock(r.startMinutes)} – ${minutesToClock(r.endMinutes)}`;
}

function cloneRules(rules: ScheduleRule[]): ScheduleRule[] {
  return rules.map((r) => ({ ...r, days: [...r.days] }));
}

function sameRules(a: ScheduleRule[], b: ScheduleRule[]): boolean {
  const key = (rs: ScheduleRule[]) =>
    JSON.stringify(rs.map((r) => [r.id, [...r.days].sort(), r.startMinutes, r.endMinutes]));
  return key(a) === key(b);
}

export function SchedulePage({ state }: { state: OptionsState }) {
  const { lock, refreshLock, now } = state;
  const locked = lock.locked;

  const [saved, setSaved] = useState<ScheduleRule[]>([]);
  const [rules, setRules] = useState<ScheduleRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState('');
  const [scheduleMsgError, setScheduleMsgError] = useState(false);

  useEffect(() => {
    void getLockState().then((ls) => {
      setSaved(cloneRules(ls.schedules));
      setRules(cloneRules(ls.schedules));
      setLoaded(true);
    });
  }, []);

  const dirty = loaded && !sameRules(rules, saved);

  const update = (id: string, fn: (r: ScheduleRule) => ScheduleRule) => {
    if (locked) return;
    setScheduleMsg('');
    setRules((prev) => prev.map((r) => (r.id === id ? fn(r) : r)));
  };

  const addRule = (days: number[], start: number, end: number) => {
    if (locked) return;
    setScheduleMsg('');
    setRules((prev) => [...prev, { id: crypto.randomUUID(), days, startMinutes: start, endMinutes: end }]);
  };

  const removeRule = (id: string) => {
    if (locked) return;
    setScheduleMsg('');
    setRules((prev) => prev.filter((r) => r.id !== id));
  };

  const handleSave = async () => {
    setScheduleMsg('');
    try {
      await setSchedules(rules);
      const ls = await getLockState();
      setSaved(cloneRules(ls.schedules));
      setRules(cloneRules(ls.schedules));
      setScheduleMsgError(false);
      setScheduleMsg('Focus hours saved.');
    } catch (e) {
      setScheduleMsgError(true);
      setScheduleMsg(e instanceof Error ? e.message : String(e));
    }
    await refreshLock();
  };

  const timeInputClass =
    'h-9 rounded-lg border border-input bg-background px-2.5 font-mono text-[13px] tabular-nums text-foreground disabled:cursor-not-allowed disabled:opacity-45';

  return (
    <Page
      title="Focus hours"
      description="Weekly times when blocking is always on and settings are locked — like a focus session that starts by itself."
    >
      <SettingsSection
        title="Your focus hours"
        description="Times use this device's time zone. You can't change focus hours while a lock is on."
      >
        {locked && <LockedNote reason={lock.reason} className="px-1" />}

        <div id="schedule-list" className="flex flex-col gap-3">
          {loaded && rules.length === 0 && (
            <p className="m-0 rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-faint">
              No focus hours yet. Start from a preset below or add your own.
            </p>
          )}
          {rules.map((rule) => {
            const overnight = rule.endMinutes < rule.startMinutes;
            const problem = validateScheduleRule(rule);
            const active = !problem && isInScheduleWindow([rule], new Date(now));
            return (
              <SettingsGroup key={rule.id} className="schedule-row">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 text-sm font-medium text-foreground">{ruleSummary(rule)}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {active && (
                      <Badge variant="commit" dot>
                        On now
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={locked}
                      onClick={() => removeRule(rule.id)}
                      title={locked ? lock.reason : 'Remove these focus hours'}
                      aria-label={`Remove focus hours: ${ruleSummary(rule)}`}
                      className="schedule-remove hover:text-destructive-soft"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-3 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
                    {DAY_LETTERS.map((letter, d) => {
                      const on = rule.days.includes(d);
                      return (
                        <label
                          key={d}
                          title={DAY_FULL[d]}
                          className={cn(
                            'day-label inline-flex size-9 items-center justify-center rounded-md border text-xs font-medium select-none transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70',
                            on
                              ? 'border-accent/40 bg-accent/10 text-accent-soft'
                              : 'border-border text-faint hover:text-muted-foreground',
                            locked ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            aria-label={DAY_FULL[d]}
                            checked={on}
                            disabled={locked}
                            onChange={(e) =>
                              update(rule.id, (r) => ({
                                ...r,
                                days: e.target.checked
                                  ? [...r.days, d].sort((a, b) => a - b)
                                  : r.days.filter((x) => x !== d),
                              }))
                            }
                          />
                          <span aria-hidden>{letter}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      From
                      <input
                        type="time"
                        value={minutesToHHMM(rule.startMinutes)}
                        disabled={locked}
                        onChange={(e) =>
                          e.target.value &&
                          update(rule.id, (r) => ({ ...r, startMinutes: hhmmToMinutes(e.target.value) }))
                        }
                        className={timeInputClass}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      to
                      <input
                        type="time"
                        value={minutesToHHMM(rule.endMinutes)}
                        disabled={locked}
                        onChange={(e) =>
                          e.target.value &&
                          update(rule.id, (r) => ({ ...r, endMinutes: hhmmToMinutes(e.target.value) }))
                        }
                        className={timeInputClass}
                      />
                    </label>
                  </div>
                  {problem ? (
                    <p className="m-0 text-xs text-destructive-soft">{problem}</p>
                  ) : overnight ? (
                    <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MoonStars aria-hidden className="size-3.5 shrink-0" />
                      Runs overnight — ends at {minutesToClock(rule.endMinutes)} the next day.
                    </p>
                  ) : null}
                </div>
              </SettingsGroup>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 px-1 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-faint">Add:</span>
            {PRESETS.map((p) => (
              <Button
                key={p.name}
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => addRule([...p.days], p.start, p.end)}
              >
                {p.name}
              </Button>
            ))}
            <Button
              id="schedule-add"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => addRule([1, 2, 3, 4, 5], 9 * 60, 17 * 60)}
            >
              <Plus weight="bold" className="size-3.5" />
              Custom
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <Button id="schedule-save" disabled={locked} onClick={() => void handleSave()}>
              Save focus hours
            </Button>
            <span
              id="schedule-msg"
              role="status"
              aria-live="polite"
              className={cn(
                'text-xs font-medium',
                scheduleMsgError ? 'text-destructive-soft' : dirty ? 'text-muted-foreground' : 'text-success-soft',
              )}
            >
              {scheduleMsg || (dirty ? 'You have unsaved changes.' : '')}
            </span>
          </div>
        </div>
      </SettingsSection>
      <CategoryScheduleSection
        labels={state.settings?.labels ?? []}
        locked={locked}
        lockReason={lock.reason}
        now={now}
        refreshLock={refreshLock}
      />
    </Page>
  );
}
