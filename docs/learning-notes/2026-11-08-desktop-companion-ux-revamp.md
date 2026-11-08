# Desktop Companion UX Revamp: From a 142-Line Page to a Real App

**Date:** 2026-11-08 · **Scope:** [src/desktop/](../../src/desktop/), [companion/crates/smartblocker-core/](../../companion/crates/smartblocker-core/), [companion/crates/smartblocker-companion/](../../companion/crates/smartblocker-companion/), [docs/design-notes-desktop.md](../design-notes-desktop.md)

## 1. The goal

Give the Windows desktop companion the same UX treatment as the extension
([2026-11-07-popup-options-ux-overhaul.md](2026-11-07-popup-options-ux-overhaul.md)).
It was a 66-line HTML page and 76 lines of JS. A mocked-bridge screenshot showed
the problems: a lock emoji rendering as a missing-glyph box, "App blocking:
✓ active" hardcoded on even with no lock, a one-click uncancellable "Frozen
Turkey" button with no end time, and a textarea that only worked if you knew
process names like `steam`.

## 2. Concepts worth knowing

- **Contract-first with a mock backend.** The UI was built against a typed
  command list (`src/desktop/api.ts`) and an in-memory mock, so all of it could
  be developed and tested before the Rust existed. Limitation: a mock only proves
  the UI matches what you *believe* the backend does, which is why step 5 below
  still mattered.
- **Why Tauri's frontend needs care.** Tauri's window is a real browser engine
  (WebView2 on Windows), which is what let us render the UI in Chromium from WSL.
  But Chromium refuses ES-module scripts from `file://`, and the window's CSP
  blocks `data:` URLs, so the bundle is a plain deferred script with real asset
  files.
- **Atomic claim by rename.** A 60-second undo and a background commit can race
  for the same pending session. Each tries to rename the same file, and the OS
  guarantees only one rename succeeds, so exactly one side wins.
- **Behavioral fingerprints need counter-evidence.** The companion identifies
  browsers by renderer command-line structure, not filename. Electron apps have
  the same structure, so they need an explicit way out. See §4.

## 3. What was done, in order

1. **Inventory.** Rendered the old UI with a mocked `window.__TAURI__`; read the
   five Rust commands and the core to learn what data existed. Connected browsers
   lived only in daemon memory and activity only in `events.log`.
2. **Decisions with the user:** React + Vite sharing extension components,
   sidebar dashboard, dark Lamplight, four new capabilities (running-apps picker,
   connected browsers, activity feed, license key), the same 60s undo in the Rust
   core, and real-app testing only in a safe mode.
3. **Spec, then parallel agents** with disjoint file ownership: `rust-core`
   (focus session, status snapshot, activity reader, app lister, license API) and
   `desktop-ui`, then `tauri-shell` once the core landed.
4. **Test mode for safety.** The real watchdog closes browsers with no connected
   extension during a lock. So the shell gained a mode that only exists in debug
   builds and only with `SMARTBLOCKER_TEST_MODE=1`: scratch data dir, separate
   socket, kills logged rather than performed, no registry or autostart writes.
5. **Real-app run on Windows.** A debug build was launched in test mode and driven
   through WebView2's debugging port with Playwright, after asserting the page
   was the Tauri origin and `testMode` was true. This found what the mock could
   not (§4).

## 4. Bugs the real run found

- **A real lock would have closed Todoist.** It is an Electron app, but the
  carve-out only recognized `app.asar` on the command line or a fixed name list,
  and Todoist has neither. Comparing real renderer flags showed Electron renderers
  carry `--app-path` while Chrome and Edge renderers do not. It doesn't open a
  bypass: a browser only forwards an allowlist of switches to its renderers, so a
  renamed browser launched with a fake `--app-path` still has renderers without
  it.
- **`agy.exe.1793826601058390500`.** A self-updating app's binary keeps a version
  suffix on disk. The picker showed it, and a saved entry would stop matching
  after the next update. `normalize_exe_stem` now strips it in the one place both
  the picker and the enforcer use.
- **"until 9:44 a.m.."** en-CA formats times with periods, so a time ending a
  sentence doubled up. The mock ran in en-US and never showed it. Fixed in the
  desktop UI. **The extension has the same pattern and is not fixed yet.**
- **Windows-only clippy failures** in `ipc.rs` and `policy.rs`, invisible to the
  Linux gate.

## 5. Tradeoffs and process lessons

- A second focus-session start is refused while one is pending, because replacing
  the record could commit a session early.
- **A passing exit code can be my own pipeline's.** The first Windows clippy
  "passed" with exit 0, but `cmd` had failed to parse the `vcvars64.bat` path and
  the exit code belonged to the output filter. Capturing clippy's own
  `%ERRORLEVEL%` from a `.bat` gave a real result.
- **"Not found" from `cmd` over WSL interop is weak evidence.** Paths containing
  parentheses get mangled, so tools can look missing when they aren't. Check
  through `/mnt/c` instead.
- **Partial commits need their own build check.** Another session had staged work
  in the same crate, so this commit was built alone in a throwaway `git worktree`
  (HEAD plus only these files). That exposed one test line depending on their
  uncommitted `LockState` fields.

## 6. Verification (observed)

- WSL: `cargo test` 150 core + 4 + 2 pass; `cargo clippy --all-targets -D warnings`
  and `cargo fmt --check` clean. Same result in the isolated commit worktree.
- Windows: `cargo clippy -p smartblocker-companion -- -D warnings` exit 0,
  `cargo fmt --check` exit 0, debug build and `cargo tauri build --debug --no-bundle`.
- `src/desktop`: typecheck clean, `build:desktop` passes, Playwright flows and 38
  screenshots against the mock with no console errors or CSP violations.
- Real app, test mode: pages with real data and no "Preview data" badge; start →
  undo; start → commit after 62s; add from the real running list; invalid license
  error; `start_companion` idempotent; close hides to tray. `events.log` showed
  only `kill-dry-run` (zero `kill`), and both browsers stayed open.

**Not verified:** tray menu clicks, the quit guard, normal-mode toasts, real
`install_integration`, a release build, Firefox. The Todoist, app-name and time
fixes were made after the real-app run: unit tests and rule checks cover them, but
the real app was not re-run.
