import React, { useEffect, useRef, useState } from 'react';
import { Warning } from '@phosphor-icons/react';
import {
  armDelayLock,
  armPasswordLock,
  armRandomTextLock,
  attemptPasswordUnlock,
  MIN_PASSWORD_LENGTH,
  startTimerLock,
} from '../../shared/lock';
import { api, IS_FIREFOX } from '../../shared/api';
import type { LockTypeResponse, Request } from '../../shared/messages';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Select } from '../../components/ui/select';
import { Badge } from '../../components/ui/badge';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import {
  BREAK_DELAY_MINUTES_MAX,
  BREAK_DELAY_MINUTES_MIN,
  BREAK_DURATION_MINUTES_MAX,
  BREAK_DURATION_MINUTES_MIN,
  BREAK_TEXT_LENGTH_MAX,
  BREAK_TEXT_LENGTH_MIN,
} from '../../shared/breaks';
import type { OptionsState } from '../useOptionsState';
import { formatClock as formatClockRaw, formatRemaining } from '../format';
import { LockedNote, Page } from './Page';
import { PartnerSection } from './PartnerSection';

async function sendLockTypeMessage(message: Request): Promise<LockTypeResponse> {
  const response = (await api.runtime.sendMessage(message)) as LockTypeResponse | undefined;
  if (!response?.ok) {
    throw new Error((response?.error ?? 'The background lock request failed.').replace(/^Error: /, ''));
  }
  return response;
}

