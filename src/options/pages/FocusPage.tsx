import React, { useEffect, useRef, useState } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { startFocusSession, undoFocusSession } from '../../shared/focus-session';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Badge } from '../../components/ui/badge';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { formatClock, formatCountdown, formatRemaining } from '../format';
import { LockedNote, Page } from './Page';

const SESSION_PRESETS = [
  { mins: 60, label: '1 hour' },
  { mins: 240, label: '4 hours' },
  { mins: 480, label: '8 hours' },
] as const;

export function FocusPage({ state }: { state: OptionsState }) {
  const { settings, lock, save, pendingFocus, refreshPendingFocus, refreshLock, now, flash } = state;
  const locked = lock.locked;

  // Focus goal draft — synced from settings unless the user is typing.
  const [goal, setGoal] = useState('');
  const goalRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (settings && document.activeElement !== goalRef.current) setGoal(settings.focusGoal);
  }, [settings?.focusGoal]);

  const [sessionMins, setSessionMins] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [sessionMsg, setSessionMsg] = useState('');

  if (!settings) return null;

  const clock = (ts: number) => formatClock(ts, Date.now(), settings.hour24);

  const saveGoal = () => {
    const next = goal.trim();
    if (next === settings.focusGoal) return;
    void save({ focusGoal: next });
  };

  const sessionActive = lock.status.reasons.includes('frozen');
  // The session's own end can be earlier than the overall lock end; when
  // only a focus session is active, status.until is exactly its end.
  const sessionEndKnown = sessionActive && lock.status.reasons.length === 1 && lock.status.until;
  const plannedEnd = now + sessionMins * 60_000;

  const handleStart = async () => {
    setBusy(true);
    try {
      const p = await startFocusSession(sessionMins * 60_000);
      await refreshPendingFocus();
      setSessionMsg(`Focus session starts in 1 minute and locks until ${clock(p.until)}.`);
    } catch (e) {
      setSessionMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const handleUndo = async () => {
    const undone = await undoFocusSession();
    await refreshPendingFocus();
    await refreshLock();
    if (undone) {
      setSessionMsg('Focus session cancelled.');
      flash('Focus session cancelled');
    } else {
      setSessionMsg('Too late to undo — the focus session has started.');
    }
  };

  return (
    <Page
      title="Focus"
      description="Tell SmartBlocker what you're working on, or start a focus session that can't be switched off until it ends."
    >
      <SettingsSection
        title="What you're working on"
        description="Pages related to your goal stay open, even on sites that are usually distracting."
      >
        <SettingsGroup>
          <SettingRow
            stacked
            label="Focus goal"
            htmlFor="focus-goal"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                'Saved when you press Enter or leave the field. Leave empty to turn off.'
              )
            }
            control={settings.focusGoal ? <Badge variant="commit" dot>Focusing</Badge> : undefined}
          >
            <Input
              ref={goalRef}
              type="text"
              id="focus-goal"
              value={goal}
              disabled={locked}
              onChange={(e) => setGoal(e.target.value)}
              onBlur={saveGoal}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveGoal();
                }
              }}
              placeholder="e.g. Writing my biology lab report"
            />
          </SettingRow>
          <SettingRow
            label="Use my open tabs as context"
            description="Pages similar to the work tabs you have open are less likely to be blocked."
            htmlFor="use-tab-context"
            control={
              <Switch
                id="use-tab-context"
                checked={settings.useTabContext}
                disabled={locked}
                onChange={(e) => void save({ useTabContext: e.target.checked })}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Focus session"
        description="Blocking stays on and settings stay locked until the session ends. You get one minute to undo, then it can't be cancelled."
      >
        <SettingsGroup>
          {sessionActive ? (
            <div className="flex items-start gap-3 px-4 py-3.5">
              <LockSimple weight="fill" aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-accent-soft">Focus session in progress</span>
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {sessionEndKnown
                    ? `${formatRemaining(lock.status.until! - now)} left — ends at ${clock(lock.status.until!)}.`
                    : 'Blocking stays on until it ends.'}
                </span>
              </div>
            </div>
          ) : pendingFocus ? (
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <Callout tone="commit" role="status" aria-live="polite">
                <span className="tabular-nums">
                  Focus session starts in {formatCountdown(pendingFocus.commitAt - now)} and locks until{' '}
                  {clock(pendingFocus.until)}.
                </span>
              </Callout>
              <div>
                <Button id="focus-session-undo" variant="secondary" onClick={() => void handleUndo()}>
                  <span className="tabular-nums">Undo ({formatCountdown(pendingFocus.commitAt - now)})</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5 px-4 py-3.5">
              <div className="flex flex-col gap-2">
                <span id="session-length-label" className="text-sm font-medium text-foreground">
                  How long
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="session-length-label"
                  className="flex w-fit items-center gap-1 rounded-lg border border-border bg-background p-0.5"
                >
                  {SESSION_PRESETS.map((p) => {
                    const checked = sessionMins === p.mins;
                    return (
                      <label
                        key={p.mins}
                        className={cn(
                          'flex h-8 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70',
                          checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <input
                          type="radio"
                          name="session-length"
                          className="sr-only"
                          checked={checked}
                          onChange={() => setSessionMins(p.mins)}
                        />
                        {p.label}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-2 min-[520px]:flex-row min-[520px]:items-center min-[520px]:gap-4">
                <Button
                  id="focus-session-start"
                  variant="commit"
                  disabled={busy}
                  onClick={() => void handleStart()}
                  className="w-fit"
                >
                  Start focus session
                </Button>
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  Locks until {clock(plannedEnd)}.
                </span>
              </div>
            </div>
          )}
        </SettingsGroup>
        <p
          role="status"
          aria-live="polite"
          className={cn('m-0 px-1 text-xs text-muted-foreground empty:hidden', pendingFocus && 'sr-only')}
        >
          {sessionMsg}
        </p>
      </SettingsSection>
    </Page>
  );
}
