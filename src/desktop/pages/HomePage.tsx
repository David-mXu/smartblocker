import React, { useEffect, useState } from 'react';
import { AppWindow, Browsers, ClockCounterClockwise, LockSimple, WarningCircle } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import { errorText, invoke, type DesktopStatus, type LockReason } from '../api';
import { latestVisible } from '../activity';
import { summarizeApps } from '../apps';
import {
  SUPPORTED_BROWSERS,
  connectedBrowser,
  formatAgo,
  formatClock,
  formatDurationAdj,
  formatEndTime,
  formatRemaining,
  joinNames,
  protectedCount,
} from '../format';
import { DurationPicker, resolveMinutes, type DurationValue, type Preset } from '../components/DurationPicker';
import { FormMessage, LinkRow, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

const SESSION_PRESETS: Preset[] = [
  { mins: 60, label: '1h', name: '1 hour' },
  { mins: 240, label: '4h', name: '4 hours' },
  { mins: 480, label: '8h', name: '8 hours' },
];

export function HomePage() {
  const { status } = useStatus();
  const focusRunning = status.lock.reasons.includes('frozen');
  // A start refused because one is already pending swaps the form for the
  // countdown on the next poll; the hero keeps the refusal on screen.
  const [startRefusal, setStartRefusal] = useState<string | null>(null);
  const hasPending = status.pendingSession !== null;
  useEffect(() => {
    if (!hasPending) return;
    return () => setStartRefusal(null);
  }, [hasPending]);
  return (
    <div className="flex flex-col gap-9">
      <Hero notice={hasPending && startRefusal ? { tone: 'error', text: startRefusal } : null} />
      {!status.pendingSession && !focusRunning && <StartSession onRefused={setStartRefusal} />}
      <Overview />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero: the one focal element — is this computer protected right now?
// ---------------------------------------------------------------------------

type HeroTone = 'ok' | 'commit' | 'warning';

const LOCK_HEADLINE: Record<LockReason, string> = {
  frozen: 'Focus session',
  schedule: 'Focus hours',
  timer: 'Settings locked',
  password: 'Locked with a password',
};

function primaryReason(reasons: LockReason[]): LockReason {
  for (const r of ['frozen', 'schedule', 'timer', 'password'] as LockReason[]) if (reasons.includes(r)) return r;
  return reasons[0];
}

function Hero({ notice }: { notice: Message }) {
  const { status, now, refresh } = useStatus();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const pending = status.pendingSession;
  const lock = status.lock;

  // Confirmations fade; errors stay until the next action.
  useEffect(() => {
    if (msg?.tone !== 'ok') return;
    const id = window.setTimeout(() => setMsg(null), 5_000);
    return () => window.clearTimeout(id);
  }, [msg]);

  const undo = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const undone = await invoke('undo_focus_session');
      setMsg(
        undone
          ? { tone: 'ok', text: 'Undone — nothing was locked.' }
          : { tone: 'ok', text: 'It already locked in.' },
      );
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const startCompanion = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await invoke('start_companion');
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const startCompanionButton = (
    <Button id="start-companion" size="sm" onClick={startCompanion} disabled={busy}>
      Start companion
    </Button>
  );

  let tone: HeroTone;
  let headline: React.ReactNode;
  let body: React.ReactNode;
  let action: React.ReactNode = null;

  if (pending && now >= pending.commitAtMs) {
    // Undo has closed; the record lingers until the companion's next tick.
    tone = 'commit';
    headline = <span id="hero-locking">Locking…</span>;
    body = `Your focus session runs until ${formatEndTime(pending.untilMs, now)}.`;
  } else if (pending) {
    tone = 'commit';
    headline = <span id="hero-countdown">Locks in {formatClock(pending.commitAtMs - now)}</span>;
    body = (
      <>
        Your {formatDurationAdj(Math.round(pending.durationMs / 60_000))} focus session runs until{' '}
        {formatEndTime(pending.untilMs, now)}. Changed your mind? Undo now — once it locks, it can’t be cancelled.
      </>
    );
    action = (
      <Button id="undo-focus-session" variant="outline" size="sm" onClick={undo} disabled={busy}>
        Undo
      </Button>
    );
  } else if (lock.settingsLocked) {
    tone = 'commit';
    const reason = primaryReason(lock.reasons);
    headline =
      lock.until === null ? (
        LOCK_HEADLINE[reason]
      ) : (
        <>
          {LOCK_HEADLINE[reason]} — {formatRemaining(lock.until - now)} left
          <span className="font-normal text-accent-soft/70"> · until {formatEndTime(lock.until, now)}</span>
        </>
      );
    body =
      lock.until === null
        ? 'Blocked apps and unprotected browsers are closed until you unlock it in the SmartBlocker extension’s settings.'
        : reason === 'timer'
          ? 'Blocked apps and unprotected browsers are closed until then. You can add blocked apps, but not remove them.'
          : 'Blocked apps and unprotected browsers are closed until then. This can’t be cancelled.';
    if (!status.daemon.running) {
      tone = 'warning';
      body = 'The companion isn’t running, so apps and browsers aren’t being closed.';
      action = startCompanionButton;
    }
  } else if (!status.daemon.running) {
    tone = 'warning';
    headline = 'Companion isn’t running';
    body = 'Locks and app blocking need it. If it keeps stopping, repair the browser connection in Settings.';
    action = startCompanionButton;
  } else if (protectedCount(status) === 0) {
    tone = 'warning';
    headline = 'SmartBlocker isn’t connected to a browser';
    body = 'Install the SmartBlocker extension in Chrome, Edge or Firefox, then repair the browser connection.';
    action = (
      <a
        href="#browsers"
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[13px] font-medium text-foreground no-underline transition-colors hover:border-faint/50 hover:bg-muted"
      >
        Fix it
      </a>
    );
  } else {
    tone = 'ok';
    headline = 'You’re protected';
    const names = SUPPORTED_BROWSERS.filter((b) => connectedBrowser(status, b.kind)).map((b) => b.name);
    body = `SmartBlocker is connected in ${joinNames(names)}. When a lock is on, blocked apps and unprotected browsers are closed.`;
  }

  const icon =
    tone === 'commit' ? (
      <LockSimple weight="fill" className="size-5 text-accent" aria-hidden />
    ) : tone === 'warning' ? (
      <WarningCircle weight="fill" className="size-5 text-warning" aria-hidden />
    ) : (
      <span aria-hidden className="flex size-5 items-center justify-center">
        <span className="size-2.5 rounded-full bg-success" />
      </span>
    );

  return (
    <section
      id="hero"
      data-tone={tone}
      aria-labelledby="page-heading"
      className={cn(
        'flex flex-col gap-3 rounded-xl border px-5 py-5',
        tone === 'commit' && 'border-accent/30 bg-accent/10',
        tone === 'warning' && 'border-warning/30 bg-warning/10',
        tone === 'ok' && 'border-border bg-card',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1
            id="page-heading"
            tabIndex={-1}
            className={cn(
              'm-0 text-xl font-semibold tracking-tight tabular-nums outline-none',
              tone === 'commit' ? 'text-accent-soft' : tone === 'warning' ? 'text-warning-soft' : 'text-foreground',
            )}
          >
            {headline}
          </h1>
          <p className="m-0 max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">{body}</p>
        </div>
        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>
      {(msg ?? notice) && <FormMessage message={msg ?? notice} className="pl-8" />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Start a focus session
// ---------------------------------------------------------------------------

function StartSession({ onRefused }: { onRefused: (text: string | null) => void }) {
  const { status, now, refresh } = useStatus();
  const [value, setValue] = useState<DurationValue>({ choice: 60, customHours: '2', customMinutes: '30' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);

  const resolved = resolveMinutes(value);
  const daemonDown = !status.daemon.running;
  const end = 'minutes' in resolved ? now + resolved.minutes * 60_000 : null;

  const start = async () => {
    if (!('minutes' in resolved)) {
      setMsg({ tone: 'error', text: resolved.error });
      return;
    }
    setBusy(true);
    setMsg(null);
    onRefused(null);
    try {
      await invoke('start_focus_session', { minutes: resolved.minutes });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
      onRefused(errorText(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection
      aria-labelledby="start-session-heading"
      title={<span id="start-session-heading">Start a focus session</span>}
      description="Pick how long. SmartBlocker closes distractions until it ends."
    >
      <SettingsGroup>
        <div className="flex flex-col gap-4 px-4 py-4">
          <DurationPicker
            idPrefix="session"
            label="Focus session length"
            presets={SESSION_PRESETS}
            value={value}
            onChange={(v) => {
              setValue(v);
              if (msg?.tone === 'error') setMsg(null);
            }}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              id="start-focus-session"
              variant="commit"
              onClick={start}
              disabled={busy || daemonDown || !('minutes' in resolved)}
            >
              Start focus session
            </Button>
            <p id="focus-session-help" className="m-0 min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground tabular-nums">
              {daemonDown
                ? 'The companion isn’t running, so a focus session can’t start.'
                : end !== null
                  ? `Closes blocked apps and unprotected browsers until ${formatEndTime(end, now)}. You can undo for 1 minute.`
                  : 'error' in resolved
                    ? resolved.error
                    : ''}
            </p>
          </div>
          {msg && <FormMessage message={msg} />}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Overview rows linking to the other pages
// ---------------------------------------------------------------------------

function browserSummary(status: DesktopStatus): { label: string; description: string } {
  if (!status.daemon.running) {
    return { label: 'Browsers', description: 'Unknown while the companion isn’t running' };
  }
  const n = protectedCount(status);
  const missing = SUPPORTED_BROWSERS.filter((b) => !connectedBrowser(status, b.kind)).map((b) => b.name);
  return {
    label: `${n} of ${SUPPORTED_BROWSERS.length} browsers protected`,
    description: missing.length === 0 ? 'Chrome, Edge and Firefox are connected' : `${joinNames(missing)} not connected`,
  };
}

function Overview() {
  const { status, activity, now } = useStatus();
  const browsers = browserSummary(status);
  const apps = status.appBlocklist;
  const last = activity ? latestVisible(activity) : null;

  return (
    <SettingsSection title="Overview">
      <SettingsGroup>
        <LinkRow
          href="#browsers"
          leading={<Browsers className="size-[18px]" />}
          label={browsers.label}
          description={browsers.description}
        />
        <LinkRow
          href="#apps"
          leading={<AppWindow className="size-[18px]" />}
          label={apps.length ? summarizeApps(apps) : 'No blocked apps yet'}
          description={apps.length ? 'Closed during focus sessions and other locks' : 'Add games or chat apps to close them during focus sessions'}
        />
        <LinkRow
          href="#activity"
          leading={<ClockCounterClockwise className="size-[18px]" />}
          label={last?.text ?? (activity === null ? 'Recent activity' : 'No activity yet')}
          description={
            last
              ? `Last activity · ${formatAgo(last.event.tsMs, now)}`
              : activity === null
                ? '\u00a0'
                : 'What the companion closes shows up here'
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
