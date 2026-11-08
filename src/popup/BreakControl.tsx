import React, { useEffect, useState } from 'react';
import { api } from '../shared/api';
import type { BreakMode } from '../shared/breaks';
import type { LockStatus } from '../shared/lock-math';
import type { BreakResponse } from '../shared/messages';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formatClock, formatEndTime } from './popup-model';

interface Props {
  now: number;
  mode: BreakMode;
  delayMinutes: number;
  durationMinutes: number;
  lock: LockStatus;
  onLock: (status: LockStatus) => void;
  onStatus: (text: string) => void;
}

function responseError(response: BreakResponse | undefined, fallback: string): Error {
  return new Error((response?.error ?? fallback).replace(/^Error: /, ''));
}

/** The popup never generates or judges a proof itself. Both live only in the
 *  service worker, and a break writes lock state only after its gate passes. */
export function BreakControl({
  now,
  mode,
  delayMinutes,
  durationMinutes,
  lock,
  onLock,
  onStatus,
}: Props) {
  const [challenge, setChallenge] = useState('');
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);

  const pending =
    lock.breakNotBefore !== null &&
    lock.breakEndsAt !== null &&
    lock.breakEndsAt > now &&
    now < lock.breakNotBefore;
  const scheduled = lock.breakActive || pending;

  useEffect(() => {
    setChallenge('');
    setProof('');
  }, [mode, lock.settingsLocked]);

  if (mode === 'off' || (!lock.settingsLocked && !scheduled)) return null;

  const requestStart = async () => {
    setBusy(true);
    onStatus('');
    try {
      if (mode === 'random-text') {
        const response = (await api.runtime.sendMessage({
          type: 'REQUEST_BREAK_CHALLENGE',
        })) as BreakResponse;
        if (!response?.ok || typeof response.text !== 'string') {
          throw responseError(response, 'Could not create the break text.');
        }
        setProof('');
        setChallenge(response.text);
      } else {
        const response = (await api.runtime.sendMessage({
          type: 'START_BREAK',
          mode,
        })) as BreakResponse;
        if (!response?.ok || !response.status) {
          throw responseError(response, 'Could not start the break.');
        }
        onLock(response.status);
        onStatus(
          delayMinutes > 0
            ? `Break scheduled. Classifier blocking resumes at ${formatEndTime(response.status.breakEndsAt ?? now, now)}.`
            : 'Break started. Your lock is still active.',
        );
      }
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyProof = async () => {
    if (!proof.trim()) {
      onStatus('Type the text above to start your break.');
      return;
    }
    setBusy(true);
    onStatus('');
    try {
      const response = (await api.runtime.sendMessage({
        type: 'START_BREAK',
        mode: 'random-text',
        text: proof,
      })) as BreakResponse;
      if (!response?.ok || !response.status) {
        throw responseError(response, 'The text does not match.');
      }
      setChallenge('');
      setProof('');
      onLock(response.status);
      onStatus('Break started. Your lock is still active.');
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    onStatus('');
    try {
      const response = (await api.runtime.sendMessage({ type: 'CANCEL_BREAK' })) as BreakResponse;
      if (!response?.ok || !response.status) {
        throw responseError(response, 'Could not end the break.');
      }
      onLock(response.status);
      onStatus('Break ended. Classifier blocking is restored.');
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="break-heading" className="flex flex-col gap-2.5">
      <h2 id="break-heading" className="m-0 text-[13px] font-medium">
        Take a break
      </h2>
      {scheduled ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card py-2.5 pl-3.5 pr-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p id="break-countdown" className="m-0 text-sm font-medium tabular-nums">
              {lock.breakActive
                ? `${formatClock((lock.breakEndsAt ?? now) - now)} left`
                : `Starts in ${formatClock((lock.breakNotBefore ?? now) - now)}`}
            </p>
            <p className="m-0 text-xs text-muted-foreground tabular-nums">
              {lock.breakActive
                ? `Classifier blocks resume at ${formatEndTime(lock.breakEndsAt ?? now, now)}. Your lock and rules stay on.`
                : `Break ends at ${formatEndTime(lock.breakEndsAt ?? now, now)}. Blocking stays on until it starts.`}
            </p>
          </div>
          <Button id="break-cancel" variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
            End break
          </Button>
        </div>
      ) : challenge ? (
        <>
          <p className="m-0 text-xs text-muted-foreground">
            Type this text exactly. Spaces and letter case are optional.
          </p>
          <code
            id="break-challenge"
            className="block whitespace-pre-wrap break-all rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed tracking-wide select-all"
          >
            {challenge}
          </code>
          <div className="flex items-center gap-2">
            <Input
              id="break-proof"
              value={proof}
              disabled={busy}
              onChange={(e) => setProof(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void verifyProof();
                }
              }}
              placeholder="Type the break text"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              aria-describedby="break-challenge"
            />
            <Button
              id="break-verify"
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => void verifyProof()}
            >
              Start break
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-xs text-muted-foreground">
            {mode === 'delay'
              ? delayMinutes > 0
                ? `Waits ${delayMinutes} ${delayMinutes === 1 ? 'minute' : 'minutes'}, then relaxes classifier blocks for ${durationMinutes} ${durationMinutes === 1 ? 'minute' : 'minutes'}.`
                : `Relaxes classifier blocks for ${durationMinutes} ${durationMinutes === 1 ? 'minute' : 'minutes'}.`
              : `Type ${challenge ? 'the' : 'a random'} text to relax classifier blocks for ${durationMinutes} ${durationMinutes === 1 ? 'minute' : 'minutes'}.`}{' '}
            Your lock and always-block rules stay on.
          </p>
          <Button
            id="break-start"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void requestStart()}
          >
            {mode === 'random-text' ? 'Show break text' : delayMinutes > 0 ? 'Schedule break' : 'Start break'}
          </Button>
        </>
      )}
    </section>
  );
}
