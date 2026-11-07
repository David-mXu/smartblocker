# Running the desktop companion hands-on from WSL (2026-11-07)

## Goal

Test the desktop companion (`companion/`, Rust daemon + Tauri tray app)
interactively from this WSL2 dev box, with a real browser, instead of only
through the scripted e2e.

## Key constraint: the enforcement loop is per-OS

The daemon's process fingerprinting
(`crates/smartblocker-core/src/procwatch.rs classify_process`) reads Linux
`/proc` command lines. It cannot see Windows processes, and a Windows
browser cannot Native-Message a WSL socket. So the whole loop — browser,
extension, nm-host, daemon — must live on the same side of the WSL/Windows
boundary. The Tauri tray UI is Windows-only (needs WebView2/MSVC, excluded
from workspace default-members), so on WSL the testable form is: **headless
daemon + nm-host + Linux Chromium under WSLg** (GUI shows on the Windows
desktop; `WAYLAND_DISPLAY=wayland-0`, `DISPLAY=:0` were present here).

## Setup steps (in order)

1. `npm run build` — rebuild `dist/chrome` (uncommitted UI sources had made
   it stale).
2. `cd companion && cargo build --release` → `smartblocker-daemon` +
   `smartblocker-nm-host` under `target/release/`.
3. `./target/release/smartblocker-daemon install` — wrote NM host manifests
   (chrome/chromium/edge/firefox config dirs) pointing at the release
   nm-host, plus an XDG autostart entry (inert under WSL, harmless).
4. Started the production posture detached so notifications land in a file:
   `SBPRO_DEV_OPEN=1 setsid nohup ./target/release/smartblocker-daemon watchdog >> ~/.config/smartblocker/daemon.out 2>&1 &`
   - `SBPRO_DEV_OPEN=1` is the documented dev escape hatch that unlocks Pro
     features (Frozen Turkey etc.) pre-store; verified present in the
     daemon's `/proc/<pid>/environ`.
   - `watchdog` spawns `run --socket smartblocker-companion` and revives it;
     the daemon revives the watchdog. `smartblocker-daemon status` queries
     the live daemon.
   - On Linux the daemon has no GUI notifier: `daemon.rs notify()` prints
     `[notify] ...` to stderr, hence the redirect to `daemon.out`.
5. New launcher `scripts/dev-live-browser.mjs`: Playwright Chromium
   **headed** with a persistent profile at `.dev-profile/` (gitignored),
   extension loaded via `--load-extension` + `--disable-extensions-except`.

## Evidence and decision points

- **NM manifest must sit inside the custom profile.** Playwright's
  `launchPersistentContext` uses a custom `--user-data-dir`, and Chromium on
  Linux reads per-profile NM manifests from
  `<user-data-dir>/NativeMessagingHosts/`. The launcher writes
  `dev.davidxu.smartblocker.json` there, mirroring `e2e-companion-test.mjs`
  (the `install` step's manifests in `~/.config/...` cover *default*
  profiles; the e2e proved the per-profile path works).
- **Where daemon state actually lives.** The daemon's default data dir comes
  from `directories::ProjectDirs::from("dev", "davidxu", "smartblocker")` →
  **`~/.local/share/smartblocker/`** on Linux (`events.log`, `config.json`),
  NOT `~/.config/smartblocker` (which only holds the extension's
  `export-token`). Watching the wrong dir made the first launch look
  unpaired; in fact `events.log` already showed
  `hello Chrome ext 0.5.0 id dhbhbhhcjkfdkfbloeaeedndfjfadajh` plus
  `pair adopted a new browser pairing token` and `license dev-open` (the
  `SBPRO_DEV_OPEN=1` posture). Decisive evidence over assumption.
- **Fresh-profile SW flake (defensive).** The e2e scripts encode a workaround
  for MV3 service workers sometimes not booting on a fresh profile — open any
  page (`https://example.com`), wait for the `serviceworker` event, relaunch
  up to 3 attempts if it stays down. That logic was ported into the launcher
  (`launchWithServiceWorker`); it mirrors what the e2e already proved.
- **WSLg X11 is broken here; Wayland is healthy.** Headed chromium launched
  via the default X11 path (Xwayland) died **every time after ~30–80s** with
  `ERROR:ui/gfx/x/connection.cc:66 X connection error received` — reproduced
  with a direct `chrome` launch (Playwright out of the loop), no OOM, no
  crashpad dumps, memory fine. Root-ish cause: WSLg's Wayland socket was not
  linked into `$XDG_RUNTIME_DIR` (`/run/user/1001/wayland-0` missing), so
  apps couldn't use the healthy compositor; Xwayland accepted connections
  then severed them (window never visible at all). Fix in the launcher
  (`headedArgs()`): symlink `/mnt/wslg/runtime-dir/wayland-0` into
  `$XDG_RUNTIME_DIR` when absent, and pass `--ozone-platform=wayland`.
  Result: browser stable past 100s, window visible on the Windows desktop
  (user-confirmed). If X11/WSLg windows misbehave again, `wsl --shutdown`
  from Windows is the deeper reset (restarts WSLg; also kills any WSL-side
  daemons — restart the companion afterwards).
- **Shell footgun:** `pkill -f dev-live-browser` kills the *calling* shell
  too, because the pattern matches the wrapper's own command line. Use a
  self-excluding pattern (`pgrep -af "dev-live-browse[r]"`).

## Tradeoffs / unresolved

- WSLg Chromium is a stand-in for the real (Windows) UX: no tray UI, no OS
  notification toasts — `[notify]` lines stand in, in `daemon.out`.
- Process enforcement only covers Linux processes; Windows browsers are
  untouched by this daemon instance, which makes the test safe to run.
- The real Windows path (MSVC + `cargo tauri build` + 10-step manual
  checklist in `companion/README.md`) remains untested here.
- **`smartblocker-daemon status` is NOT proof of life.** It prints an
  all-clear looking state even with the daemon dead (offline/persisted view).
  The real proofs are `daemon-start` in `events.log` and the PING/PONG probe
  (the e2e uses exactly this distinction: "a bare connect is not proof of
  life"). This misread hid a real outage for part of the session: the first
  setsid'd watchdog+daemon died silently at some point during the X11 churn
  (cause unresolved — possibly the launching shell tree being reaped despite
  setsid, not verified; nothing in `events.log`/`daemon.out`). Restarted
  identically; `daemon-start` + `license dev-open` confirmed live.
- **Stale relay after a daemon death.** The nm-host relay outlived the dead
  daemon and held the Chrome port open, so the extension saw no disconnect
  and never re-hello'd. Killing the stale relay produced
  `relay-disconnect` → fresh `hello` within **5 seconds** (new relay pid) —
  the designed self-heal path, confirmed live.

## Verification

- `cargo test` in `companion/`: 118 passed, 0 failed.
- `node scripts/e2e-companion-test.mjs`: `COMPANION E2E: ALL PASSED` (21
  checks: pairing, lock persistence, blocklist kill, decoy kill, incompatible
  browser kill, daemon↔watchdog mutual respawn, uninstall lock-guard, socket
  squatter probe).
- Live loop (2026-11-07): fresh `daemon-start` + `license dev-open` +
  `hello Chrome ext 0.5.0 id dhbhbhhc…` in events.log; stale-relay kill →
  `relay-disconnect` → re-`hello` in 5s; headed browser stable >100s on
  `--ozone-platform=wayland` and user-visible on the Windows desktop.

## Teardown

Close the browser (or Ctrl+C the launcher). To stop the companion:
`smartblocker-daemon uninstall` (refuses while any lock is armed — clear
locks first), which de-registers NM manifests and autostart.
