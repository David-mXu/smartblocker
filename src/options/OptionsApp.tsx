import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Archive,
  Bell,
  CalendarBlank,
  ChartLineUp,
  Desktop,
  Gauge,
  Globe,
  LockSimple,
  Prohibit,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Target,
  TextAa,
  Timer,
  type Icon,
} from '@phosphor-icons/react';
import { api } from '../shared/api';
import { activeProfile } from '../shared/profiles';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { useOptionsState, type OptionsState } from './useOptionsState';
import { WelcomeWizard } from './welcome/WelcomeWizard';
import { BlockingPage } from './pages/BlockingPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { BackupPage } from './pages/BackupPage';
import { SitesPage } from './pages/SitesPage';
import { FocusPage } from './pages/FocusPage';
import { LocksPage } from './pages/LocksPage';
import { AllowancePage } from './pages/AllowancePage';
import { SchedulePage } from './pages/SchedulePage';
import { NotificationsPage } from './pages/NotificationsPage';
import { PreferencesPage } from './pages/PreferencesPage';
import { CompanionPage } from './pages/CompanionPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { AdvancedPage } from './pages/AdvancedPage';
import { UsagePage } from './pages/UsagePage';
import { DashboardPage } from './pages/DashboardPage';

// Options shell: slim header + sidebar + ONE page at a time, hash-routed
// (options.html#sites). #welcome renders the first-run wizard full-page.
// All state lives in useOptionsState; each page is a file in ./pages.

interface PageDef {
  id: string;
  label: string;
  icon: Icon;
  Component: (props: { state: OptionsState }) => React.ReactElement | null;
}

const PAGES: PageDef[] = [
  { id: 'dashboard', label: 'Now', icon: Gauge, Component: DashboardPage },
  { id: 'blocking', label: 'Blocking', icon: Prohibit, Component: BlockingPage },
  { id: 'profiles', label: 'Profiles', icon: Stack, Component: ProfilesPage },
  { id: 'backup', label: 'Backup', icon: Archive, Component: BackupPage },
  { id: 'sites', label: 'Sites', icon: Globe, Component: SitesPage },
  { id: 'focus', label: 'Focus', icon: Target, Component: FocusPage },
  { id: 'locks', label: 'Locks', icon: LockSimple, Component: LocksPage },
  { id: 'allowance', label: 'Breaks', icon: Timer, Component: AllowancePage },
  { id: 'schedule', label: 'Focus hours', icon: CalendarBlank, Component: SchedulePage },
  { id: 'notifications', label: 'Notifications', icon: Bell, Component: NotificationsPage },
  { id: 'preferences', label: 'Preferences', icon: TextAa, Component: PreferencesPage },
  { id: 'usage', label: 'Usage', icon: ChartLineUp, Component: UsagePage },
  { id: 'companion', label: 'Desktop app', icon: Desktop, Component: CompanionPage },
  { id: 'privacy', label: 'Privacy & data', icon: ShieldCheck, Component: PrivacyPage },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, Component: AdvancedPage },
];

/** Hashes from the old single-scroll page, so saved links still land. */
const LEGACY_HASHES: Record<string, string> = {
  categories: 'blocking',
  history: 'blocking',
  commitment: 'locks',
  schedules: 'schedule',
};

function routeFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, '')).toLowerCase();
  if (raw === 'welcome') return 'welcome';
  const id = LEGACY_HASHES[raw] ?? raw;
  return PAGES.some((p) => p.id === id) ? id : 'blocking';
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

function Wordmark() {
  return (
    <a href="#dashboard" className="flex min-w-0 items-center gap-2.5 text-foreground no-underline">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <LockSimple weight="bold" className="size-3.5" />
      </span>
      <span className="text-sm font-semibold tracking-tight">SmartBlocker</span>
      <span className="hidden text-faint sm:inline">/</span>
      <span className="hidden text-sm text-muted-foreground sm:inline">Settings</span>
    </a>
  );
}

