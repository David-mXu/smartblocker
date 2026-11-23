# Boot-relative monotonic clock for the drift anchor

## Why

The daemon compensates forward wall-clock ratchets by comparing wall movement
against a monotonic clock, persisting an anchor (`clock-anchor.json`:
`wall0`/`mono0`) so sub-tolerance nudges accumulate across daemon restarts.
But `mono0` came from `Instant::now().elapsed()` — **process-relative**. Every
watchdog respawn reset it near zero, the anchor step saw "mono went backwards"
and re-anchored without compensation. An attacker (or a bad NTP setup) could
chain a +55s nudge with a daemon restart, repeatedly discarding the
accumulated evidence, and expire an hour-long lock in minutes.

## What changed

- New `smartblocker_core::clock::boot_mono_ms()`:
  - Linux: fractional `/proc/uptime` seconds.
  - Windows: `GetTickCount64`.
  - Other platforms: process-relative fallback (documented degradation of the
    cross-restart guarantee).
- `Shared::mono_ms()` uses it; the process-relative `started: Instant` field was
  removed (it existed only for that clock). Unrelated intra-process uses of
  `Instant` (socket deadlines) are unchanged.
- `ClockAnchor` carries `boot_based` (serde-default false). Legacy anchors —
  process-relative `mono0` — re-anchor once after the upgrade instead of
  silently disabling detection with an incomparable baseline. A genuine OS
  reboot still moves the boot clock backwards and re-anchors, as before.
- Tests: the clock advances and is boot-relative (not near zero); legacy anchor
  → Reanchor; existing ratchet/compensation/no-double-fire/reboundary tests now
  use boot-based anchors.

## Verification

- Companion gate: **325 core + 4 fixtures + 2 nm-host** tests, clippy
  `-D warnings`, fmt.
- Companion e2e (real Chromium + daemon + watchdog respawns): 64/64 ALL
  PASSED — the grace/heartbeat and partner mono stamps remain coherent under
  the new clock.
- While validating, an unrelated e2e bug surfaced: the category-schedule
  rescue assertion sliced `latencySamples` by ARRAY INDEX, so once the capped
  log (LATENCY_LOG_MAX) filled, `slice(len)` was always empty and the test
  timed out even though the rescue had happened. It now marks by the last
  sample timestamp instead.

## Residual

On platforms other than Linux/Windows the clock falls back to process-relative;
the desktop companion ships for those two only, so this is a portability note,
not a supported configuration.
