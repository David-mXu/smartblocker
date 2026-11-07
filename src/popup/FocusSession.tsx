import React, { useRef } from 'react';
import { LockSimple } from '@phosphor-icons/react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import type { PendingFocusSession } from '../shared/focus-session';
import { formatClock, formatEndTime, formatRemaining } from './popup-model';

export const SESSION_PRESETS = [
  { mins: 60, label: '1h', name: '1 hour' },
  { mins: 240, label: '4h', name: '4 hours' },
  { mins: 480, label: '8h', name: '8 hours' },
] as const;

interface Props {
  now: number;
  selectedMins: number;
  onSelect: (mins: number) => void;
  pending: PendingFocusSession | null;
  /** Committed session end, if one is running. */
  frozenUntil: number | null;
  busy: boolean;
  onStart: () => void;
  onUndo: () => void;
}

/**
 * "Focus session" (internally Frozen Turkey): pick a length, start, and get a
 * 60-second undo window before it locks for real. All three states share one
 * reserved height so starting a session never shifts the popup.
 */
export function FocusSession({
  now,
  selectedMins,
  onSelect,
  pending,
  frozenUntil,
  busy,
  onStart,
  onUndo,
}: Props) {
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onChipKey = (e: React.KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + SESSION_PRESETS.length) % SESSION_PRESETS.length;
    onSelect(SESSION_PRESETS[next].mins);
    chipRefs.current[next]?.focus();
  };

  let body: React.ReactNode;
  if (frozenUntil !== null && !pending) {
    body = (
      <div className="flex items-start gap-2.5">
        <LockSimple weight="fill" className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="flex flex-col gap-0.5">
          <p id="focus-session-active" className="m-0 text-sm font-medium tabular-nums">
            Running until {formatEndTime(frozenUntil, now)}
          </p>
          <p className="m-0 text-xs text-muted-foreground tabular-nums">
            {formatRemaining(frozenUntil - now)} left. Distractions stay blocked until then.
          </p>
        </div>
      </div>
    );
  } else if (pending) {
    const left = pending.commitAt - now;
    body = (
      <>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/10 py-2.5 pl-3.5 pr-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p id="focus-session-countdown" className="m-0 text-sm font-semibold text-accent-soft tabular-nums">
              Locks in {formatClock(left)}
            </p>
            <p className="m-0 text-xs text-muted-foreground tabular-nums">
              Distractions stay blocked until {formatEndTime(pending.until, now)}. Changed your mind? Undo
              now — once it locks, it can’t be cancelled.
            </p>
          </div>
          <Button id="undo-focus-session" variant="outline" size="sm" onClick={onUndo} disabled={busy}>
            Undo
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div
          role="radiogroup"
          aria-label="Focus session length"
          className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-background p-0.5"
        >
          {SESSION_PRESETS.map(({ mins, label, name }, i) => {
            const checked = mins === selectedMins;
            return (
              <button
                key={mins}
                ref={(el) => {
                  chipRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={name}
                tabIndex={checked ? 0 : -1}
                data-mins={mins}
                onClick={() => onSelect(mins)}
                onKeyDown={(e) => onChipKey(e, i)}
                className={cn(
                  'frozen-btn h-8 cursor-pointer rounded-md text-[13px] font-medium tabular-nums transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring/70',
                  checked
                    ? 'bg-secondary text-foreground ring-1 ring-faint/40'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Button id="start-focus-session" variant="commit" className="w-full" onClick={onStart} disabled={busy}>
          Start focus session
        </Button>
        <p id="focus-session-help" className="m-0 text-xs text-muted-foreground tabular-nums">
          Blocks distractions until {formatEndTime(now + selectedMins * 60_000, now)}. You can undo for 1
          minute, then it can’t be cancelled.
        </p>
      </>
    );
  }

  return (
    <section aria-labelledby="focus-session-heading" className="flex flex-col gap-2.5">
      <h2 id="focus-session-heading" className="m-0 text-[13px] font-medium">
        Focus session
      </h2>
      <div className={cn('flex flex-col gap-2.5', frozenUntil !== null && !pending ? undefined : 'min-h-[124px]')}>{body}</div>
    </section>
  );
}
