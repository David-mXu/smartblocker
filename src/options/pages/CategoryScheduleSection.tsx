import React, { useEffect, useState } from 'react';
import { MoonStars, Plus, X } from '@phosphor-icons/react';
import { getLockState, setCategorySchedules } from '../../shared/lock';
import {
  isInScheduleWindow,
  validateCategoryScheduleRule,
  type CategoryScheduleRule,
} from '../../shared/lock-math';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import { hhmmToMinutes, minutesToClock, minutesToHHMM } from '../format';
import { LockedNote } from './Page';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cloneRules(rules: CategoryScheduleRule[]): CategoryScheduleRule[] {
  return rules.map((rule) => ({ ...rule, days: [...rule.days], categories: [...rule.categories] }));
}

function sameRules(a: CategoryScheduleRule[], b: CategoryScheduleRule[]): boolean {
  const key = (rules: CategoryScheduleRule[]) =>
    JSON.stringify(
      rules.map((rule) => [
        rule.id,
        [...rule.days].sort(),
        rule.startMinutes,
        rule.endMinutes,
        [...rule.categories].sort(),
      ]),
    );
  return key(a) === key(b);
}

function ruleSummary(rule: CategoryScheduleRule): string {
  const days = [...rule.days].sort((a, b) => a - b);
  const dayText =
    days.join(',') === '0,1,2,3,4,5,6'
      ? 'Every day'
      : days.join(',') === '1,2,3,4,5'
        ? 'Weekdays'
        : days.map((day) => DAY_SHORT[day]).join(', ') || 'No days picked';
  return `${dayText} · ${minutesToClock(rule.startMinutes)} – ${minutesToClock(rule.endMinutes)}`;
}

interface Props {
  labels: string[];
  locked: boolean;
  lockReason: string;
  now: number;
  refreshLock: () => Promise<void>;
}

/** Editor for additive categorySchedules only. Legacy global focus hours stay
 * in SchedulePage; combining the two would make mixed-version semantics and
 * the very different lock behavior needlessly ambiguous. */
