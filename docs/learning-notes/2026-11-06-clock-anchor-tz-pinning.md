# Learning note — cumulative clock-drift anchor (#10) + timezone-pinned schedules (#26)

**Date:** 2026-11-06 · **Scope:** red-team findings [`docs/security/red-team-2026-11-05.md`](../security/red-team-2026-11-05.md) #10 (HIGH) and #26 (MEDIUM) · **Touches:** [`src/shared/lock-math.ts`](../../src/shared/lock-math.ts), [`src/shared/lock.ts`](../../src/shared/lock.ts), [`src/background/lock-enforcer.ts`](../../src/background/lock-enforcer.ts), [`companion/crates/smartblocker-core/src/lock_math.rs`](../../companion/crates/smartblocker-core/src/lock_math.rs), [`merge.rs`](../../companion/crates/smartblocker-core/src/merge.rs), [`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs), [`lock-cases.json`](../../companion/crates/smartblocker-core/tests/fixtures/lock-cases.json), [`scripts/lock-math-test.mjs`](../../scripts/lock-math-test.mjs)

## 1. The problems

- **#10 Clock ratchet:** both anti-clock-tamper guards compared **per-tick** wall-vs-monotonic deltas only (60 s tolerance, ticks every 1–5 s). Nudging the OS clock **+55 s every few seconds** never trips either guard but pushes wall time arbitrarily far ahead, so an 8 h Frozen Turkey (whose `frozenUntil` is a wall-clock deadline) evaporates in minutes.
- **#26 Timezone bypass:** schedule windows ("block 09:00–17:00") were evaluated in the device's **current** timezone. Changing the OS timezone to somewhere outside the window instantly exits the lock.
- Related latent issue (#29, LOW): the extension's skew trackers were in-memory only; an MV3 service-worker restart forgave everything.

## 2. Root cause / underlying concepts

- **Two clocks:** every OS exposes a *wall clock* (`Date.now()`, `SystemTime`) the user can edit, and a *monotonic clock* (`performance.now()`, `Instant`) they can't. Wall−mono difference is only explicable by clock edits (or suspend) — that's what "unexplained drift" means. Measuring it **per tick** bounds a single leap; an attacker staying under the tolerance **per tick** accumulates it for free. Measuring it **cumulatively from a fixed baseline** closes that loophole because sub-tolerance nudges still sum.
- **Why pinning beats re-resolving:** for #26 the ideal is "evaluate the rule in the IANA zone captured at creation". That needs a tz database (chrono-tz/tzdb/jiff). Evidence from `~/.cargo/registry/cache/index.crates.io-*/`: only `chrono` (already a dependency; provides `FixedOffset`) and `iana-time-zone` (detects the *local* zone name only — no tzdata for arbitrary zones) are vendored; **no tz-database crate**. The Rust mirror must build with `cargo --offline`, so **fixed-offset pinning** is the only buildable design: `ScheduleRule.tzOffsetMinutes` (minutes EAST of UTC, e.g. `330` = UTC+05:30) captured when the rule is written.
- **The pure-function mirror:** `lock-math.ts` ↔ `lock_math.rs`/`merge.rs` must change together; parity is enforced by the shared golden fixtures driving both `scripts/lock-math-test.mjs` (Node, type-stripped TS) and cargo's `fixtures_test.rs`.

## 3. What was done, in order

1. **Read the audit, both mirrors, both guards, and the vendored crate cache** → fixed-offset decision (evidence above), no new crates.
2. **lock-math.ts**: `ScheduleRule` gains `tzOffsetMinutes?: number | null` + `tzName?: string` (display-only). New `ruleDayStart(r, nowMs, dayOffset)`: pinned rules compute wall time as `nowMs + offset` read in the **UTC frame** (so evaluation ignores the device zone entirely); legacy rules keep the old `Date`-local `midnight()` path. `ruleWindowEnd`/`nextBoundary` go through it. `validateScheduleRule` bounds the pin to real-world offsets (−720…+840) and the name to ≤64 chars.
3. **lock_math.rs mirror**: same two optional fields (`Option<i32>`, `Option<String>`, serde default = legacy). `pinned_offset()` → `FixedOffset` per rule, with heterogeneous dispatch in `rule_window_end`/`rule_boundaries_tz` (pinned rules use the fixed zone, legacy rules the caller's).
4. **Write-path stamping (lock.ts `setSchedules` — the ONLY legal schedule write path):** rules missing `tzOffsetMinutes` are backfilled with the device's **current** offset (`-new Date().getTimezoneOffset()`) and `tzName` from `Intl`; rules arriving pinned keep their pin.
5. **Cumulative anchor, extension (`lock-enforcer.ts`):** `storage.local.lockClockAnchor` = `{ wall0, mono0 }`, created on the first locked tick, **persisted** (SW restart can't forgive drift), **cleared** the moment nothing is locked. Formula per tick:
   `unexplained = (wall − wall0) − (mono − mono0)`; if `> 60_000` → shift all active deadlines (`timerUntil`/`frozenUntil` later than now) by the full amount, `console.warn`, re-base `wall0 += unexplained` (keeps `mono0`) so it doesn't double-fire. The old per-tick guard stays as detector 1 and re-bases the anchor by the same skew. `mono < mono0` ⇒ the clock's origin reset (SW restart) ⇒ silent re-anchor — drift while the process was dead is unattributable and deadlines are wall-based anyway.
6. **Daemon (`daemon.rs`):** identical design — `ClockAnchor` in `clock-anchor.json` beside `lock-state.json` (atomic temp+rename, best-effort); pure `clock_anchor_step()` returns Create/Reanchor/Compensate(unexplained)/Quiet so it's directly unit-testable; `compensate_clock_tamper` was split into the per-tick detector plus a shared `apply_clock_compensation` (shift → persist → broadcast → `events.log`). Kept out of `store.rs` (not in my file list) — daemon.rs writes the file itself, mirroring how `log_event` already does direct fs.
7. **Merge (`merge.rs` + TS):** schedule arrays were already merged wholesale (per-side winner/union), but the same-id **canonical tiebreak** gained the tz fields — otherwise two same-id rules differing only in pin would make `merge(a,b) != merge(b,a)` (breaks the commutativity the fixtures assert).
8. **Fixtures + tests:** 8 new golden cases + 5 new TS-local tests + 5 new Rust unit tests + 5 new daemon tests. Deliberately, the tz fixtures pin explicit offsets so they are **host-zone-independent** (the Node runner can't fake the local zone); legacy evaluation stays covered by each language's pre-existing local-zone tests.

## 4. Alternatives, tradeoffs, residuals

- **Fixed offset vs IANA zone name:** an IANA pin would follow DST; impossible offline today (evidence in §2). **Residual, documented in code (field docs, fixture `_note`) and tested by name ("DST residual documented…"):** a rule pinned on winter time fires **one hour off** the civil clock after a DST change, forever. Accepted because a 1-hour civil drift is far better than a one-line tz bypass, and the window still fires at invariant absolute times daily. If a tzdata crate is ever vendored, only `pinned_offset`/`ruleDayStart` change.
- **Mono-clock suspend behavior (honest, platform-dependent):** while the device sleeps the monotonic clock may pause (Linux `CLOCK_MONOTONIC`/`Instant`, Chrome `performance.now()`), so a wake looks like a wall jump and **extends** active locks by the slept duration once (fail-safe direction; pre-existing per-tick behavior, now also re-anchored). On platforms where mono keeps running during suspend (e.g. modern Windows QPC), no false shift.
- **Restart blind spot (accepted):** drift accumulated *while the daemon/SW was dead* is unattributable; locks that expired by the wall clock in that window stay expired. Fail-safe consistent with the audit's own #36 residual.
- **Schedules in clock compensation:** never shifted (wall-clock windows by definition) — both detectors only move `timerUntil`/`frozenUntil`.
- **Anchor is NOT in the LockState CRDT:** peers must never merge each other's clocks; it's a per-node blob (`storage.local.lockClockAnchor` / `clock-anchor.json`).

## 5. Verification (observed, this machine)

- `node scripts/lock-math-test.mjs` → **77 passed, 0 failed** (was 65; fixtures 37 → 45 cases; +5 local tests).
- `cd companion && cargo test --offline` → **103 passed, 0 failed** (97 unit + fixtures), incl. new: `cumulative_anchor_catches_the_sub_tolerance_ratchet` (+55 s/5 s ratchet fires at tick 2 with `Compensate(100_000)`), `clock_anchor_step_boundaries`, `clock_anchor_persists_across_store_reopens_and_clears`, `pinned_rule_evaluates_in_its_own_offset_not_the_machines`, `fixed_offset_pin_documents_the_dst_residual`.
- `cargo clippy --offline --all-targets -- -D warnings` → no issues; `cargo fmt --check` → clean.
- `npm run typecheck` → clean.
- Existing 3 jump-guard daemon tests updated to the `Option<i64>` return and still pass — detector-1 semantics unchanged.