export function OptionsApp() {
  const state = useOptionsState();
  const { settings, lock, saveStatus, modelProgress } = state;
  const route = useHashRoute();
  const isWelcome = route === 'welcome';
  const page = PAGES.find((p) => p.id === route) ?? PAGES[0];

  // Title + focus follow the route (skip focus on first paint). A layout
  // effect with a direct focus(): deferring it to the next frame let it land
  // AFTER the user's next interaction and steal focus back.
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    document.title = isWelcome ? 'Welcome — SmartBlocker' : `${page.label} — SmartBlocker settings`;
    document
      .querySelector('nav[aria-label="Settings pages"] a[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    window.scrollTo(0, 0);
    if (!isWelcome) {
      document.getElementById('page-heading')?.focus({ preventScroll: true });
    }
  }, [route]);

  const version = (() => {
    try {
      return api.runtime.getManifest().version;
    } catch {
      return '';
    }
  })();

  const onboarded = settings?.onboarded ?? true;
  const namedActive = state.profiles ? activeProfile(state.profiles) : null;
  const PageComponent = page.Component;

  const statusPill = lock.locked ? (
    <Badge variant="commit" dot>
      {lock.short}
    </Badge>
  ) : settings && !settings.enabled ? (
    <Badge dot>Paused</Badge>
  ) : (
    <Badge variant="success" dot>
      Blocking on
    </Badge>
  );

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 md:px-8">
          <Wordmark />
          <div className="flex min-w-0 items-center gap-3">
            <span
              id="save-msg"
              role="status"
              aria-live="polite"
              className={cn(
                'min-w-0 truncate text-xs font-medium transition-opacity duration-150',
                saveStatus.visible ? 'opacity-100' : 'opacity-0',
                saveStatus.error ? 'text-destructive-soft' : 'text-success-soft',
              )}
            >
              {saveStatus.text}
            </span>
            {statusPill}
          </div>
        </div>
        <div
          id="model-progress"
          role="status"
          style={{ display: modelProgress.visible ? 'block' : 'none' }}
          className="border-t border-border px-4 py-1.5 text-center font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          {modelProgress.text}
        </div>
      </header>

      {/* Lock seal — global, under the header, only while locked. */}
      <div
        id="lock-status"
        role="status"
        style={{ display: lock.locked ? 'block' : 'none' }}
        className="border-b border-accent/30 bg-accent/10"
      >
        <div className="mx-auto flex max-w-5xl items-start gap-2.5 px-4 py-2.5 text-[13px] font-medium text-accent-soft md:px-8">
          <LockSimple weight="fill" aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
          <span className="tabular-nums">{lock.banner}</span>
        </div>
      </div>

      {/* Named-profile scope, visible on every page so it is never ambiguous
          which policy an edit belongs to. */}
      <div
        id="active-profile-banner"
        style={{ display: !isWelcome && namedActive ? 'block' : 'none' }}
        className="border-b border-border bg-card"
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px] md:px-8">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Stack aria-hidden className="size-4 shrink-0 text-foreground" />
            <span className="truncate">
              <span className="font-medium text-foreground">{namedActive?.name}</span> profile active
              — its categories, sites, rules and desktop apps replace Default.
            </span>
          </span>
          <a
            href="#profiles"
            className="shrink-0 font-medium text-foreground no-underline underline-offset-2 hover:underline"
          >
            Manage profiles
          </a>
        </div>
      </div>

      {isWelcome ? (
        <WelcomeWizard
          onFinish={() => {
            location.hash = '#blocking';
          }}
        />
      ) : (
        <>
          <div
            id="banner"
            style={{ display: onboarded ? 'none' : 'block' }}
            className="border-b border-border bg-card"
          >
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
              <p className="m-0 text-sm text-foreground">
                <span className="font-medium">Finish setting up SmartBlocker</span>
                <span className="text-muted-foreground"> — 3 quick steps</span>
              </p>
              <a
                href="#welcome"
                className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground no-underline transition-colors hover:bg-primary/90"
              >
                Start setup
              </a>
            </div>
          </div>

          <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pb-24 pt-5 md:flex-row md:gap-12 md:px-8 md:pt-8">
            <nav aria-label="Settings pages" className="min-w-0 md:w-[180px] md:shrink-0">
              <ul className="-mx-4 m-0 flex list-none gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:sticky md:top-22 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:p-0">
                {PAGES.map((p) => {
                  const active = p.id === page.id;
                  const PageIcon = p.icon;
                  return (
                    <li key={p.id} className="shrink-0">
                      <a
                        href={`#${p.id}`}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-[13px] no-underline transition-colors',
                          'max-md:border max-md:px-3',
                          active
                            ? 'bg-muted font-medium text-foreground max-md:border-faint/50 md:before:absolute md:before:inset-y-1.5 md:before:-left-2 md:before:w-0.5 md:before:rounded-full md:before:bg-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground max-md:border-border',
                        )}
                      >
                        <PageIcon
                          aria-hidden
                          weight={active ? 'fill' : 'regular'}
                          className="hidden size-4 shrink-0 md:block"
                        />
                        {p.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-12">
              {settings ? <PageComponent state={state} /> : <div className="min-h-[50vh]" aria-busy="true" />}

              <footer className="flex flex-col gap-1 border-t border-border pt-6 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
                <span>
                  SmartBlocker{version ? ` v${version}` : ''} · checks pages on this device
                </span>
              </footer>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
