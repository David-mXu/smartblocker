// Typed command contract between the desktop UI and the Tauri shell
// (.ux-shots/DESKTOP-SPEC.md "Command contract"). The Rust side mirrors these
// shapes with #[serde(rename_all = "camelCase")]; Tauri 2 maps the camelCase
// argument keys below to snake_case Rust parameters.
//
// Transport: window.__TAURI__.core.invoke (withGlobalTauri) or, failing that,
// window.__TAURI_INTERNALS__.invoke (always injected by Tauri 2). With neither
// present — plain Chromium, Playwright, `vite preview` — every call goes to the
// in-memory mock in ./mock.ts so the UI can be built and screenshotted from
// WSL. The shell shows a "Preview data" badge whenever the mock is live.

import { mockInvoke } from './mock';

export type LockReason = 'timer' | 'password' | 'frozen' | 'schedule' | 'schedule-lead';

export interface PendingSession {
  untilMs: number;
  commitAtMs: number;
  durationMs: number;
}

export interface BrowserInfo {
  /** 'chrome' | 'edge' | 'firefox' */
  kind: string;
  extVersion: string;
  /** Wall-clock ms of the last heartbeat. */
  lastSeenMs: number;
}

export interface BrowserGraceInfo {
  kind: string;
  /** Daemon wall clock when graceRemainingMs was observed. */
  observedAtMs: number;
  graceSeconds: number;
  graceRemainingMs: number;
}

export type BrowserInstallationStatus = 'installed' | 'notDetected';
export type BrowserRegistrationStatus = 'healthy' | 'missing' | 'invalid' | 'unreadable';

export interface BrowserIntegration {
  browser: string;
  /** Positive executable/App-Paths evidence; not an installed-extension claim. */
  installation: BrowserInstallationStatus;
  /** Saved Native Messaging registration health, independent of connection. */
  registration: BrowserRegistrationStatus;
}

export interface BrowserRepairResult {
  browser: string;
  outcome: 'repaired' | 'alreadyHealthy' | 'notDetected' | 'skippedTestMode';
  registration: BrowserRegistrationStatus;
  /** Exact selected outcome; a repaired registration is not an installed extension. */
  message: string;
}

export type LicenseState = 'none' | 'valid' | 'expired' | 'grace' | 'invalid' | 'dev-open';

export interface LicenseInfo {
  pro: boolean;
  state: LicenseState;
  expiresAtMs: number | null;
  /** e.g. "SBPRO1…a3f9" — never the full key. */
  keyHint: string | null;
}

export interface LockInfo {
  settingsLocked: boolean;
  forceBlocking: boolean;
  reasons: LockReason[];
  /** Latest end of every timed lock source; null while only a password lock holds. */
  until: number | null;
}

export interface DesktopStatus {
  version: string;
  testMode: boolean;
  dataDir: string;
  daemon: { running: boolean; pid: number | null; startedAtMs: number | null };
  lock: LockInfo;
  pendingSession: PendingSession | null;
  /** Currently connected + authenticated browsers (daemon snapshot). */
  browsers: BrowserInfo[];
  /** Post-tick enforcer grace, retained even after a browser relay drops. */
  browserGrace: BrowserGraceInfo[];
  /** Installed-browser + registration evidence; empty means inspection failed. */
  browserIntegrations: BrowserIntegration[];
  /** Legacy contains entries, still honored verbatim. */
  appBlocklist: string[];
  /** Versioned typed exact identities (schema version 1). */
  appTargets: AppTarget[];
  appTargetsVersion: number;
  license: LicenseInfo;
  policyProtected: boolean;
  /** Read from the autostart plugin; `set_autostart` is the explicit control. */
  autostart: boolean;
  /** Effective whole-second grace before an extensionless browser is closed. */
  extensionLossGraceSeconds: number;
  extensionLossGraceMinSeconds: number;
  extensionLossGraceMaxSeconds: number;
}

/** visible: window on screen · open: minimized or on another desktop · background: no window. */
export type AppState = 'visible' | 'open' | 'background';

export interface RunningApp {
  /** Lowercase exe stem, no ".exe". */
  name: string;
  count: number;
  isBrowser: boolean;
  state: AppState;
  /** Normalized full exe path when readable. */
  exePath?: string;
  /** Microsoft Store package family name when Windows exposes it. */
  packageFamily?: string;
}

export type AppTarget =
  | { version: number; kind: 'exactStem'; stem: string }
  | { version: number; kind: 'exePath'; path: string }
  | { version: number; kind: 'msixPackage'; familyName: string };