export function CategoryScheduleSection({ labels, locked, lockReason, now, refreshLock }: Props) {
  const [saved, setSaved] = useState<CategoryScheduleRule[]>([]);
  const [rules, setRules] = useState<CategoryScheduleRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);

  useEffect(() => {
    void getLockState().then((state) => {
      const scoped = cloneRules(state.categorySchedules ?? []);
      setSaved(scoped);
      setRules(cloneRules(scoped));
      setLoaded(true);
    });
  }, []);

  const activeSavedWindow = saved.some(
    (rule) =>
      validateCategoryScheduleRule(rule) === null && isInScheduleWindow([rule], new Date(now)),
  );
  const readOnly = locked || activeSavedWindow;
  const disabledReason = locked
    ? lockReason
    : 'Wait for the active category window to end before editing it.';
  const dirty = loaded && !sameRules(rules, saved);

  const update = (id: string, fn: (rule: CategoryScheduleRule) => CategoryScheduleRule) => {
    if (readOnly) return;
    setMessage('');
    setRules((current) => current.map((rule) => (rule.id === id ? fn(rule) : rule)));
  };

  const addRule = () => {
    if (!loaded || readOnly || labels.length === 0) return;
    setMessage('');
    setRules((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        days: [1, 2, 3, 4, 5],
        startMinutes: 9 * 60,
        endMinutes: 17 * 60,
        categories: [labels[0]],
      },
    ]);
  };

  const handleSave = async () => {
    // Never translate the initial [] placeholder into a real empty-list
    // deletion while persisted scoped rules are still loading.
    if (!loaded || readOnly) return;
    setMessage('');
    try {
      await setCategorySchedules(rules);
      const state = await getLockState();
      const scoped = cloneRules(state.categorySchedules ?? []);
      setSaved(scoped);
      setRules(cloneRules(scoped));
      setMessageError(false);
      setMessage('Per-category schedules saved.');
    } catch (error) {
      setMessageError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    }
    await refreshLock();
  };

  const timeInputClass =
    'h-9 rounded-lg border border-input bg-background px-2.5 font-mono text-[13px] tabular-nums text-foreground disabled:cursor-not-allowed disabled:opacity-45';

  return (
    <SettingsSection
      title="Per-category schedules"
      description="During a window, chosen categories block confident classifier matches. Outside it, those category schedules rescue classifier blocks. Ordinary blocking must be on; deterministic rules and channel allows keep their existing precedence. These schedules do not lock settings."
    >
      {locked && <LockedNote reason={lockReason} className="px-1" />}
      {!locked && activeSavedWindow && (
        <p role="note" className="m-0 px-1 text-xs text-muted-foreground">
          A category window is active. Editing resumes when all saved category windows are inactive.
        </p>
      )}

      <div id="category-schedule-list" className="flex flex-col gap-3">
        {loaded && rules.length === 0 && (
          <p className="m-0 rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-faint">
            No category schedules yet.
          </p>
        )}
        {rules.map((rule) => {
          const problem = validateCategoryScheduleRule(rule);
          const active = !problem && isInScheduleWindow([rule], new Date(now));
          const overnight = rule.endMinutes < rule.startMinutes;
          return (
            <SettingsGroup key={rule.id} className="category-schedule-row">
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 text-sm font-medium text-foreground">{ruleSummary(rule)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {rule.categories.map((category) => (
                      <Badge key={category} variant="outline">
                        {category}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {active && (
                    <Badge variant="commit" dot>
                      On now
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={readOnly}
                    title={readOnly ? disabledReason : 'Remove this category schedule'}
                    aria-label={`Remove category schedule: ${ruleSummary(rule)}`}
                    className="category-schedule-remove hover:text-destructive-soft"
                    onClick={() => {
                      if (!readOnly) setRules((current) => current.filter((item) => item.id !== rule.id));
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-3 px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
                  {DAY_LETTERS.map((letter, day) => {
                    const on = rule.days.includes(day);
                    return (
                      <label
                        key={day}
                        title={DAY_FULL[day]}
                        className={cn(
                          'inline-flex size-9 items-center justify-center rounded-md border text-xs font-medium select-none transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70',
                          on
                            ? 'border-accent/40 bg-accent/10 text-accent-soft'
                            : 'border-border text-faint hover:text-muted-foreground',
                          readOnly ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          aria-label={DAY_FULL[day]}
                          checked={on}
                          disabled={readOnly}
                          onChange={(event) =>
                            update(rule.id, (current) => ({
                              ...current,
                              days: event.target.checked
                                ? [...current.days, day].sort((a, b) => a - b)
                                : current.days.filter((item) => item !== day),
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
                      disabled={readOnly}
                      onChange={(event) =>
                        event.target.value &&
                        update(rule.id, (current) => ({
                          ...current,
                          startMinutes: hhmmToMinutes(event.target.value),
                        }))
                      }
                      className={timeInputClass}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    to
                    <input
                      type="time"
                      value={minutesToHHMM(rule.endMinutes)}
                      disabled={readOnly}
                      onChange={(event) =>
                        event.target.value &&
                        update(rule.id, (current) => ({
                          ...current,
                          endMinutes: hhmmToMinutes(event.target.value),
                        }))
                      }
                      className={timeInputClass}
                    />
                  </label>
                </div>

                <div>
                  <p className="mb-2 mt-0 text-xs font-medium text-muted-foreground">Categories</p>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Scheduled categories">
                    {labels.map((category) => {
                      const selected = rule.categories.includes(category);
                      return (
                        <label
                          key={category}
                          className={cn(
                            'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-xs transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70',
                            selected
                              ? 'border-accent/40 bg-accent/10 text-accent-soft'
                              : 'border-border text-muted-foreground',
                            readOnly && 'cursor-not-allowed opacity-45',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={selected}
                            disabled={readOnly}
                            onChange={(event) =>
                              update(rule.id, (current) => ({
                                ...current,
                                categories: event.target.checked
                                  ? [...current.categories, category]
                                  : current.categories.filter((item) => item !== category),
                              }))
                            }
                          />
                          {category}
                        </label>
                      );
                    })}
                  </div>
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

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-1 pt-3">
        <Button
          id="category-schedule-add"
          variant="outline"
          size="sm"
          disabled={!loaded || readOnly || labels.length === 0}
          onClick={addRule}
        >
          <Plus weight="bold" className="size-3.5" />
          Add category schedule
        </Button>
        <Button id="category-schedule-save" disabled={!loaded || readOnly} onClick={() => void handleSave()}>
          Save category schedules
        </Button>
        <span
          id="category-schedule-msg"
          role="status"
          aria-live="polite"
          className={cn(
            'text-xs font-medium',
            messageError ? 'text-destructive-soft' : dirty ? 'text-muted-foreground' : 'text-success-soft',
          )}
        >
          {message || (dirty ? 'You have unsaved changes.' : '')}
        </span>
      </div>
    </SettingsSection>
  );
}
