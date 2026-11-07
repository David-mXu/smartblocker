import React, { useEffect, useRef, useState } from 'react';
import { Warning } from '@phosphor-icons/react';
import {
  armPasswordLock,
  attemptPasswordUnlock,
  MIN_PASSWORD_LENGTH,
  startTimerLock,
} from '../../shared/lock';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { formatClock } from '../format';
import { Page } from './Page';

export function LocksPage({ state }: { state: OptionsState }) {
  const { lock, refreshLock, incognitoAllowed, now, flash } = state;

  const [lockDuration, setLockDuration] = useState('1');
  const [lockUnit, setLockUnit] = useState<'h' | 'd'>('h');
  const [timerConfirmUntil, setTimerConfirmUntil] = useState<number | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [lockPassword, setLockPassword] = useState('');
  const [lockPasswordMsg, setLockPasswordMsg] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const durationMs = (() => {
    const n = parseInt(lockDuration, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n * (lockUnit === 'd' ? 86_400_000 : 3_600_000);
  })();

  const timerActive = lock.status.reasons.includes('timer');

  const resetConfirm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setTimerConfirmUntil(null);
  };

  const handleTimerLockClick = async () => {
    if (durationMs === null) return;
    if (timerConfirmUntil === null) {
      // First click: state the exact end time, ask for a second click.
      setTimerConfirmUntil(Date.now() + durationMs);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setTimerConfirmUntil(null), 5000);
      return;
    }
    resetConfirm();
    try {
      const status = await startTimerLock(durationMs);
      await refreshLock();
      flash(status.until ? `Locked until ${formatClock(status.until)}` : 'Locked');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  };

  const handlePasswordLockClick = async () => {
    setLockPasswordMsg('');
    setPasswordBusy(true);
    try {
      if (lock.passwordArmed) {
        if (!(await attemptPasswordUnlock(lockPassword))) {
          setLockPasswordMsg('Wrong password.');
          setPasswordBusy(false);
          return;
        }
        flash('Password lock removed');
      } else {
        await armPasswordLock(lockPassword);
        flash('Password lock on');
      }
      setLockPassword('');
    } catch (e) {
      setLockPasswordMsg(e instanceof Error ? e.message : String(e));
    }
    setPasswordBusy(false);
    await refreshLock();
  };

  return (
    <Page
      title="Locks"
      description="A lock stops future-you from switching blocking off or loosening settings. You can always extend a lock, never shorten it, and it survives restarts."
    >
      <SettingsSection
        title="Timer lock"
        description="Locks settings for a set time. Block screens hide their “let me through” buttons until it ends."
        aside={
          timerActive ? (
            <Badge variant="commit" dot>
              On
            </Badge>
          ) : undefined
        }
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="lock-duration" className="text-sm font-medium text-foreground">
                Lock for
              </label>
              <Input
                type="number"
                id="lock-duration"
                min="1"
                inputMode="numeric"
                value={lockDuration}
                onChange={(e) => {
                  setLockDuration(e.target.value);
                  resetConfirm();
                }}
                className="w-16 font-mono tabular-nums"
              />
              <Select
                id="lock-unit"
                aria-label="Unit"
                value={lockUnit}
                onChange={(e) => {
                  setLockUnit(e.target.value as 'h' | 'd');
                  resetConfirm();
                }}
                className="w-24"
              >
                <option value="h">hours</option>
                <option value="d">days</option>
              </Select>
              <Button
                id="lock-timer-btn"
                variant={timerConfirmUntil !== null ? 'commit' : 'secondary'}
                disabled={durationMs === null}
                onClick={() => void handleTimerLockClick()}
              >
                {timerConfirmUntil !== null
                  ? `Lock until ${formatClock(timerConfirmUntil)} — click to confirm`
                  : timerActive
                    ? 'Extend lock'
                    : 'Lock settings'}
              </Button>
            </div>
            <p role="status" aria-live="polite" className="m-0 text-xs text-muted-foreground tabular-nums">
              {timerConfirmUntil !== null
                ? "Click again to confirm. You won't be able to unlock early."
                : durationMs !== null
                  ? lock.status.until && now + durationMs <= lock.status.until
                    ? `Settings are already locked until ${formatClock(lock.status.until)} — a timer this short adds nothing.`
                    : `Would lock until ${formatClock(now + durationMs)}.`
                  : 'Enter a whole number of hours or days.'}
            </p>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Password lock"
        description="Give the password to someone you trust. Settings stay locked until it's entered here."
        aside={
          lock.passwordArmed ? (
            <Badge variant="commit" dot>
              On
            </Badge>
          ) : undefined
        }
      >
        <SettingsGroup>
          <SettingRow
            stacked
            label={lock.passwordArmed ? 'Enter the password to unlock' : 'Choose a password'}
            htmlFor="lock-password"
            description={
              lock.passwordArmed
                ? 'Removes only the password lock — timer locks, focus sessions and focus hours keep running.'
                : `At least ${MIN_PASSWORD_LENGTH} characters. Pasting and password managers work.`
            }
          >
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handlePasswordLockClick();
              }}
            >
              <Input
                type="password"
                id="lock-password"
                value={lockPassword}
                onChange={(e) => setLockPassword(e.target.value)}
                placeholder={lock.passwordArmed ? 'Password' : `At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete={lock.passwordArmed ? 'current-password' : 'new-password'}
              />
              <Button
                id="lock-password-btn"
                type="submit"
                variant={lock.passwordArmed ? 'secondary' : 'commit'}
                disabled={passwordBusy}
                className="shrink-0"
              >
                {lock.passwordArmed ? 'Unlock' : 'Arm password lock'}
              </Button>
            </form>
            <span
              id="lock-password-msg"
              role="alert"
              className="block text-xs font-medium text-destructive-soft empty:hidden"
            >
              {lockPasswordMsg}
            </span>
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>

      {incognitoAllowed === false && (
        <Callout id="incognito-warning" tone="warning">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Warning weight="fill" className="size-4 shrink-0 text-warning" />
            Private windows aren't protected
          </div>
          <p className="m-0 text-warning-soft/80">
            SmartBlocker can't see private (incognito) windows, so they get around your locks. Open{' '}
            <code className="font-mono text-xs text-warning-soft">chrome://extensions</code>, choose
            Details on SmartBlocker, and turn on{' '}
            <span className="font-medium text-warning-soft">Allow in Incognito</span>.
          </p>
        </Callout>
      )}
    </Page>
  );
}
