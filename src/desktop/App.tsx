import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Browsers,
  ClockCounterClockwise,
  GearSix,
  House,
  LockSimple,
  Prohibit,
  WarningCircle,
  type Icon,
} from '@phosphor-icons/react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { IS_MOCK, errorText, invoke } from './api';
import { formatClock, formatEndTime, lockLineText, protectedCount } from './format';
import { DesktopProvider, useDesktop } from './useDesktop';
import { HomePage } from './pages/HomePage';
import { AppsPage } from './pages/AppsPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';

// Desktop companion window: 220px sidebar + one page at a time, hash-routed
// like the extension options page (#home, #apps, #browsers, #activity,
// #settings). Dark Lamplight only.

interface PageDef {
  id: string;
  label: string;
  title: string;
  icon: Icon;
  Component: () => React.ReactElement | null;
}

const PAGES: PageDef[] = [
  { id: 'home', label: 'Home', title: 'SmartBlocker', icon: House, Component: HomePage },
  { id: 'apps', label: 'Blocked apps', title: 'Blocked apps — SmartBlocker', icon: Prohibit, Component: AppsPage },
  { id: 'browsers', label: 'Browsers', title: 'Browsers — SmartBlocker', icon: Browsers, Component: BrowsersPage },
  {
    id: 'activity',
    label: 'Activity',
    title: 'Activity — SmartBlocker',
    icon: ClockCounterClockwise,
    Component: ActivityPage,
  },
  { id: 'settings', label: 'Settings', title: 'Settings — SmartBlocker', icon: GearSix, Component: SettingsPage },
];

function routeFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, '')).toLowerCase();
  return PAGES.some((p) => p.id === raw) ? raw : 'home';
}

function useHashRoute(): string {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function App() {
  return (
    <DesktopProvider>
      <Shell />
    </DesktopProvider>
  );
}

function Shell() {
  const { status, statusError } = useDesktop();
  const route = useHashRoute();
  const page = PAGES.find((p) => p.id === route) ?? PAGES[0];
  const mainRef = useRef<HTMLElement>(null);

  // Layout effect, not rAF: the heading takes focus in the same commit that
  // renders the page, so it can never land after the user's next interaction.
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    document.title = page.title;
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.scrollTo(0, 0);
    document.getElementById('page-heading')?.focus({ preventScroll: true });
  }, [route]);

  const PageComponent = page.Component;

  return (
    <div className="flex h-screen min-h-[540px] w-full min-w-[760px] overflow-hidden bg-background text-foreground">
      <Sidebar activeId={page.id} />
      <main ref={mainRef} id="content" className="relative min-w-0 flex-1 overflow-y-auto">
        <LockLine onHome={page.id === 'home'} />
        <div className="mx-auto w-full max-w-[640px] px-8 pb-16 pt-8">
          {status ? (
            <PageComponent />
          ) : statusError ? (
            <ShellError text={statusError} />
          ) : (
            <div className="min-h-[50vh]" aria-busy="true" aria-label="Loading" />
          )}
        </div>
      </main>
    </div>
  );
}

function ShellError({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 px-1 pt-10">
      <h1 id="page-heading" tabIndex={-1} className="m-0 text-xl font-semibold tracking-tight outline-none">
        Can't reach SmartBlocker
      </h1>
      <p className="m-0 max-w-[60ch] text-[13px] text-muted-foreground">
        The window couldn't read the companion's status. Close and reopen SmartBlocker.
      </p>
      <p className="m-0 font-mono text-xs text-faint">{text}</p>
    </div>
  );
}

