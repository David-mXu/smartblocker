# Desktop startup toggle and configurable extension-loss grace

**Date:** 2026-11-10

**Scope:** the desktop companion's Settings page, the Tauri command layer, and
the core config/enforcer/daemon. This follows the earlier
[extension-loss countdown work](./2026-11-08-extension-loss-grace-countdown.md):
that change made the 60-second grace visible, and this one makes the duration
persisted and tunable while adding the missing explicit startup switch.

## 1. Problem and outcome

Two native controls were missing from desktop parity:

1. **Start with Windows was display-only.** The status showed whether the
   autostart plugin had registered the companion, but no command could turn it
   off or back on. A user who wanted the companion to stop launching at login
   had to edit the registry or remove it another way. Install/Repair also had a
   long-standing side effect of enabling autostart, and that behavior needed to
   survive.
2. **The extension-loss grace was a Rust constant.** The daemon waited a
   hard-coded 60 seconds after a supported browser's extension stopped
   responding during a lock. A user could see the countdown but could not make
   it shorter or longer. The value was not in `config.json`, so it could not
   survive a restart even if a UI had changed it in memory.

The outcome is an explicit `Start with Windows` switch and a whole-second
`Extension-loss grace` setting (default 60, allowed 15–300) persisted in the
companion config. The same effective value now drives enforcement, the
extension-facing status, and the desktop snapshot, so the three surfaces agree.

## 2. Concepts

**Tauri commands** are Rust functions registered with
`tauri::generate_handler!` and called from the webview with `invoke(name, args)`.
They are the boundary between the React UI and OS/store authority. A command
can return a typed value or a human-readable error string; it should not let the
UI guess what the OS accepted.

**Autostart** on Windows is an `HKCU\...\CurrentVersion\Run` entry managed here
by `tauri_plugin_autostart`. `enable()`/`disable()` change the registration,
while `is_enabled()` reads it back. Returning the observed state after a write
is more trustworthy than returning the requested boolean. In **test mode** the
companion uses a scratch store and must not touch the host registry, so both
read and write deliberately report `false` without inspecting or changing it.

**Grace** is the delay between "this browser's extension is not responding"
and closing the browser. Detection itself already requires
[`HEARTBEAT_GAP_MS`](../../companion/crates/smartblocker-core/src/enforcer.rs)
(45 seconds) without an authenticated heartbeat. The grace starts after that
gap. A 15-second floor therefore means roughly 60 seconds from the last
heartbeat, which still covers the extension's 30-second keepalive-alarm cycle;
300 seconds caps a window that a user can still recognize as "hard" enforcement.

**Monotonic time** is a clock that only moves forward and is unaffected by
wall-clock changes. Grace deadlines use it. Persisting a monotonic timestamp
would be meaningless across a process restart, so only the duration is stored;
the start time lives in the in-memory enforcer state.

## 3. Implementation steps and evidence

### Step 1 — Make the duration part of the persisted config

[`store.rs`](../../companion/crates/smartblocker-core/src/store.rs) gained
`extension_loss_grace_seconds`, constants for the default/floor/ceiling, a
`clamp_extension_loss_grace_seconds` helper, and
`CompanionConfig::extension_loss_grace_ms()`.

The struct previously derived `Default`, which would have produced `0` for the
new field. A manual `impl Default` now returns 60. The field also has a
field-level serde default, so an existing `config.json` written before this
change loads with 60 rather than failing or silently using zero.

Hand-edited config is treated leniently. A custom deserializer accepts
integers, finite floats (rounded), and decimal strings; booleans, null, and
unrecognized types fall back to 60. `sanitize()` clamps on load, and
`save_config()` sanitizes a clone before writing, so the app never writes an
out-of-range value. A hand-edited value stays in the file until the next save,
but every reader sees the clamped result. This matters because the daemon, the
desktop command, and tests may all read the same file; clamping at the boundary
prevents them from disagreeing.

