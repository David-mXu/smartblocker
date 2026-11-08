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
| **Blocked apps** | Current list (removal disabled while locked — add-only), add by name, add from running apps. |
| **Browsers** | Chrome/Edge/Firefox protected or not, and how to fix it ("Repair browser connection"). |
| **Activity** | Day-grouped sentences from `events.log`; unknown kinds sit behind "Show technical events". |
| **Settings** | Lock settings for a time, Pro license, browser connection, Start with Windows (read-only state), About. |

The amber lock line shows on every page except Home, whose hero already states
the lock.

## Focus session

Same model as the extension: a **deferred commit** with a 60-second undo,
implemented in `smartblocker-core/src/focus_session.rs` so it survives closing
the window. Three states: can undo → **"Locking…"** (from `commitAtMs` until the
daemon's next tick, no Undo) → locked. An undo that loses the race reads "It
already locked in." and is not an error.

## App names

Blocked-app entries and the running-apps picker share
`procwatch::normalize_exe_stem` (lowercase, no `.exe`, no self-updater version
suffix like `agy.exe.1793826601058390500`), so a picked name keeps matching
after the app updates itself.

## Running-apps order

The picker lists every running app in three groups, each sorted by name:
**On your screen** (a taskbar-style window showing), **Open, not on your screen**
(minimized or on another virtual desktop), **Running in the background** (no such
window). An app takes the most present state of any of its processes.
`apps.rs window_state` decides per window. Browsers stay off the list (Browsers
page), and OS plumbing stays off because closing it would break the session.

## Test mode

Debug builds only, plus env `SMARTBLOCKER_TEST_MODE=1`: scratch data dir,
separate socket, `dry_run_kills`, log-only notifier, `policy_enforce` forced off,
no registry or autostart writes, "Test mode" badge. A release build can't enter
it. Never run the app outside test mode to exercise locks on a machine with real
browsers open: the watchdog closes browsers with no connected extension.

## Known gaps

- Apps closed to the system tray count as background: Windows has no supported
  way to list tray icons.
- Tray menu items, the quit guard, normal-mode toasts, real `install_integration`
  and a release build are not yet exercised (see the learning note).
