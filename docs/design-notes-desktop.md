# SmartBlocker desktop companion — UI spec

The desktop app follows the **Lamplight** design system in
[design-notes.md](design-notes.md) (tokens, components, rules). This file only
records what is specific to the desktop surface. Learning note:
[2026-11-08-desktop-companion-ux-revamp.md](learning-notes/2026-11-08-desktop-companion-ux-revamp.md).

## Structure

- **Frontend:** React + Vite in `src/desktop/`, reusing the extension's
  `src/components/ui/*`, `src/styles/*` and self-hosted Geist.
  `npm run build:desktop` writes `companion/crates/smartblocker-companion/ui-dist/`
  (gitignored; Tauri runs it via `beforeBuildCommand`).
- **Bundle constraints:** a classic deferred script (Chromium refuses module
  scripts on `file://`), one linked CSS file, no `data:` URIs — the window CSP
  is `default-src 'self'; style-src 'self' 'unsafe-inline'`.
- **Window:** 900×620, minimum 760×540.
- **Transport:** `src/desktop/api.ts` is the typed command contract.
  `window.__TAURI__` when present, otherwise the in-memory mock in `mock.ts`
  (`?mock=<scenarios>`, `?fast=1`). The mock shows a "Preview data" badge, so a
  misconfigured window can't quietly display a fake "You're protected".
- **Errors** from Rust are displayed verbatim, so they must be plain language
  ("companion", never "daemon", "socket" or "IPC").

## Pages (sidebar, hash routes, one page at a time)

| Page | Purpose |
| :-- | :-- |
| **Home** | Focal status: "You're protected" / "SmartBlocker isn't connected to a browser" / "Focus session — 3h 12m left · until 4:28 PM" (amber) / "Locks in 0:42" + Undo / "Locking…" / companion not running + "Start companion". Then Start a focus session (1h/4h/8h/custom) and an overview linking to other pages. |
| **Blocked apps** | Current list (removal disabled while locked — add-only), add by exact name or legacy contains match, add from running apps with exact/path/Store package identity and a match preview. |
| **Browsers** | Chrome/Edge/Firefox protected or not, and how to fix it ("Repair browser connection"). |
| **Activity** | Day-grouped sentences from `events.log`; unknown kinds sit behind "Show technical events". |
| **Usage** | Local foreground-app active time: period totals, Top apps with an aggregate "Other", daily bars, export, and clear. Separate from Activity (what the companion did) — this is what you did. |
| **Settings** | Lock settings for a time, Pro license, browser connection, Start with Windows (read-only state), About. |

The amber lock line shows on every page except Home, whose hero already states
the lock.

## Focus session

Same model as the extension: a **deferred commit** with a 60-second undo,
implemented in `smartblocker-core/src/focus_session.rs` so it survives closing
the window. Three states: can undo → **"Locking…"** (from `commitAtMs` until the
daemon's next tick, no Undo) → locked. An undo that loses the race reads "It
already locked in." and is not an error.

## App names and identities

Blocked-app entries and the running-apps picker share
`procwatch::normalize_exe_stem` (lowercase, no `.exe`, no self-updater version
suffix like `agy.exe.1793826601058390500`), so a picked name keeps matching
after the app updates itself.

The picker's default **exact** identity is a Microsoft Store package family
name when Windows exposes one, otherwise the normalized full exe path,
otherwise the exe stem. Exact path matching is equality after Windows
normalization (case, separators, UNC/long-path prefix, `.`/`..`), never a
folder prefix. The separate **contains match** button preserves the old
`appBlocklist` semantics (`steam` also closes `steamwebhelper`) and shows
which running apps that would cover. The list stores both shapes
(`appTargets` + legacy `appBlocklist`) so old configs keep working; removals
stay disabled while locked.

## Running-apps order

The picker lists every running app in three groups, each sorted by name:
**On your screen** (a taskbar-style window showing), **Open, not on your screen**
(minimized or on another virtual desktop), **Running in the background** (no such
window). An app takes the most present state of any of its processes.
`apps.rs window_state` decides per window. Browsers stay off the list (Browsers
page), and OS plumbing stays off because closing it would break the session.

## App usage

`smartblocker-core/src/usage.rs` owns a bounded, local-only foreground tracker,
separate from the browser extension's `usageStats:v1` and from `events.log`.
The daemon samples the focused executable every five seconds; the interval that
ended at a sample is charged to the previous sample's app only when the user was
active (`GetLastInputInfo` under 30s). Sleep/shutdown gaps over 30s are dropped,
so time is always **active foreground time**, not wall time. The page also shows
bounded "at the computer" time: the same awake intervals including idle.

Days are civil local dates, split at the next local midnight rather than +24h,
so midnight rollover and 23/25-hour DST days are exact. The persisted
`usage-state.json` is versioned and sanitized on every load, keeps the newest 35
local days, caps 80 app rows per day (the remainder folds into an explicit
`other.apps` row), and stores only the executable basename (lowercase stem id +
bounded label) plus millisecond totals — never a window title, path, document or
URL. The checkpoint enables at most one bounded 30-second interval of restart
recovery; longer shutdowns discard the gap. Usage never influences blocking.

The live daemon owns the in-memory tracker: the UI queries summary/export/clear
over the companion's local IPC (`UsageCommand`/`UsageResult`), and clear is
answered only after the reset is persisted. When the daemon isn't running, the
Tauri shell reads or clears the same file directly. Windows is the only
implemented probe; elsewhere the page says tracking is unavailable rather than
guessing from a process table. The probe has not yet been run on real Windows
hardware — see `#usage` with the mock scenarios `usage-empty`,
`usage-unavailable`, and `usage-error`.

Learning note: [2026-11-09-desktop-usage-analytics.md](learning-notes/2026-11-09-desktop-usage-analytics.md).

## Test mode

Debug builds only, plus env `SMARTBLOCKER_TEST_MODE=1`: scratch data dir,
separate socket, `dry_run_kills`, log-only notifier, `policy_enforce` forced off,
no registry or autostart writes, "Test mode" badge. A release build can't enter
it. Never run the app outside test mode to exercise locks on a machine with real
browsers open: the watchdog closes browsers with no connected extension.

## Known gaps

- Apps closed to the system tray count as background: Windows has no supported
  way to list tray icons.
- The Windows foreground probe (`GetForegroundWindow` + process image +
  `GetLastInputInfo`, including UWP frame children) type-checks for
  `x86_64-pc-windows-msvc` but has not yet been run on real Windows hardware.
- Tray menu items, the quit guard, normal-mode toasts, real `install_integration`
  and a release build are not yet exercised (see the learning note).