Evidence: `extension_loss_grace_defaults_bounds_and_persists` and
`extension_loss_grace_hand_edits_are_lenient_and_bounded` in `store.rs` cover
defaults, 120-second persistence, clamping at both ends, saving, floats,
strings, negative numbers, and preserving other fields when one scalar is bad.

### Step 2 — Use the configured duration in enforcement

[`enforcer.rs`](../../companion/crates/smartblocker-core/src/enforcer.rs) now
computes `grace_ms` once per tick from `TickInputs::config`. `SuspectTrack`
stores the duration alongside `since_mono_ms`. The close test compares elapsed
monotonic time against `track.grace_ms`.

The important design choice is that a settings change refreshes only the
duration, never `since_mono_ms`. If a user extends the grace mid-track, the
countdown continues from the original start; it does not restart and grant a
second full window. If they shorten it, the existing track can reach its new
deadline sooner. This keeps the track a record of when the extension actually
went unresponsive.

`WATCHDOG_GRACE_MS` remains as a readable default for callers and tests, but it
is now derived from `DEFAULT_EXTENSION_LOSS_GRACE_SECONDS`; enforcement uses
the config value.

Evidence: tests cover a 15-second boundary, a 120-second boundary beyond the
old 60-second default, a mid-track change that preserves the start, and a
disconnect/reconnect cycle that starts a fresh track with the configured
duration.

### Step 3 — Report one effective duration everywhere

