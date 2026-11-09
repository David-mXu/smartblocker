# Daemon-observed extension-loss grace countdown

**Date:** 2026-11-08

**Scope:** Phase 5 item 8 across the Rust companion, protocol v2,
extension cache/popup/options, and desktop browser status. The implementation is
uncommitted; the focused item 8 ordering/security review is complete and clean.
Unrelated worktree changes were left alone.

## 1. Problem and outcome

During an active lock, the daemon starts a 60-second grace track after a
supported browser's authenticated extension becomes unresponsive. The browser
can then be closed. SmartBlocker had no trustworthy visible equivalent of Cold
Turkey's countdown:

> Extension lost: browser may close in Ns unless it returns.

The first extension-only pass established the key observability boundary: an
outgoing Native Messaging heartbeat proves only that JavaScript handed a frame
to the relay. It does **not** prove when the daemon received it or when the
enforcer created its suspect track. A countdown inferred from send timestamps
would be invented, especially across relay loss, service-worker suspension,
and the daemon's three-second enforcing tick.

The completed change now supplies the missing authority:

- the enforcer exposes the remainder of the exact suspect track used for close
  decisions;
- authenticated extension recipients receive their own observation through an
  optional additive `companionStatus.status.extensionLoss` field;
- popup/options validate and receipt-clock-stamp that observation, interpolate
  it once per second, and receive daemon refreshes on transitions and every 10
  seconds during active grace;
- a disconnected/degraded extension cache drops the numeric observation and
  shows only the existing non-numeric fallback while locked;
- the desktop reads a separate post-tick grace snapshot, so its warning remains
  available after that browser's relay disappears;
- protocol remains **v2**. Old status payloads and old snapshot files remain
  valid because the fields are optional/defaulted.

## 2. Concepts and authoritative data flow

A **monotonic clock** measures elapsed time independently of wall-clock date
changes. The daemon already uses it for heartbeat and grace decisions. No daemon
monotonic timestamp crosses into JavaScript display arithmetic.

For one browser, [`enforcer.rs`](../../companion/crates/smartblocker-core/src/enforcer.rs)
now exposes:

- `grace_remaining_ms(kind, now_mono_ms)`: the selected suspect track's
  remainder, clamped at zero;
- `grace_browsers()`: active tracks in stable Chrome/Edge/Firefox order.

