# Desktop app-usage analytics

Date: 2026-11-09
Branch: `parity/desktop-usage`

## Problem

The desktop companion could say what it blocked (`events.log`) but not how the
user actually spent time. The goal was a local-only Usage page that tracks the
foreground application's active time, aggregates it by local day, survives a
quick restart, stays bounded, and can be exported or cleared. It must not read
window titles or URLs, must not count idle/sleep time as activity, and must not
change any blocking decision.

The interesting parts are not the UI: they are the clock and the ownership
model.

## Concepts in plain language

- **Active foreground time** is time attributed to the focused app while the
  user was recently inputting. It is not the same as **wall time** between
  launch and now: an open laptop on a desk accrues wall time but no active
  app time.
- **Sampling and attribution.** The daemon samples the focused app every five
  seconds. A sample describes the state at an instant, so the interval that
  *ended* at that sample belongs to the **previous** sample's app. This is why
  `observe()` charges `previous.app` and then stores the new checkpoint.
- **Idle gate.** `GetLastInputInfo` reports milliseconds since the last
  keyboard/mouse input in the user's session. Time is charged only while that
  value is below 30 seconds at both ends of the interval.
- **Bounded gap.** If the daemon wakes after sleep or a long pause, the elapsed
  interval may be hours. Anything over 30 seconds is discarded rather than
  attributed to whatever happened to be focused before the gap.
- **Civil day, not 24 hours.** A local day starts at local midnight. On a
  daylight-saving day it can be 23 or 25 hours long, so splitting at
  "previous timestamp + 24h" is wrong. `split_local_days` asks the time zone
  for the next civil midnight instead.
- **Bounded sanitized state.** `usage-state.json` is versioned JSON that may be
  edited or corrupted, so every load runs through `sanitize_usage_state`:
  version check, date-key validation, numeric clamps, label/id cleanup, day and
  app caps. The writer also refuses to persist non-canonical state.
- **In-memory owner vs. file.** The daemon holds the live tracker. A UI that
  cleared the file directly could race the daemon's next 15-second batch and
  resurrect old totals. Clear therefore goes over local IPC to the same mutex
  that samples use.

## Implementation

### 1. A platform-independent tracker

New module: `companion/crates/smartblocker-core/src/usage.rs`.

- `ForegroundProbe` is the seam. `default_probe()` returns the Windows
  implementation on Windows and `UnavailableProbe` elsewhere, so the Linux
  build is honest (`available: false`) rather than inferring a foreground
  process from a process table that has no focus concept.
- The Windows module uses `GetForegroundWindow`, `GetWindowThreadProcessId`,
  `OpenProcess` + `QueryFullProcessImageNameW`, and `GetLastInputInfo`.
  Only the executable **basename** is kept. Store/UWP windows are handled by
  looking at child windows of `ApplicationFrameWindow` for a real app process;
  session plumbing (`LockApp`, `LogonUI`, `Winlogon`, `ApplicationFrameHost`)
  is filtered out.
- `UsageApp::from_exe_path` splits on both `\` and `/` so paths and tests are
  portable. The id is a lowercase stem; the label is the bounded original
  basename for display/export.
- `UsageTracker::observe(now, sample)` charges `previous.at_ms..now` when
  `now - previous.at_ms <= 30_000`, adds wall time for the interval, adds app
  time only when the previous checkpoint was active and the current sample is
  active, then installs the new checkpoint. A checkpoint is persisted so a
  quick restart can recover at most one bounded interval; a long shutdown
  discards the gap.
- `add_wall` and `add_active` split intervals with
  `split_local_days(&Local, start, end)`. Each chunk is keyed by its civil
  date.
- `maybe_persist` batches disk writes: dirty state is flushed at most every
  15 seconds. A backwards wall-clock jump flushes immediately instead of
  waiting for the old timestamp to be reached again.
- `clear()` writes an empty state first, then resets memory and the
  checkpoint. A failed write keeps the old totals visible instead of showing
  zeros that a restart would undo, and the next sample cannot re-charge the
  pre-clear interval.
- `summarize_usage_state` returns every day in the selected period (zeros
  included, newest first), aggregates apps across the period, and keeps
  `active_ms` and `wall_ms` separate. `export_usage_state` returns
  day-by-day app rows plus human-readable metric definitions.

State bounds:

| Bound | Value |
| :-- | :-- |
| Retained local days (including today) | 35 |
| Stored days (cushion for clock jumps) | 40 |
| App rows per day | 80, including `other.apps` |
| Max claimed time per day | 25 hours |
| Max sample gap | 30 seconds |
| Persist batch | 15 seconds |

### 2. Persistence and protocol

- `store.rs` adds `load_usage_state` / `save_usage_state`. `Store` is now
  `Clone` so the tracker and the rest of the daemon can share it. The save
  path serializes the tracker state, re-sanitizes it, and rejects a mismatch.
- `protocol.rs` adds companion-internal `UsageCommand` and `UsageResult`
  messages plus `UsageAction { Summary, Export, Clear }`. The extension never
  sends them. `send_usage_command` matches replies by `requestId` because the
  daemon may send a status greeting first.
- `daemon.rs` owns `Mutex<UsageTracker>`, samples from the existing
  enforcement loop when 5 seconds have elapsed, and handles usage commands
  under the tracker mutex. The clear acknowledgement happens only after a
  successful `flush()`.

### 3. Tauri and UI

- `smartblocker-companion/src/main.rs` exposes `get_desktop_usage`,
  `export_desktop_usage`, and `clear_desktop_usage`. Summary/export fall back
  to the atomically written file when the daemon isn't live. Clear falls back
  only when the daemon is absent; while it is live, only the daemon may clear.
- `src/desktop/api.ts` mirrors the wire shapes in camelCase. `mock.ts` seeds
  35 deterministic days and implements summary/export/clear plus
  `usage-empty`, `usage-unavailable`, and `usage-error` scenarios.
  Summary loads are sequence-guarded so a slow 7-day reply cannot overwrite
  newer 35-day data; an initial failure shows a retry block instead of an
  endless spinner, and a failed refresh with stale data shows an inline note.
- `src/desktop/pages/UsagePage.tsx` adds period buttons (today/7/30/35 days),
  active/wall/top-app stats, Top 8 apps with an aggregate Other row, daily
  bars, refresh, JSON export, two-click clear, and a loading/empty/unavailable
  state. It is registered in `App.tsx` as `#usage` with a bar-chart icon.

