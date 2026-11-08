// Raw events.log lines (`<ms> <kind> <detail>`) → plain sentences.
// Kinds come from smartblocker-core daemon.rs / enforcer.rs. Anything not
// mapped here is "technical": hidden unless the user asks for it.

import type { ActivityEvent } from './api';
import { friendlyAppName } from './apps';
import { formatEndTime } from './format';

export type ActivityTone = 'closed' | 'info' | 'warning' | 'neutral';

export interface ActivityItem {
  event: ActivityEvent;
  /** Plain-language sentence; null = technical event. */
  text: string | null;
  tone: ActivityTone;
}

const KILL_RE = /^(.+?) pid (\d+) \((\w+)\)$/;

const LICENSE_TEXT: Record<string, string> = {
  pro: 'Pro license: active',
  'pro-grace': 'Pro license: expired — still working for a few more days',
  'free-expired': 'Pro license: expired',
  'free-no-key': 'Pro license: none — using the free features',
  'free-invalid': "Pro license: the saved key isn't valid",
  'dev-open': 'Pro license: developer mode, everything unlocked',
};

function killSentence(detail: string, dryRun: boolean): string | null {
  const m = KILL_RE.exec(detail.trim());
  if (!m) return null;
  const [, name, , reason] = m;
  const app = friendlyAppName(name);
  const verb = dryRun ? 'Would have closed' : 'Closed';
  const suffix = dryRun ? ' (test mode, nothing was closed)' : '';
  switch (reason) {
    case 'BlockedApp':
      return `${verb} ${app} — it's on your blocked list${suffix}`;
    case 'Watchdog':
      return `${verb} ${app} — SmartBlocker wasn't running in it${suffix}`;
    case 'IncompatibleBrowser':
      return `${verb} ${app} — browser not supported during locks${suffix}`;
    case 'DecoyImpersonation':
      return `${verb} a program pretending to be SmartBlocker${suffix}`;
    default:
      return `${verb} ${app}${suffix}`;
  }
}

function restoredSentence(detail: string): string {
  const parts = detail
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === 'licenseKey') {
    return 'Undid a settings change made during a lock (restored your license key)';
  }
  if (parts.length > 0) {
    return `Undid a settings change made during a lock (put ${parts.map(friendlyAppName).join(', ')} back on your blocked list)`;
  }
  return 'Undid a settings change made during a lock';
}

/** Detail is `until <ms>`; the end time reads relative to when it started. */
function focusStartSentence(e: ActivityEvent): string {
  const m = /^until (\d+)$/.exec(e.detail.trim());
  return m ? `Started a focus session until ${formatEndTime(Number(m[1]), e.tsMs)}` : 'Started a focus session';
}

export function describeEvent(e: ActivityEvent): ActivityItem {
  const item = (text: string | null, tone: ActivityTone = 'neutral'): ActivityItem => ({ event: e, text, tone });
  switch (e.kind) {
    case 'kill':
      return item(killSentence(e.detail, false), 'closed');
    case 'kill-dry-run':
      return item(killSentence(e.detail, true), 'closed');
    case 'focus-session-start':
      return item(focusStartSentence(e), 'info');
    case 'pair':
      return item('Connected a browser', 'info');
    case 'daemon-start':
      return item('Companion started', 'info');
    case 'config-tamper-restored':
      return item(restoredSentence(e.detail), 'warning');
    case 'clock-tamper-compensated':
      return item('Kept your lock running after the system clock was changed', 'warning');
    case 'license':
      return item(LICENSE_TEXT[e.detail.trim()] ?? `Pro license: ${e.detail.trim()}`, 'info');
    case 'notify':
      return item(e.detail.trim() ? sentenceStart(e.detail.trim()) : null, 'neutral');
    default:
      return item(null);
  }
}

/** Notification bodies start with the raw process name ("steam is blocked…"). */
function sentenceStart(s: string): string {
  const m = /^([a-z0-9._-]+)( is .*)$/.exec(s);
  if (m) return friendlyAppName(m[1]) + m[2];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function describeEvents(events: ActivityEvent[]): ActivityItem[] {
  return events.map(describeEvent);
}

/** Newest user-facing event, for the Home summary. */
export function latestVisible(events: ActivityEvent[]): ActivityItem | null {
  for (const e of events) {
    const d = describeEvent(e);
    if (d.text && e.kind !== 'notify') return d;
  }
  return null;
}