[`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs) has two
audiences:

- `status_for_browser` builds the authenticated extension observation. When a
  track is active it reports that track's duration; when connected it reports
  the current configured duration, so the next warning already uses the right
  number. `grace_remaining_ms` stays relative to the daemon's monotonic clock.
- `build_snapshot` writes the desktop-facing grace entries. It uses the active
  track's duration for `graceSeconds`, not the constant.

The status refresh signature changed from a list of browsers to
`(browser, grace_seconds)` pairs. Without that, changing the setting during an
active track would not publish until the ordinary ten-second refresh, leaving
the extension countdown temporarily stale. The daemon still avoids per-tick
status traffic for healthy peers.

Evidence: `status_and_snapshot_report_the_configured_extension_loss_grace`
checks 120 seconds in both the status and snapshot, including the connected
case; the grace-sync test checks that a duration change publishes immediately
and that the ten-second refresh still works.

### Step 4 — Add the Tauri commands and status fields

In [`main.rs`](../../companion/crates/smartblocker-companion/src/main.rs):

- `get_autostart` reads the plugin state, or returns `false` in test mode
  without touching the registry.
- `set_autostart` calls `enable()`/`disable()`, then reads back and returns the
  observed state. Errors include the operation and the plugin error.
- `set_extension_loss_grace_seconds` clamps the input, saves only when the
  effective value differs, and returns the effective seconds so the UI can say
  what was actually accepted. The argument is `i64`, not `u64`, so a direct
  negative call clamps to the floor instead of failing deserialization.

`DesktopStatus` now carries the effective grace and its min/max, letting the
form render the same bounds the Rust command enforces instead of duplicating
magic numbers in TypeScript. The three commands are registered in
`invoke_handler`.

Repair/install behavior is intentionally unchanged: it still enables autostart
for detected browsers. The new switch is the explicit later intent, and the UI
text says that Repair can turn it back on.

### Step 5 — Wire the Settings page and mock

[`SettingsPage.tsx`](../../src/desktop/pages/SettingsPage.tsx) adds:

- a `Switch` with `#autostart-toggle`, a busy state, `aria-busy`, and
  `aria-describedby="autostart-status"`; the existing `#autostart-status`
  remains the source of the visible On/Off/Unchanged text;
- a grace form with `#extension-grace-seconds`, min/max from the status,
  client-side integer validation, `#extension-grace-save`, and a status
  paragraph at `#extension-grace-status`;
- separate message regions (`#autostart-msg`, `#extension-grace-msg`,
  `#settings-repair-msg`) so one action's result does not overwrite another's.

The grace field follows status refreshes through an effect, so a daemon/store
change is reflected without discarding an in-progress edit on every render.

[`api.ts`](../../src/desktop/api.ts) declares the command contracts, and
[`mock.ts`](../../src/desktop/mock.ts) implements them with the same clamping
and test-mode rules. Mock scenarios `autostart-off` and `grace-120` make the
visual states reproducible in a plain browser.

### Step 6 — Document the behavior and the manual check

[`docs/design-notes-desktop.md`](../../docs/design-notes-desktop.md) records the
Settings-page contract, including the deliberate test-mode "Unchanged" state
and Repair's side effect. [`companion/README.md`](../../companion/README.md)
documents the tunable range and adds a Windows checklist item for toggling
startup and verifying persistence after relaunch.

## 4. Alternatives and tradeoffs

- **Store the grace only in the webview (localStorage).** Rejected: the daemon
  enforces the lock and may run without any window open. The value has to live
  in the companion store.
- **Read the duration only when a track starts.** Rejected: a mid-grace change
  would not take effect until the next disconnect, and the status could
  disagree with the setting. Reading per tick is cheap and keeps one authority.
- **Restart the track when the duration changes.** Rejected: a user could
  repeatedly extend the grace by nudging the setting, and the recorded "when
  did the extension stop responding" fact would be lost. Refreshing duration
  only is the conservative choice.
- **Keep `WATCHDOG_GRACE_MS` as the enforcement value and layer a UI override
  on top.** Rejected: two sources of truth invite drift. The constant is now a
  default alias, not a second authority.
- **Use an unbounded `u64`.** Rejected: a typo such as `999999` would create an
  unrecognizable enforcement window. The 15–300 clamp is enforced in Rust on
  load, save, and command input.
- **Make Repair respect a user's "off" choice.** Rejected for this change to
  preserve existing install/repair behavior; the UI explicitly warns that
  Repair turns startup back on. Revisiting that policy is a separate product
  decision.
- **Return the requested boolean from `set_autostart`.** Rejected: the OS is
  the authority. Reading back catches a plugin/registry failure instead of
  reporting success optimistically.

## 5. Verification

Observed in this worktree on Linux/WSL:

- `npm run typecheck` — passed.
- `npm run build:desktop` — passed. This builds the desktop frontend, not the
  Tauri executable.
- `cargo test` (workspace default members; the Tauri shell crate is excluded) —
  **318 passed, 0 failed** across 6 suites. This includes the new store,
  enforcer, and daemon tests; the pre-existing test count was 314.
- `cargo clippy --all-targets -- -D warnings` — passed.
- `rustfmt --check` on every changed Rust file — passed.
- A Playwright check against the mock desktop build — **19/19 checks passed**,
  covering default On/60, toggling off and back on, clamping 5 to 15, saving
  120, the test-mode disabled "Unchanged" state, the `autostart-off` scenario,
  and the `aria-describedby` links. Screenshots:
  `/tmp/opencode/desktop-settings-grace-120.png`,
  `/tmp/opencode/desktop-settings-test-mode.png`, and
  `/tmp/opencode/desktop-settings-autostart-off.png`.

Not observed here:

- The Tauri shell executable was not compiled in this environment because
  `pkg-config`/`webkit2gtk-4.1`/`libsoup-3.0` are unavailable. The command
  signatures and handler registration were reviewed, but a Windows build is the
  real gate.
- Real Windows registry behavior, the autostart entry, and the 15/120-second
  close boundaries were not exercised at runtime. The manual checklist in
  `companion/README.md` is the remaining verification.
- `cargo fmt --all -- --check` still reports pre-existing formatting hunks in
  `companion/crates/smartblocker-core/src/lock_math.rs` (rustfmt
  1.9.0-stable). The changed Rust files themselves pass `rustfmt --check`; the
  unrelated file was left untouched to keep this change focused.