The enforcement loop in [`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs)
writes the next `EnforcerState` to shared state **after** `enforcer::tick`, then
uses the same tick's monotonic value for personalized observations and the
status snapshot. This ordering prevents either UI from seeing the previous
tick's deadline.

The authenticated wire observation has this shape:

```ts
extensionLoss?: {
  state: 'connected' | 'grace';
  graceSeconds: number;
  graceRemainingMs: number | null;
}
```

Here `connected` means **no active grace track**, not a separate inference made
from an outgoing heartbeat. The `grace` branch carries a numeric remainder.

The desktop snapshot has a separate `browserGrace` collection rather than
reusing `browsers`. That distinction matters: the connected-browser list must
lose a disconnected relay, while the enforcer's close deadline still exists.
Each desktop entry carries the snapshot's wall-clock `observedAtMs` and its
relative `graceRemainingMs`.

## 3. Implementation steps and evidence

### Step 1 — Add additive protocol and enforcer observations

The initial implementation added the optional v2 status field, snapshot field,
pure accessors, wire compatibility tests, and post-tick publication. Enforcer
tests check the exact 60-second, mid-grace, and zero-at-deadline values against
the same transitions that produce close actions.

**Decision:** use relative milliseconds rather than serializing daemon
monotonic timestamps. JavaScript can safely subtract elapsed local receipt time,
not two unrelated clock epochs.

### Step 2 — Publish recipient-specific updates without healthy churn

The daemon sends an observation on an authenticated hello, on grace begin and
recovery/lock end, and every 10 seconds while any grace track is active. Healthy
peers do not receive a new personalized status on every three-second enforcement
tick. Unauthenticated greetings and degraded `running:false` relay statuses have
no observation; redaction also strips one defensively.

The daemon regression suite verifies immediate transitions, the ten-second
refresh, no intermediate per-tick traffic, recipient-specific Chrome/Edge
results, and no anonymous disclosure.

### Step 3 — Validate and cache on the extension receipt clock

[`grace-math.ts`](../../src/shared/grace-math.ts) validates untrusted wire data.
For a valid grace observation:

```text
G       = graceSeconds × 1000
R0      = clamp(graceRemainingMs, 0, G)
elapsed = max(0, nowMs - observedAtMs)
R       = clamp(R0 - elapsed, 0, G)
seconds = max(0, ceil(R / 1000 - 1e-9))
```

`observedAtMs = Date.now()` is assigned only when the background receives the
status. Explicit `connected` state clears a previous countdown. Invalid/missing
observations become unknown, not an estimate. Relay disconnect,
`running:false`, and reconnect setup clear the live numeric observation.

A disconnected extension therefore cannot keep claiming to show its own live
number. While locked, a previously observed watchdog-capable companion falls
back to:

> Extension disconnected. If the desktop app is still enforcing your lock, its
> close grace may be running; the remaining time is unavailable.

The desktop app still has its independent daemon-file view and can retain a
real countdown after relay loss.

### Step 4 — Wire popup, options, and desktop

[`ExtensionGraceNotice.tsx`](../../src/components/ExtensionGraceNotice.tsx) is
used by popup and options. Their existing one-second display clocks update the
seconds; the options storage listener now refreshes `companionSnapshot`
immediately instead of waiting for its five-second fallback poll.

The desktop Browsers page prioritizes an active grace track over ordinary
Protected/Not protected labels. Its one-second clock interpolates between
status polls. An injected preview scenario models Chrome relay loss with 42
seconds left and no Chrome entry in `browsers`.

### Step 5 — Close focused-review security and consistency findings

A read-only review then found three concrete issues:

1. **Cross-browser re-hello and enqueue race.** Pairing authenticated a token,
   but a second hello could overwrite the registered browser. Personalized
   publication also captured a recipient, released the registry lock, and later
   checked only authentication. Both are fixed: authenticated browser identity
   is immutable across re-hellos, and `reply_to_browser` checks the expected
   authenticated browser again while handing the frame to the bounded queue.
   Tests cover conflicting registration and a deliberate low-level registry
   replacement between observation construction and delivery.
2. **Delayed options clearing.** The options storage listener now calls the same
   background-cache refresh on `companionSnapshot` changes. A rendered fixture
   disables only the five-second fallback interval, so its storage-event test
   cannot pass accidentally through polling.
3. **Stale desktop grace after unlock.** The lock can end between daemon ticks.
   Desktop status now projects snapshot grace through the freshly derived lock
   state; a core snapshot regression proves unlocked status returns no grace.
4. **Old grace hello after connected recovery.** Construction and queue handoff
   were separate, so a paused hello could otherwise enqueue an old grace frame
   after the one-time recovery broadcast. A grace-track revision now advances
   only when tracks begin, clear, or restart. Observation construction captures
   that revision under the enforcer-state lock discipline, and queue handoff
   rejects a mismatched capture. A deterministic regression constructs the old
   hello, publishes recovery, attempts the old enqueue, and observes only the
   connected frame.
5. **Same-track remainder inversion.** Track revisions do not change as time
   passes, so two captures on one track needed a finer ordering rule. Each
   observation now receives a sequence while its remainder is captured under
   `enforcer_state`. Each connection has a high-water mark checked and advanced
   under the registry lock after a successful queue send; entry replacement on
   heartbeat/re-hello preserves the mark. A regression queues newer then older
   same-revision observations and confirms only the newer frame survives, even
   after entry replacement.

These fixes did not change heartbeat handling, close decisions, lock merges, or
protocol v2. The final focused re-review reported no actionable findings.

## 4. Alternatives and tradeoffs

- **Estimate from outgoing heartbeats:** rejected; sends are not daemon
  observations and grace starts on an enforcement tick.
- **Start a number on relay disconnect:** rejected for the extension; disconnect
  does not prove the enforcer's track state. Desktop is different because it
  reads the daemon's actual shared post-tick snapshot.
- **Put grace browser names into `browsers`:** rejected; that would misrepresent
  relay presence and could leak another browser's deadline to an extension.
  Personalized status and the local desktop report are separate contracts.
- **Bump the protocol:** unnecessary; old peers ignore optional observations and
  old snapshots default `browserGrace` to empty.
- **Push every enforcing tick:** rejected as avoidable status/storage churn.
  Ten-second authoritative refreshes plus local interpolation bound clock drift
  without a per-second service-worker wakeup.
- **Serialize all status construction and sends with one global lock:** rejected;
  the enforcer-revision and observation-sequence checks provide the required
  ordering without holding registry and enforcer mutexes together. Healthy
  peers still need no periodic pushes, and stale messages are discarded instead
  of adding recovery/chronology fields to protocol v2.

## 5. Verification

Observed on Linux/WSL in this worktree:

- `node scripts/grace-math-test.mjs` — **24 passed, 0 failed**, including wire
  validation, receipt stamping, connected recovery, countdown/rounding, and
  malformed or non-finite input.
- `npm run typecheck` — passed.
- `npm run build:chrome`, `npm run build:firefox`, and `npm run build:desktop`
  — all passed. The last command builds the desktop frontend, not the Tauri
  executable.
- `cargo test` with workspace default members — **180 core tests + 4 fixture
  tests + 2 stdio integration tests passed** in the final combined worktree.
  The onboarding module contains 12 item 11 tests. Coverage includes
  authenticated re-hello, recipient/queue-handoff checks,
  grace-after-recovery revision invalidation, same-track high-water ordering,
  recipient privacy, cadence, relay-retained desktop grace, unlock projection,
  and old-peer/snapshot compatibility.
- `cargo clippy -p smartblocker-core -p smartblocker-nm-host
  -p smartblocker-daemon --all-targets -- -D warnings` and `cargo fmt --all --
  --check` — passed.
- `node scripts/e2e-companion-test.mjs` — **COMPANION E2E: ALL PASSED** using
  real headless Linux Chromium, the built extension, real nm-host, and real
  daemon. New assertions observed the genuine healthy daemon field and mapped
  receipt-stamped cache value, genuine daemon-loss clearing/options updates,
  and recovery. A separately labeled **INJECTED UI FIXTURE** rendered numeric
  countdowns in popup/options and proved immediate storage-event clearing.
  The fixture did not pretend to simulate an enforcer heartbeat outage.
- Final built desktop `file://` preview with
  `?mock=locked,extension-grace#browsers` — Chrome displayed **42s → 41s**,
  remained distinct from connected browsers, Edge stayed Protected, and
  “Preview data” was visible. This was one of ten final headless Playwright
  preview checks; the other nine cover item 11 repair and inspection states.
  These are labeled mock UI assertions, not native-shell or real-registration
  results.

The first desktop render used `?mock=extension-grace` without a lock and showed
“Not protected” because the mock correctly removed grace during unlocked lock
derivation. Composing the existing `locked` scenario fixed the test input; no
production assertion was weakened. An earlier accidental
`cargo test --workspace --no-run` attempted the Tauri member and failed on
unavailable Linux desktop dependencies. The explicit default-member command is
the valid headless gate; neither observation is native-Windows or Tauri runtime
verification.

## 6. Residual limits

- No physical browser was closed by this item's tests; existing enforcer tests
  cover the close action and the full-loop daemon uses its controlled test
  environment.
- Receiving a live numeric observation at a truly disconnected extension is
  contradictory: it cannot keep displaying a daemon countdown. Numeric
  rendering is therefore checked with a
  clearly labeled injected cache response, while real authority, loss clearing,
  and recovery are checked separately.
- No native-Windows enforcement, Windows service, real Tauri shell, or desktop
  native-runtime behavior is claimed by these Linux/WSL results.