function Sidebar({ activeId }: { activeId: string }) {
  const { status } = useDesktop();
  const daemonDown = status ? !status.daemon.running : false;
  const noBrowsers = status ? status.daemon.running && protectedCount(status) === 0 : false;

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LockSimple weight="bold" aria-hidden className="size-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight">SmartBlocker</span>
      </div>

      <nav aria-label="Pages" className="px-3 pt-2">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {PAGES.map((p) => {
            const active = p.id === activeId;
            const PageIcon = p.icon;
            let meta: React.ReactNode = null;
            if (status && p.id === 'apps' && status.appBlocklist.length > 0) {
              meta = <span className="font-mono text-[11px] tabular-nums text-faint">{status.appBlocklist.length}</span>;
            }
            if (status && p.id === 'browsers' && status.daemon.running) {
              meta = noBrowsers ? (
                <WarningCircle weight="fill" aria-label="No browsers connected" className="size-3.5 text-warning" />
              ) : (
                <span className="font-mono text-[11px] tabular-nums text-faint">{protectedCount(status)}/3</span>
              );
            }
            if (p.id === 'home' && daemonDown) {
              meta = <WarningCircle weight="fill" aria-label="Companion isn't running" className="size-3.5 text-warning" />;
            }
            return (
              <li key={p.id}>
                <a
                  href={`#${p.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] no-underline transition-colors duration-150',
                    active
                      ? 'bg-muted font-medium text-foreground before:absolute before:inset-y-1.5 before:-left-3 before:w-0.5 before:rounded-full before:bg-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <PageIcon aria-hidden weight={active ? 'fill' : 'regular'} className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{p.label}</span>
                  {meta}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {status?.license.pro ? (
            <Badge variant="outline" id="plan-badge">
              Pro
            </Badge>
          ) : (
            <Badge variant="outline" id="plan-badge" className="text-faint">
              Free
            </Badge>
          )}
          {status?.testMode && (
            <Badge variant="warning" dot id="test-mode-badge">
              Test mode
            </Badge>
          )}
          {IS_MOCK && (
            <Badge dot id="preview-badge" title="This window isn't connected to the companion; it shows sample data.">
              Preview data
            </Badge>
          )}
        </div>
        <span className="font-mono text-[11px] tabular-nums text-faint">
          {status ? `v${status.version}` : ' '}
        </span>
      </div>
    </aside>
  );
}

/**
 * Global amber seal line while locked (same copy as the popup's #lock-line),
 * plus — away from Home — the pending-session countdown with Undo, so the
 * 60-second "oops" window is reachable from every page.
 */
function LockLine({ onHome }: { onHome: boolean }) {
  const { status, now, refresh } = useDesktop();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!status) return null;
  // On Home the hero already states the lock; the seal line would repeat it.
  const locked = status.lock.settingsLocked && !onHome;
  const pending = status.pendingSession;
  const showPending = pending && !onHome;
  // Undo closes at commitAtMs, but the record can linger for one companion tick.
  const locking = pending !== null && now >= pending.commitAtMs;
  if (!locked && !showPending && !msg) return null;

  const undo = async () => {
    setBusy(true);
    try {
      const undone = await invoke('undo_focus_session');
      setMsg(undone ? 'Focus session undone — nothing was locked.' : 'It already locked in.');
      window.setTimeout(() => setMsg(null), 4_000);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <div className="sticky top-0 z-30 flex flex-col">
      {locked && (
        <div id="lock-line" role="status" className="border-b border-accent/30 bg-accent/10">
          <div className="mx-auto flex max-w-[640px] items-center gap-2.5 px-9 py-2.5 text-[13px] font-medium text-accent-soft">
            <LockSimple weight="fill" aria-hidden className="size-4 shrink-0 text-accent" />
            <span className="tabular-nums">{lockLineText(status.lock, now)}</span>
          </div>
        </div>
      )}
      {showPending && (
        <div id="pending-line" role="status" className="border-b border-accent/30 bg-accent/10">
          <div className="mx-auto flex max-w-[640px] items-center justify-between gap-3 px-9 py-2 text-[13px] text-accent-soft">
            <span className="tabular-nums">
              <span className="font-semibold">
                {locking ? (msg ?? 'Locking…') : `Focus session locks in ${formatClock(pending.commitAtMs - now)}`}
              </span>
              <span className="text-muted-foreground"> · runs until {formatEndTime(pending.untilMs, now)}</span>
            </span>
            {!locking && (
              <Button id="pending-line-undo" variant="outline" size="xs" onClick={undo} disabled={busy}>
                Undo
              </Button>
            )}
          </div>
        </div>
      )}
      {msg && !showPending && (
        <div role="status" className="border-b border-border bg-card">
          <p className="mx-auto my-0 max-w-[640px] px-9 py-2 text-[13px] text-muted-foreground">{msg}</p>
        </div>
      )}
    </div>
  );
}
