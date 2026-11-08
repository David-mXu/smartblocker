import type { LockStatus } from '../shared/lock-math';

// Pure display helpers shared by the options pages.

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** "3h 12m" / "2d 4h" / "45m" — always at least 1m. */
export function formatRemaining(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3:40 PM" today, "Tue 3:40 PM" within a week, else "Nov 14, 3:40 PM". */
export function formatClock(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  if (ts - now < 6 * 86_400_000) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "0:42" countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function minutesToHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function hhmmToMinutes(v: string): number {
  const [h = 0, m = 0] = v.split(':').map(Number);
  return h * 60 + m;
}

/** 540 → "9:00 AM" in the user's locale. */
export function minutesToClock(mins: number): string {
  const d = new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Sentence-case a stored lowercase label, acronyms fixed ("movies and tv shows" → "Movies and TV shows"). */
export { displayLabel } from '../shared/labels';

export const REASON_NAMES: Record<LockStatus['reasons'][number], string> = {
  timer: 'timer lock',
  password: 'password lock',
  delay: 'delay lock',
  'random-text': 'random-text lock',
  frozen: 'focus session',
  schedule: 'focus hours',
};

/** Header pill: "Locked · 3h 12m". */
export function lockShortText(status: LockStatus): string {
  return status.until ? `Locked · ${formatRemaining(status.until - Date.now())}` : 'Locked';
}

/** Seal line: "Locked: focus session — unlocks in 3h 12m (3:40 PM)". */
export function lockBannerText(status: LockStatus): string {
  const reasons = status.reasons.map((r) => REASON_NAMES[r]).join(', ');
  const explicitReasons = status.reasons.filter((r) => ['password', 'delay', 'random-text'].includes(r));
  const tail = status.until
    ? ` — unlocks in ${formatRemaining(status.until - Date.now())} (${formatClock(status.until)})`
    : status.delayReady
      ? ' — the unlock delay elapsed; the background will complete it'
      : explicitReasons.length > 1
        ? ' — unlock each lock on the Locks page; other locks stay on'
        : status.delayUntil !== undefined
          ? status.delayUntil === 0
            ? ' — start the unlock countdown on the Locks page'
            : ` — the unlock countdown ends at ${formatClock(status.delayUntil ?? Date.now())}`
          : status.randomTextLen !== undefined
            ? ' — type a fresh random-text challenge on the Locks page'
            : ' — unlocks when you enter your password on the Locks page';
  return `Locked: ${reasons}${tail}`;
}

/** Inline reason next to disabled controls: "Locked until 3:40 PM". */
export function lockReasonText(status: LockStatus): string {
  if (status.until) return `Locked until ${formatClock(status.until)}`;
  if (status.delayReady) return 'Locked while the background completes the elapsed delay';
  if (typeof status.delayUntil === 'number' && status.delayUntil > 0) {
    return `Locked — unlock countdown ends ${formatClock(status.delayUntil)}`;
  }
  if (status.reasons.length === 1 && status.reasons[0] === 'password') {
    return 'Locked until you enter your password';
  }
  return 'Locked — use the Locks page to unlock';
}
