# Strictly-upward ordered lock stamps

## Why

Every ordered lock operation (password, delay gate, random-text gate, break
operation, schedules) wins a merge by a greater timestamp. Writes used plain
`Date.now()`. Scenario: the wall clock is ahead when a password is armed
(stamp = T+1h — NTP on a fresh VM, a manual change, or a tamper attempt), then
corrected backwards. The unlock tombstone is stamped at the corrected now
(T+5m), which LOSES to the arm. The password lock becomes unreleasable until
the wall clock reaches the old arm stamp — up to an hour or more. The partner
arm already used `max(now, prev + 1)`; the other operations did not.

## What changed

- `lock-math.ts nextOrderedStamp(previous, now)` = `max(now, previous + 1)`
  (invalid/missing previous → `now`). Erasable syntax, Node-tested.
- Every ordered write in `lock.ts` uses it: password arm + unlock tombstone
  (including the legacy→v2 migration re-stamp), delay arm/start/cancel/complete,
  random-text arm/release, break start/cancel, and both schedule setters.
- Companion ingress: `merge_from` still sanitizes (future stamps clamp to the
  daemon's now), but for an AUTHENTICATED peer it then re-derives each ordered
  stamp from the RAW remote value: a value ahead of now is accepted as exactly
  `current + 1`. That lets the legitimate `previous + 1` release win after a
  backwards correction, while a forged far-future stamp is clamped to one step
  and cannot hold an operation hostage. Unauthenticated peers remain fully
  pinned (unchanged).

## Verification

- `lock-math-test`: strictly-upward helper (normal, same-millisecond, future
  previous, invalid previous).
- Rust: authenticated release wins over a future-stamped arm; a forged far
  future stamp persists only near now.
- Existing suites: lock-types (26), breaks (14), lock-math (188),
  surrender/profiles/backup, full companion gate (327 core + 4 + 2), companion
  e2e (sync in both directions, password/delay/random-text/break paths),
  `e2e-p2-kdf-modelpin` (password arm/unlock/migration).

## Residual

The rule is "one step per authenticated write". An authenticated browser could
technically advance a stamp by one per message, but that identity is already
allowed to release these operations — the clamp exists to stop far-future
hostage stamps, which it still does.
