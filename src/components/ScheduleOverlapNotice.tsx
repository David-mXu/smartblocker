import React from 'react';
import { Warning } from '@phosphor-icons/react';
import type { ScheduleOverlapPair } from '../shared/schedule-overlaps';
import { Callout } from './ui/settings';
import { cn } from '../lib/utils';

interface ScheduleOverlapNoticeProps {
  /** Stable DOM id for the e2e suite (global vs category list). */
  id: string;
  pairs: ScheduleOverlapPair[];
  className?: string;
}

/** Quiet, non-blocking overlap notice. Overlaps are legal and common (a
 *  weekday window plus a shorter evening window); this explains the union
 *  instead of presenting an error. Renders nothing when no pair overlaps, so
 *  the page stays silent in the normal case. */
export function ScheduleOverlapNotice({ id, pairs, className }: ScheduleOverlapNoticeProps) {
  if (pairs.length === 0) return null;
  return (
    <Callout
      id={id}
      tone="warning"
      role="status"
      aria-live="polite"
      data-overlap-count={pairs.length}
      className={cn('flex gap-2.5', className)}
    >
      <Warning aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="m-0 font-medium">
          Overlapping schedules are allowed — blocking is the union.
        </p>
        <p className="m-0 mt-0.5 text-[12px] text-warning-soft/90">
          You don&apos;t need to fix anything; these windows simply run together.
        </p>
        <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[12px]">
          {pairs.slice(0, 3).map((pair) => (
            <li key={pair.key}>
              {pair.summary}. <span className="text-warning-soft/90">{pair.detail}</span>
            </li>
          ))}
          {pairs.length > 3 && (
            <li className="text-warning-soft/90">
              And {pairs.length - 3} more overlapping pair{pairs.length - 3 === 1 ? '' : 's'}.
            </li>
          )}
        </ul>
      </div>
    </Callout>
  );
}
