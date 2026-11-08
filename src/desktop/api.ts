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

export type LockReason = 'timer' | 'password' | 'frozen' | 'schedule';

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
  appBlocklist: string[];
  license: LicenseInfo;
  policyProtected: boolean;
  /** Read from the autostart plugin. Display only: no command turns it off. */
  autostart: boolean;
}

/** visible: window on screen · open: minimized or on another desktop · background: no window. */
export type AppState = 'visible' | 'open' | 'background';

export interface RunningApp {
  /** Lowercase exe stem, no ".exe". */
  name: string;
  count: number;
  isBrowser: boolean;
  state: AppState;
}

/** One raw events.log line (`<ms> <kind> <detail>`), newest first. */
export interface ActivityEvent {
  tsMs: number;
  kind: string;
  detail: string;
}

/** Command name → [args, result]. */
export interface Commands {
  get_status: [undefined, DesktopStatus];
  start_focus_session: [{ minutes: number }, PendingSession];
  undo_focus_session: [undefined, boolean];
  start_timer_lock: [{ minutes: number }, void];
  set_app_blocklist: [{ apps: string[] }, void];
  list_running_apps: [undefined, RunningApp[]];
  get_recent_activity: [{ limit: number }, ActivityEvent[]];
  set_license_key: [{ key: string }, LicenseInfo];
  install_integration: [undefined, string];
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
