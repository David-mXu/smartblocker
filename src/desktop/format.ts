// Wording + time formatting for the desktop app. Pure functions (no React,
// no Tauri) — the same phrasing as the extension popup (src/popup/popup-model.ts)
// so "Locks in 0:42" and "until 4:28 PM" read identically on every surface.

import { deriveExtensionGrace, type ExtensionGraceResult } from '../shared/grace-math';
import type { BrowserInfo, DesktopStatus, LockInfo, LockReason } from './api';

/** "3:40 PM", "1:15 AM tomorrow", or "Mon 3:40 PM" further out. */
export function formatEndTime(ts: number, now = Date.now()): string {
  const end = new Date(ts);
  const time = clockTime(end);
  const dayDiff = calendarDayDiff(ts, now);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `${time} tomorrow`;
  if (dayDiff < 7) return `${end.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "3h 12m", "45m", "2d 4h", "under a minute". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const mins = Math.ceil(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h === 0 ? `${d}d` : `${d}d ${h}h`;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "0:42" — the undo countdown. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "1 hour", "4 hours", "90 minutes", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hs = h === 1 ? '1 hour' : `${h} hours`;
  const ms = m === 1 ? '1 minute' : `${m} minutes`;
  if (h === 0) return ms;
  return m === 0 ? hs : `${hs} ${ms}`;
}

/** "4-hour", "90-minute", "2h 30m" — for "your 4-hour focus session". */
export function formatDurationAdj(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  if (minutes < 60) return `${minutes}-minute`;
  return formatRemaining(minutes * 60_000);
}

export function calendarDayDiff(ts: number, now = Date.now()): number {
  const a = new Date(ts);
  const b = new Date(now);
  return Math.round(
    (new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() -
      new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()) /
      86_400_000,
  );
}

/** "just now", "12 min ago", "3 h ago", "yesterday", "Nov 3". */
export function formatAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  const days = -calendarDayDiff(ts, now);
  if (days === 0) return `${Math.round(diff / 3_600_000)} h ago`;
  if (days === 1) return 'yesterday';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "Today", "Yesterday", "Monday, Nov 3". */
export function dayHeading(ts: number, now = Date.now()): string {
  const days = -calendarDayDiff(ts, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function formatTime(ts: number): string {
  return clockTime(new Date(ts));
}

/** Locale clock time, with "a.m."/"p.m." (en-CA) written "AM"/"PM" so a time
 *  ending a sentence doesn't produce "until 9:20 p.m..". */
function clockTime(d: Date): string {
  return d
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(/\s*([ap])\.m\.$/i, (_, x: string) => ` ${x.toUpperCase()}M`);
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

const REASON_NAMES: Record<LockReason, string> = {
  frozen: 'focus session',
  timer: 'settings lock',
  password: 'password lock',
  schedule: 'focus hours',
  'schedule-lead': 'focus hours lead-in',
};

export function reasonsText(reasons: LockReason[]): string {
  return reasons.map((r) => REASON_NAMES[r] ?? r).join(' + ');
}

/** "Locked: focus session — 3h 12m left (until 4:28 PM)". Empty when unlocked. */
export function lockLineText(lock: LockInfo, now = Date.now()): string {
  if (!lock.settingsLocked) return '';
  const reasons = reasonsText(lock.reasons) || 'lock';
  if (lock.until === null) return `Locked: ${reasons} — unlock it from the browser extension`;
  return `Locked: ${reasons} — ${formatRemaining(lock.until - now)} left (until ${formatEndTime(lock.until, now)})`;
}

/** Short reason attached to every control a lock disables. */
export function lockedUntilText(lock: LockInfo, now = Date.now()): string {
  if (!lock.settingsLocked) return '';
  if (lock.until === null) return 'Locked by your password lock';
  return `Locked until ${formatEndTime(lock.until, now)}`;
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

export const SUPPORTED_BROWSERS = [
  { kind: 'chrome', name: 'Chrome' },
  { kind: 'edge', name: 'Edge' },
  { kind: 'firefox', name: 'Firefox' },
] as const;

export function connectedBrowser(status: DesktopStatus, kind: string): BrowserInfo | undefined {
  return status.browsers.find((b) => b.kind.toLowerCase() === kind);
}

/** Count down from the desktop snapshot's own observation timestamp. */
export function browserGrace(
  status: DesktopStatus,
  kind: string,
  now: number,
): ExtensionGraceResult | null {
  const observed = status.browserGrace.find((b) => b.kind === kind);
  if (!observed) return null;
  return deriveExtensionGrace(
    now,
    {
      state: 'grace',
      observedAtMs: observed.observedAtMs,
      lastHeartbeatAtMs: null,
      graceRemainingMs: observed.graceRemainingMs,
    },
    observed.graceSeconds,
  );
}

export function protectedCount(status: DesktopStatus): number {
  return SUPPORTED_BROWSERS.filter((b) => connectedBrowser(status, b.kind)).length;
}

/** "seen just now" / "seen 2 min ago". */
export function seenText(lastSeenMs: number, now = Date.now()): string {
  const ago = formatAgo(lastSeenMs, now);
  return `seen ${ago}`;
}

/** "Chrome, Edge" / "Chrome and Edge" / "Chrome, Edge and Firefox". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