/** One raw events.log line (`<ms> <kind> <detail>`), newest first. */
export interface ActivityEvent {
  tsMs: number;
  kind: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Local desktop app usage (companion/crates/smartblocker-core/src/usage.rs)
// ---------------------------------------------------------------------------

export interface UsageAppTotal {
  /** Lowercase executable stem. */
  id: string;
  /** Original executable basename; no path or window title. */
  label: string;
  activeMs: number;
}

export interface UsageDayTotal {
  /** YYYY-MM-DD in the computer's local time zone. */
  date: string;
  activeMs: number;
  wallMs: number;
}

export interface UsageTotals {
  /** Foreground app time while the user was active. */
  activeMs: number;
  /** Bounded awake observation time, including idle. */
  wallMs: number;
}

export interface UsageSummary {
  /** False where the companion cannot observe the foreground app. */
  available: boolean;
  platform: string;
  retentionDays: number;
  periodDays: number;
  generatedAtMs: number;
  /** Newest first, one row per local day in the selected period. */
  days: UsageDayTotal[];
  totals: UsageTotals;
  /** Aggregated across the period, sorted by active time. */
  apps: UsageAppTotal[];
  lastSampleAtMs: number | null;
}

export interface UsageAppExport {
  id: string;
  label: string;
  activeMs: number;
}

export interface UsageDayExport {
  date: string;
  activeMs: number;
  wallMs: number;
  apps: UsageAppExport[];
}

export interface UsageExport {
  version: number;
  generatedAtMs: number;
  retentionDays: number;
  periodDays: number;
  platform: string;
  metricDefinitions: {
    activeMs: string;
    wallMs: string;
    appIdentity: string;
    idleAndSleep: string;
    retention: string;
  };
  days: UsageDayExport[];
}

/** Command name → [args, result]. */
export interface Commands {
  get_status: [undefined, DesktopStatus];
  /** Reads the OS startup registration; test mode returns false unchanged. */
  get_autostart: [undefined, boolean];
  /** Explicit startup intent; returns the observed result (test mode: false). */
  set_autostart: [{ enabled: boolean }, boolean];
  /** Clamped to the status-reported min/max; returns the effective seconds. */
  set_extension_loss_grace_seconds: [{ seconds: number }, number];
  start_focus_session: [{ minutes: number }, PendingSession];
  undo_focus_session: [undefined, boolean];
  start_timer_lock: [{ minutes: number }, void];
  /** `targets` omitted = preserve typed targets for older callers. */
  set_app_blocklist: [{ apps: string[]; targets?: AppTarget[] }, void];
  list_running_apps: [undefined, RunningApp[]];
  get_recent_activity: [{ limit: number }, ActivityEvent[]];
  get_desktop_usage: [{ periodDays: number }, UsageSummary];
  export_desktop_usage: [{ periodDays: number }, UsageExport];
  clear_desktop_usage: [{ periodDays: number }, UsageSummary];
  set_license_key: [{ key: string }, LicenseInfo];
  install_integration: [undefined, string];
  /** Repairs one detected browser's registration, never its extension. */
  repair_browser: [{ browser: string }, BrowserRepairResult];
  /** Spawns the embedded companion if its socket is dead. */
  start_companion: [undefined, void];
}

export type CommandName = keyof Commands;
export type CommandArgs<K extends CommandName> = Commands[K][0];
export type CommandResult<K extends CommandName> = Commands[K][1];

type RawInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: RawInvoke } };
    __TAURI_INTERNALS__?: { invoke?: RawInvoke };
  }
}

function tauriInvoke(): RawInvoke | null {
  if (typeof window === 'undefined') return null;
  const global = window.__TAURI__?.core?.invoke;
  if (typeof global === 'function') return global;
  const internals = window.__TAURI_INTERNALS__?.invoke;
  if (typeof internals === 'function') return internals.bind(window.__TAURI_INTERNALS__);
  return null;
}

/** True when talking to the in-memory mock instead of the companion. */
export const IS_MOCK = tauriInvoke() === null;

export function invoke<K extends CommandName>(
  cmd: K,
  ...args: CommandArgs<K> extends undefined ? [] : [CommandArgs<K>]
): Promise<CommandResult<K>> {
  const real = tauriInvoke();
  const payload = args[0] as Record<string, unknown> | undefined;
  if (real) return real(cmd, payload) as Promise<CommandResult<K>>;
  return mockInvoke(cmd, payload) as Promise<CommandResult<K>>;
}

/**
 * Tauri rejects with the Rust `Err(String)` as a bare string; anything else
 * (Error, IPC failure object) is reduced to readable text.
 */
export function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return 'Something went wrong. Try again.';
}
