import React from 'react';
import type { CompanionSnapshot } from '../shared/companion-protocol';
import {
  deriveExtensionGrace,
  extensionGraceText,
  type ExtensionGraceObservation,
} from '../shared/grace-math';
import { cn } from '../lib/utils';

interface ExtensionGraceNoticeProps {
  id: string;
  /** Browser-close enforcement has consequences only while a lock is active. */
  locked: boolean;
  companion: CompanionSnapshot | null;
  now: number;
  /** Validated enforcing-peer observation, or null for old peers/disconnect. */
  observation?: ExtensionGraceObservation | null;
  /** Must come from the enforcer too; a local setting would not control it. */
  graceSeconds?: number | null;
  className?: string;
}

/** Locked-only extension-loss warning. Real daemon observations render the
 *  per-second countdown. A known companion without a live observation (older
 *  daemon or disconnected relay) gets an explicitly non-numeric warning;
 *  not-installed and never-observed companions stay completely quiet. */
export function ExtensionGraceNotice({
  id,
  locked,
  companion,
  now,
  observation = null,
  graceSeconds = null,
  className,
}: ExtensionGraceNoticeProps) {
  const grace = deriveExtensionGrace(now, observation, graceSeconds);
  const observedDisconnect =
    companion?.state === 'disconnected' && companion.status?.enforcement.watchdog === true;
  const showUnknown =
    grace.state === 'unknown' && (observation !== null || observedDisconnect);
  const visible = locked && (grace.state === 'grace' || grace.state === 'expired' || showUnknown);

  if (!visible) return null;
  return (
    <div
      id={id}
      role="status"
      // Do not make assistive technology announce a new number every second;
      // transitions into the non-ticking states still announce politely.
      aria-live={grace.state === 'grace' ? 'off' : 'polite'}
      className={cn(
        'rounded-lg border border-warning/30 bg-warning/10 px-3.5 py-3 text-[13px] leading-snug text-warning-soft tabular-nums',
        className,
      )}
    >
      {extensionGraceText(grace)}
    </div>
  );
}