## The Windows bug found during verification

`GetLastInputInfo` stores `dwTime` as the **low 32 bits** of the system tick
count, while `GetTickCount64` keeps growing. The first version subtracted the
32-bit value directly from the 64-bit value. After ~49.7 days of uptime, the
low bits wrap, so the computed "idle" time would be roughly the full uptime
and the app would look idle forever — active time would silently stop.

Fix: compare in the same 32-bit domain and use wrapping subtraction:

```rust
fn idle_ms_from_ticks(now_tick: u64, last_input_tick: u32) -> u64 {
    u64::from((now_tick as u32).wrapping_sub(last_input_tick))
}
```

`idle_tick_math_survives_the_32_bit_tick_rollover` checks a normal interval,
an interval spanning the 49.7-day rollover, and an old input that must remain
large.

## Alternatives and tradeoffs

- **Extend the existing browser Activity feed.** Rejected: that feed records
  companion events, not foreground-app duration, and mixing them would blur
  two different privacy contracts. The desktop tracker is its own module, file,
  IPC message, and page.
- **Track from the Tauri shell.** Rejected: the window can be closed while the
  daemon keeps running. One sampler in the daemon gives one attribution path
  and survives window close.
- **Store a window title for readability.** Rejected: titles leak documents.
  The executable basename plus the existing friendly-name table is enough.
- **Count foreground time while the user is idle.** Rejected for `activeMs`;
  idle still contributes to the separate `wallMs`, which is why the UI says
  "at the computer" rather than calling it active time.
- **Clear by deleting the file.** Rejected while the daemon is live: its
  in-memory tracker would overwrite the deletion on the next batch. IPC clear
  is the safe path.
- **Linux foreground detection via X11/Wayland.** Deferred. Focus APIs differ
  and headless CI cannot verify them; reporting unavailable is more honest than
  guessing.
- **Byte-for-byte state cap.** A structural cap (40 days × 80 apps × bounded
  labels) is used instead of serializing just to measure size on every write.
  The per-day test asserts one worst-case day serializes under 256 KiB.

## Verification

Observed on this Linux host unless noted:

- `cargo test -p smartblocker-core` — **281 passed** (3 suites).
- `cargo test` (workspace default members) — **283 passed** (6 suites).
- `cargo clippy -p smartblocker-core --all-targets -- -D warnings` — clean.
- `cargo check -p smartblocker-core --target x86_64-pc-windows-msvc` — clean
  after installing the target with `rustup target add`; this type-checks the
  Windows probe, which the Linux host cannot compile otherwise.
- `cargo clippy -p smartblocker-core --target x86_64-pc-windows-msvc
  --all-targets -- -D warnings` — clean.
- `npm run typecheck` — clean.
- `npm run build:desktop` — built `ui-dist/` successfully.
- Headless Playwright against the built UI:
  - `?mock=unlocked#usage`: 7 day rows, 9 app rows (Top 8 + Other), no console
    errors, no horizontal overflow; switching to 35 days renders 35 rows;
    export downloads `smartblocker-app-usage-2026-11-10.json`; two-click clear
    empties the page and shows the status message.
  - `?mock=usage-empty#usage`: 0m totals and the empty state.
  - `?mock=usage-unavailable#usage`: availability callout and an
    unavailable-specific empty message.
  - `?mock=usage-error#usage`: the retry block, with no duplicated error in
    the data section.
  - Read screenshots visually at `/tmp/opencode/usage-*.png`.
- `cargo fmt --all -- --check` — passes after normalizing a few pre-existing
  rustfmt lines in `partner.rs`, `daemon.rs`, and `store.rs`.

Known limits:

- The Tauri crate itself was not compiled on this host: `libdbus-sys` needs
  system DBus development packages (`cargo check -p smartblocker-companion`
  fails in its build script). The Windows-target core check covers the probe,
  but not the Tauri command wrappers or the real WebView.
- The Windows probe has **not run on real Windows hardware**. It needs the
  manual pass in `companion/README.md` (focus changes, UWP apps, idle, sleep,
  export/clear, restart).
- Daemon exit can lose at most the current 15-second persistence batch.
- Attribution is sampled at five seconds, so very fast alt-tabs can be charged
  to the previous sampled app for up to one tick.

## Files to read next

- `companion/crates/smartblocker-core/src/usage.rs` — tracker, day math,
  Windows probe, and the core tests.
- `companion/crates/smartblocker-core/src/daemon.rs` — `usage_command`,
  sampling loop, and the IPC clear test.
- `companion/crates/smartblocker-core/src/protocol.rs` — message contract.
- `companion/crates/smartblocker-core/src/store.rs` — canonical persistence.
- `src/desktop/pages/UsagePage.tsx` — UI and the two-click clear.
- `docs/design-notes-desktop.md` — page-level product semantics.
