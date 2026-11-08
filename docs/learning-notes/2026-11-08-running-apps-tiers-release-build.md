# Running-apps order and the first Windows release build

**Date:** 2026-11-08 · **Scope:** [apps.rs](../../companion/crates/smartblocker-core/src/apps.rs), [AppsPage.tsx](../../src/desktop/pages/AppsPage.tsx), [design-notes-desktop.md](../design-notes-desktop.md)

## 1. The goal

The "Add from running apps" list was one alphabetical list of about 60 names,
where `Appactions` and `Cmd` sat beside the apps a user would actually block. The
request: keep showing everything, but put visible apps first, then open ones, then
background processes. Also produce the release build.

## 2. Concepts worth knowing

- **A process list doesn't know about windows.** `sysinfo` reports processes.
  Which ones have a window comes from a separate Windows call, `EnumWindows`, so
  the two are joined by process ID.
- **Most top-level windows aren't what a person calls a window.** Windows keeps
  hidden message windows, tooltips and overlays at the top level. The usual
  "would this be on the taskbar?" test is: shown, has a title, not owned by
  another window, and not a tool or no-activate window, unless it sets
  `WS_EX_APPWINDOW`.
- **Cloaking.** A window on another virtual desktop still reports as visible, so
  `IsWindowVisible` alone would misfile it. `DWMWA_CLOAKED` says who hid it: value
  1 means the app did (not really open); the shell's value means another desktop
  (open, just not here).
- **UWP frames.** Store apps draw inside a window owned by
  `ApplicationFrameHost`, so the app's own process is only found through the
  frame's child windows.

## 3. What was done, in order

1. Added `AppState` (`Visible`, `Open`, `Background`), declared in display order
   so `min` picks the most present state across an app's processes.
2. Split the decision into a pure function, `window_state(&WindowFacts)`, with the
   Windows calls in a thin `#[cfg(windows)]` module. The rule is then unit-tested
   on Linux, where those APIs don't exist.
3. Grouped the list in `AppsPage.tsx` with sticky headings and per-group counts.
4. Built in a clean `git worktree` of `HEAD`, because another session had
   unfinished edits in the same crate and a release shouldn't ship those.
5. Staged only this change's hunks with `git apply --cached`, since `api.ts` and
   `mock.ts` also held that session's uncommitted edits.

## 4. Tradeoffs and what's unresolved

- **OS plumbing and browsers stay off the list.** "All apps" could include
  `explorer` or `dwm`, but blocking those would close them during every lock and
  break the desktop. Browsers are handled on the Browsers page.
- **Apps closed to the tray read as background.** Windows has no supported API
  for listing tray icons, and treating hidden titled windows as "open" would pull
  in plumbing windows.
- **An app whose window lives in a helper process** (Steam's UI runs in
  `steamwebhelper`) is expected to show the helper higher than the main program.
  Steam wasn't running here, so this comes from how Steam is built, not from a test.

## 5. Verification (observed)

- WSL, clean worktree: `cargo test` 159 + 4 + 2 pass; clippy and fmt clean;
  `npm run typecheck` clean.
- Windows: `cargo clippy -p smartblocker-core --all-targets -D warnings` exit 0
  (after it caught an import that was only unused on Windows), fmt exit 0, 9 `apps`
  tests pass.
- Windows release: `cargo build --release -p smartblocker-nm-host` and
  `cargo tauri build --no-bundle`, both exit 0.
- Mock UI in Chromium: groups, search and Add work, with no console errors.
- Real app in test mode, real desktop: 3 on screen (VS Code, Raycast, Windows
  Terminal), 3 open (Beeper, Cold Turkey, Todoist), 54 background; no mock badge;
  no real closes in `events.log`.

**Not verified:** the release binary hasn't been launched, because it can't enter
test mode and would be a real install. Minimized and other-desktop placement was
checked on whatever was open at the time, not by moving windows deliberately.
