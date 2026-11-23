# Extension-loss grace is pinned at lock start

## Why

The companion closes a browser whose extension heartbeat goes stale during a
lock, after a configurable grace (15–300 s). The grace is a deliberate
user-comfort knob, but a mid-lock increase to 300 s is five minutes of
extensionless browsing — the same class of weakening as deleting an app from
the block list, which the daemon already heals.

## What changed

- `PinnedApps` (the daemon's per-lock tamper baseline) now also pins the
  extension-loss grace on the first locked tick. While the lock is active, any
  config value above the pin is restored to the pin, persisted, and logged as
  `config-tamper-restored` with an `extensionLossGrace` detail.
- Shortening the grace while locked remains legal (strictening). Unlocking
  clears the whole pin (`PinnedApps::default()`), so the next lock re-pins
  whatever value is then in force.
- `store::grace_change_allowed(current, requested, locked)` documents/tests the
  same rule for future UI use. The Tauri command was deliberately left
  unchanged: it cannot be compiled on Linux (webkit2gtk is Windows-only), and
  the daemon-side heal is the enforcement boundary.
- Tests: pin → heal a 300 s widening back to 60 s → allow 30 s → unlocked
  raises pass through.

## Verification

- Companion gate: 329 core + 4 fixtures + 2 nm-host, clippy `-D warnings`, fmt.
- Companion e2e (real Chromium + daemon): config-tamper, grace and enforcement
  paths remain green.

## Residual

If the daemon restarts mid-lock, the pin is captured from the value on disk at
that moment, so a widening made while the daemon was dead persists for that
lock. Closing that would need the pinned value persisted beside the lock
state; the same-uid soft-model limits already documented apply.

## Related stamp refinement (same audit)

The authenticated one-step stamp rescue now also fires when the DAEMON holds a
future stamp (clock was ahead at arm time) even if the peer's incoming stamp is
low — the wiped-profile case. Previously only a future incoming stamp was
rescued, so such an unlock appeared to succeed and then re-locked.