export function LocksPage({ state }: { state: OptionsState }) {
  const { settings, lock, refreshLock, incognitoAllowed, now, flash, save } = state;
  const hour24 = settings?.hour24 ?? false;
  const formatClock = (ts: number) => formatClockRaw(ts, Date.now(), hour24);

  const [lockDuration, setLockDuration] = useState('1');
  const [lockUnit, setLockUnit] = useState<'h' | 'd'>('h');
  const [timerConfirmUntil, setTimerConfirmUntil] = useState<number | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [lockPassword, setLockPassword] = useState('');
  const [lockPasswordMsg, setLockPasswordMsg] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [delayDuration, setDelayDuration] = useState('1');
  const [delayUnit, setDelayUnit] = useState<'m' | 'h' | 'd'>('h');
  const [delayBusy, setDelayBusy] = useState(false);
  const [delayMsg, setDelayMsg] = useState('');

  const [randomLength, setRandomLength] = useState('100');
  const [randomChallenge, setRandomChallenge] = useState<{ id: string; text: string } | null>(null);
  const [randomProof, setRandomProof] = useState('');
  const [randomBusy, setRandomBusy] = useState(false);
  const [randomMsg, setRandomMsg] = useState('');

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  useEffect(() => {
    if (!lock.status.reasons.includes('random-text')) {
      setRandomChallenge(null);
      setRandomProof('');
    }
  }, [lock.status.randomTextLen, lock.status.reasons]);

  const durationMs = (() => {
    const n = parseInt(lockDuration, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n * (lockUnit === 'd' ? 86_400_000 : 3_600_000);
  })();

  const delayDurationMs = (() => {
    const n = Number(delayDuration);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    const multiplier = delayUnit === 'd' ? 86_400_000 : delayUnit === 'h' ? 3_600_000 : 60_000;
    const duration = n * multiplier;
    return Number.isSafeInteger(duration) ? duration : null;
  })();
  const delayActive = lock.status.reasons.includes('delay');
  const delayWaiting = delayActive && lock.status.delayUntil === 0;
  const delayCounting = delayActive && (lock.status.delayUntil ?? 0) > 0;
  const randomActive = lock.status.reasons.includes('random-text');

  const timerActive = lock.status.reasons.includes('timer');
  const partnerActive = lock.status.reasons.includes('partner');
  const noLocksConfigured =
    !timerActive && !lock.passwordArmed && !delayActive && !randomActive && !partnerActive;

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

  const handleDelayArm = async () => {
    if (delayDurationMs === null) return;
    setDelayBusy(true);
    setDelayMsg('');
    try {
      await armDelayLock(delayDurationMs);
      await refreshLock();
      flash('Delay lock on — start the countdown only when you want to unlock');
    } catch (e) {
      setDelayMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDelayBusy(false);
    }
  };

  const handleDelayCountdown = async (start: boolean) => {
    setDelayBusy(true);
    setDelayMsg('');
    try {
      const response = await sendLockTypeMessage({
        type: start ? 'START_DELAY_UNLOCK' : 'CANCEL_DELAY_UNLOCK',
      });
      if (!response.status) throw new Error('The background returned no lock status.');
      await refreshLock();
      flash(
        start
          ? `Unlock countdown started for ${formatClock(response.status.delayUntil ?? now)}`
          : 'Unlock countdown cancelled — the delay lock is still on',
      );
    } catch (e) {
      setDelayMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDelayBusy(false);
    }
  };

  const handleRandomArm = async () => {
    setRandomBusy(true);
    setRandomMsg('');
    try {
      await armRandomTextLock(Number(randomLength));
      await refreshLock();
      flash('Random-text lock on');
    } catch (e) {
      setRandomMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRandomBusy(false);
    }
  };

  const requestRandomChallenge = async () => {
    setRandomBusy(true);
    setRandomMsg('');
    try {
      const response = await sendLockTypeMessage({
        type: 'REQUEST_RANDOM_TEXT_UNLOCK_CHALLENGE',
      });
      if (!response.challengeId || typeof response.text !== 'string') {
        throw new Error('The background returned no unlock text.');
      }
      setRandomProof('');
      setRandomChallenge({ id: response.challengeId, text: response.text });
    } catch (e) {
      setRandomMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRandomBusy(false);
    }
  };

  const verifyRandomChallenge = async () => {
    if (!randomChallenge) return;
    setRandomBusy(true);
    setRandomMsg('');
    const attempted = randomChallenge;
    try {
      const response = await sendLockTypeMessage({
        type: 'ATTEMPT_RANDOM_TEXT_UNLOCK',
        challengeId: attempted.id,
        text: randomProof,
      });
      if (!response.status) throw new Error('The background returned no lock status.');
      setRandomChallenge(null);
      setRandomProof('');
      await refreshLock();
      flash('Random-text lock removed — other locks stay on');
    } catch (e) {
      // Every matching attempt is one-shot, including a typo.
      setRandomChallenge(null);
      setRandomProof('');
      setRandomMsg(`${e instanceof Error ? e.message : String(e)} Request a fresh text.`);
    } finally {
      setRandomBusy(false);
    }
  };

  return (
    <Page
      title="Locks"
      description="A lock stops future-you from switching blocking off or loosening settings. Timers cannot be shortened; gated locks release only through their own unlock flow. Every lock survives restarts."
    >
      {noLocksConfigured && (
        <p id="locks-empty-hint" className="m-0 px-1 text-[13px] text-faint">
          No locks configured. Pick one below when you want extra commitment.
        </p>
      )}
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
        title="Delay lock"
        description="Require a deliberate wait before this lock can be removed. Choose 1 minute–40 days. Starting or cancelling the countdown never changes other locks."
        aside={
          delayActive ? (
            <Badge variant="commit" dot>
              On
            </Badge>
          ) : undefined
        }
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            {!delayActive ? (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="lock-delay-duration" className="text-sm font-medium text-foreground">
                  Unlock delay
                </label>
                <Input
                  type="number"
                  id="lock-delay-duration"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={delayDuration}
                  onChange={(e) => setDelayDuration(e.target.value)}
                  className="w-20 font-mono tabular-nums"
                />
                <Select
                  id="lock-delay-unit"
                  aria-label="Delay unit"
                  value={delayUnit}
                  onChange={(e) => setDelayUnit(e.target.value as 'm' | 'h' | 'd')}
                  className="w-24"
                >
                  <option value="m">minutes</option>
                  <option value="h">hours</option>
                  <option value="d">days</option>
                </Select>
                <Button
                  id="lock-delay-arm-btn"
                  variant="commit"
                  disabled={delayBusy || delayDurationMs === null}
                  onClick={() => void handleDelayArm()}
                >
                  Arm delay lock
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="m-0 text-sm text-foreground tabular-nums">
                  {lock.status.delayReady
                    ? 'Delay elapsed — completing unlock in the background.'
                    : delayCounting
                      ? `Unlock countdown ends ${formatClock(lock.status.delayUntil ?? now)}.`
                      : `Armed with a ${formatRemaining(lock.status.delayDurationMs ?? 0)} unlock delay.`}
                </p>
                {delayWaiting ? (
                  <Button
                    id="lock-delay-start-btn"
                    variant="secondary"
                    disabled={delayBusy}
                    onClick={() => void handleDelayCountdown(true)}
                  >
                    Start unlocking
                  </Button>
                ) : (
                  <Button
                    id="lock-delay-cancel-btn"
                    variant="outline"
                    disabled={delayBusy || lock.status.delayReady}
                    onClick={() => void handleDelayCountdown(false)}
                  >
                    {lock.status.delayReady ? 'Completing unlock…' : 'Cancel unlocking'}
                  </Button>
                )}
              </div>
            )}
            <p
              id="lock-delay-msg"
              role="status"
              aria-live="polite"
              className="m-0 text-xs text-muted-foreground empty:hidden"
            >
              {delayMsg ||
                (delayWaiting
                  ? 'The wait starts only when you click Start unlocking.'
                  : delayCounting
                    ? 'Cancelling returns to armed waiting; it does not remove the lock.'
                    : !delayActive
                      ? 'The countdown does not begin when you arm the lock.'
                      : 'Other independent locks remain active after this gate releases.')}
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
                ? 'Removes only the password lock — every other lock keeps running.'
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

      <SettingsSection
        title="Random-text lock"
        description="Require a fresh service-worker-generated text before this lock can be removed. Challenges expire and every attempt is one-shot."
        aside={
          randomActive ? (
            <Badge variant="commit" dot>
              On
            </Badge>
          ) : undefined
        }
      >
        <SettingsGroup>
          {!randomActive ? (
            <SettingRow
              label="Text length"
              description="Choose 1–5,000 symbols. Spaces every five symbols are only for readability."
              htmlFor="lock-random-length"
              control={
                <div className="flex items-center gap-2">
                  <Input
                    id="lock-random-length"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={5000}
                    step={1}
                    value={randomLength}
                    onChange={(e) => setRandomLength(e.target.value)}
                    className="w-24 font-mono tabular-nums"
                  />
                  <Button
                    id="lock-random-arm-btn"
                    variant="commit"
                    disabled={randomBusy}
                    onClick={() => void handleRandomArm()}
                  >
                    Arm
                  </Button>
                </div>
              }
            />
          ) : (
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="m-0 max-w-prose text-sm text-muted-foreground">
                  Request a {lock.status.randomTextLen ?? 0}-symbol text, then type it to remove only this lock.
                  Spaces and letter case are optional.
                </p>
                <Button
                  id="lock-random-challenge-btn"
                  variant="secondary"
                  disabled={randomBusy}
                  onClick={() => void requestRandomChallenge()}
                >
                  {randomChallenge ? 'Request new text' : 'Show unlock text'}
                </Button>
              </div>
              {randomChallenge && (
                <>
                  <Textarea
                    id="lock-random-challenge"
                    aria-label="Random text to type"
                    readOnly
                    rows={4}
                    value={randomChallenge.text}
                    onFocus={(e) => e.target.select()}
                    className="max-h-48 resize-y break-all font-mono text-xs leading-relaxed tracking-wide"
                  />
                  <label htmlFor="lock-random-proof" className="text-sm font-medium text-foreground">
                    Type the text
                  </label>
                  <Textarea
                    id="lock-random-proof"
                    rows={4}
                    value={randomProof}
                    disabled={randomBusy}
                    onChange={(e) => setRandomProof(e.target.value)}
                    placeholder="Type the random text above"
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="max-h-48 resize-y font-mono text-xs"
                    aria-describedby="lock-random-challenge"
                  />
                  <div className="flex items-center gap-3">
                    <Button
                      id="lock-random-verify-btn"
                      variant="secondary"
                      disabled={randomBusy}
                      onClick={() => void verifyRandomChallenge()}
                    >
                      Unlock random-text lock
                    </Button>
                    <p className="m-0 text-xs text-muted-foreground">
                      A typo uses this challenge. Request a new one before trying again.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
          <span
            id="lock-random-msg"
            role="alert"
            className="block px-4 pb-3 text-xs font-medium text-destructive-soft empty:hidden"
          >
            {randomMsg}
          </span>
        </SettingsGroup>
      </SettingsSection>

      {settings && (
        <SettingsSection
          title="Breaks"
          description="Allow a time-limited pause while locked. A break relaxes only classifier verdicts; your lock, always-block rules and desktop enforcement stay on."
        >
          <SettingsGroup>
            <SettingRow
              label="Break gate"
              description={
                lock.locked ? (
                  <LockedNote reason={lock.reason} className="mt-0.5" />
                ) : (
                  'Choose the friction required before a break can start from the popup.'
                )
              }
              htmlFor="break-mode"
              control={
                <Select
                  id="break-mode"
                  value={settings.breakMode}
                  disabled={lock.locked}
                  onChange={(e) => void save({ breakMode: e.target.value as typeof settings.breakMode })}
                >
                  <option value="off">No breaks</option>
                  <option value="delay">Wait for a delay</option>
                  <option value="random-text">Type random text</option>
                </Select>
              }
            />
            {settings.breakMode === 'delay' && (
              <SettingRow
                label="Delay before the break"
                description={
                  lock.locked ? (
                    <LockedNote reason={lock.reason} className="mt-0.5" />
                  ) : (
                    'Blocking stays on throughout this delay. Choose 0–60 minutes.'
                  )
                }
                htmlFor="break-delay-minutes"
                control={
                  <Input
                    id="break-delay-minutes"
                    type="number"
                    inputMode="numeric"
                    min={BREAK_DELAY_MINUTES_MIN}
                    max={BREAK_DELAY_MINUTES_MAX}
                    step={1}
                    value={settings.breakDelayMinutes}
                    disabled={lock.locked}
                    onChange={(e) => {
                      if (Number.isFinite(e.target.valueAsNumber)) {
                        void save({ breakDelayMinutes: e.target.valueAsNumber });
                      }
                    }}
                    className="w-24 font-mono tabular-nums"
                  />
                }
              />
            )}
            {settings.breakMode !== 'off' && (
              <SettingRow
                label="Break length"
                description={
                  lock.locked ? (
                    <LockedNote reason={lock.reason} className="mt-0.5" />
                  ) : (
                    'Classifier blocking resumes automatically. Choose 1–1,440 minutes.'
                  )
                }
                htmlFor="break-duration-minutes"
                control={
                  <Input
                    id="break-duration-minutes"
                    type="number"
                    inputMode="numeric"
                    min={BREAK_DURATION_MINUTES_MIN}
                    max={BREAK_DURATION_MINUTES_MAX}
                    step={1}
                    value={settings.breakDurationMinutes}
                    disabled={lock.locked}
                    onChange={(e) => {
                      if (Number.isFinite(e.target.valueAsNumber)) {
                        void save({ breakDurationMinutes: e.target.valueAsNumber });
                      }
                    }}
                    className="w-24 font-mono tabular-nums"
                  />
                }
              />
            )}
            {settings.breakMode === 'random-text' && (
              <SettingRow
                label="Random text length"
                description={
                  lock.locked ? (
                    <LockedNote reason={lock.reason} className="mt-0.5" />
                  ) : (
                    'The popup shows a fresh service-worker challenge. Choose 10–1,000 symbols.'
                  )
                }
                htmlFor="break-text-length"
                control={
                  <Input
                    id="break-text-length"
                    type="number"
                    inputMode="numeric"
                    min={BREAK_TEXT_LENGTH_MIN}
                    max={BREAK_TEXT_LENGTH_MAX}
                    step={1}
                    value={settings.breakTextLength}
                    disabled={lock.locked}
                    onChange={(e) => {
                      if (Number.isFinite(e.target.valueAsNumber)) {
                        void save({ breakTextLength: e.target.valueAsNumber });
                      }
                    }}
                    className="w-24 font-mono tabular-nums"
                  />
                }
              />
            )}
          </SettingsGroup>
        </SettingsSection>
      )}

      <PartnerSection state={state} />

      {incognitoAllowed === false && (
        <Callout id="incognito-warning" tone="warning">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Warning weight="fill" className="size-4 shrink-0 text-warning" />
            Private windows aren't protected
          </div>
          <p className="m-0 text-warning-soft/80">
            SmartBlocker can't see private (incognito) windows, so they get around your locks. Open{' '}
            {IS_FIREFOX ? (
              <>
                <span className="font-medium text-warning-soft">Add-ons and themes</span> → SmartBlocker,
                then set <span className="font-medium text-warning-soft">Run in Private Windows</span> to Allow.
              </>
            ) : (
              <>
                <code className="font-mono text-xs text-warning-soft">chrome://extensions</code>, choose
                Details on SmartBlocker, and turn on{' '}
                <span className="font-medium text-warning-soft">Allow in Incognito</span>.
              </>
            )}
          </p>
        </Callout>
      )}
    </Page>
  );
}
