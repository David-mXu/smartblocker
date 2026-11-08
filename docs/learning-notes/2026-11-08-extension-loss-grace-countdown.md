# Extension-loss grace countdown: honest extension partial and the daemon datum still needed

**Date:** 2026-11-08
**Scope:** Phase 5 Batch 2 item 8; extension-side worktree only. No `companion/` changes, no protocol fields added, no settings/manifests changes.

## 1. Problem and outcome

SmartBlocker's daemon can close a supported browser during an active lock after its extension stops responding. Cold Turkey shows a visible grace countdown; SmartBlocker showed no equivalent in the popup. The requested sentence was:

> Extension lost: browser may close in Ns unless it returns.

The investigation found a hard observability boundary: **the current extension protocol does not expose the daemon's grace track or even acknowledge that an outgoing heartbeat was received.** A truthful numeric countdown therefore cannot be activated with extension-only changes.

This change ships the extension pieces that are honest today:

- pure, tested countdown math requiring an enforcing-peer observation;
- a shared popup/options notice that can render real seconds when given that observation;
- a current-protocol fallback shown only while locked, after a previously observed watchdog companion disconnects. It explicitly says the remaining time is unavailable instead of estimating it;
- the existing popup 1-second display clock plus a 10-second background-cache re-check, with no per-second service-worker alarm;
- silence when unlocked, when no companion is installed, or when no companion was ever observed.

**The full visible-countdown roadmap item remains partial.** An additive daemon status observation is required to finish it.

## 2. Evidence: the actual data and enforcement clocks

### Extension protocol and cache

[`src/shared/companion-protocol.ts`](../../src/shared/companion-protocol.ts) defines the complete `CompanionStatus` payload as:

```ts
{
  companionVersion: string;
  pro: boolean;
  enforcement: {
    appBlocking: boolean;
    watchdog: boolean;
    policyProtected: boolean;
  };
  lockState: LockState;
}
```

There is no grace state, grace start, remaining time, grace duration, daemon-observed heartbeat age, or status-observation timestamp. The cached `CompanionSnapshot` adds only:

```ts
{
  state: 'not-installed' | 'connecting' | 'connected' | 'disconnected';
  status: CompanionStatus | null;
  lastConnectedAt: number | null;
}
```

`lastConnectedAt` is assigned in `markConnected()` in [`src/background/companion.ts`](../../src/background/companion.ts). It records connection confirmation, **not each daemon-received heartbeat**.

The only extension heartbeat message is:

```ts
{ v: number; type: 'heartbeat'; now: number }
```

The extension sends it every `HEARTBEAT_INTERVAL_MS = 20_000` after connection confirmation. `send()` uses `port.postMessage()` and catches a dead-port exception. A non-throwing send proves only that the extension handed a frame to Native Messaging; it is not a daemon acknowledgement.

`companionStatus` arrives after hello and is pushed on daemon status changes. Heartbeats have no status reply. The extension runtime message `GET_COMPANION_STATUS` is different: its handler in [`src/background/index.ts`](../../src/background/index.ts) calls `getCompanionSnapshot()` and returns the extension's in-memory/storage cache plus incognito-access state. **It does not query the daemon.** Options already re-read that cache every 5 seconds; the popup now does so every 10 seconds while open. Existing traffic therefore supplies bridge/cache freshness, not fresh enforcement state.

### Daemon behavior (read-only inspection)

No Rust files were changed. These facts come from read-only inspection of the existing sources:

- [`enforcer.rs`](../../companion/crates/smartblocker-core/src/enforcer.rs) declares `HEARTBEAT_GAP_MS = 45_000` and `WATCHDOG_GRACE_MS = 60_000`. These are daemon constants, not an extension setting. Cold Turkey's separately documented `extensionGracePeriod` is tunable; SmartBlocker's current constant is not.
- `ConnInfo` holds `last_heartbeat_mono_ms`, a daemon monotonic timestamp. It is not serialized in `CompanionStatus`.
- [`daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs) calls `touch(...)` when a frame arrives. Its heartbeat parse arm is only `Some(CompanionMessage::Heartbeat { .. }) => meaningful = true`; the wire `now` value is ignored. Receipt time, not the extension-provided timestamp, drives liveness.
- The enforcer runs every `ENFORCE_TICK_MS = 3_000`. Once the last received heartbeat is at least 45 seconds old, the first enforcement tick creates a `SuspectTrack { since_mono_ms: now_mono_ms }`.
- Browser close occurs when `now_mono_ms - since_mono_ms >= 60_000`. The grace starts when the suspect track is first observed by the enforcer, not at a timestamp the extension can reconstruct exactly.
- The daemon currently emits one notification when a suspect track begins. That notification says the browser will close in 60 seconds; it is not streamed through `companionStatus` and is not a ticking extension countdown.

Consequently, `last extension send + 45s + 60s` would be approximate, not authoritative. Relay failure, a reaped service worker, daemon downtime, the 3-second enforcement cadence, and independent monotonic clocks all invalidate treating it as the real deadline. A disconnected daemon also cannot enforce the deadline such a banner would claim to visualize.

## 3. Implementation and count formula

### Pure math

[`src/shared/grace-math.ts`](../../src/shared/grace-math.ts) is browser-free and erasable-syntax-only, so Node imports it directly. Its observation contains:

- `state: 'connected' | 'grace'` — explicit enforcing-peer state, never inferred from sends;
- `observedAtMs` — extension display-clock time when that status was received;
- `lastHeartbeatAtMs` — optional daemon-observed diagnostic timestamp, deliberately unused in deadline arithmetic;
- `graceRemainingMs` — daemon-computed relative time left at `observedAtMs`;
- a separate `graceSeconds` argument.

Missing/invalid status, grace duration, or active-grace remainder yields `{ state: 'unknown', remainingMs: null }`. Explicit connected status yields `connected` and clears the countdown. For a valid grace observation, with `G = graceSeconds × 1000`:

```text
R0      = clamp(graceRemainingMs, 0, G)
elapsed = max(0, nowMs - observedAtMs)
R       = clamp(R0 - elapsed, 0, G)
state   = R > 0 ? 'grace' : 'expired'
```

`remainingMs` is null for connected/unknown and exactly zero for expired. Backward local clock jumps cannot inflate the countdown beyond its initial remaining time or grace cap; forward jumps consume time. All calculations reject or clamp NaN/Infinity paths.

The one-second display uses:

```text
seconds = max(0, ceil(R / 1000 - 1e-9))
```

The tiny `GRACE_DISPLAY_EPSILON_SECONDS` avoids rounding an exact whole second upward under interval precision jitter while preserving a positive sub-second remainder as `1s`.

Relative daemon milliseconds are important: the extension must never subtract the daemon's monotonic timestamp from its own wall clock.

### Shared UI and visibility

[`src/components/ExtensionGraceNotice.tsx`](../../src/components/ExtensionGraceNotice.tsx) supplies the Lamplight warning-tint notice to both surfaces:

- popup `#extension-grace`, immediately below the lock line;
- options Desktop app `#companion-grace`, in the existing Status section.

With a valid grace observation it renders the requested `…may close in Ns…` sentence and updates from each surface's existing 1-second `now` state. Reconnect/connected status hides it. An expired observed grace has non-numeric expiry copy.

With protocol v2 there is no observation, so the only current notice is the honest fallback:

> Extension disconnected. If the desktop app is still enforcing your lock, its close grace may be running; the remaining time is unavailable.

That fallback requires all of the following:

1. `lock.settingsLocked` is true;
2. the bridge currently reports `disconnected`;
3. a real cached `CompanionStatus` exists and reported `enforcement.watchdog === true`.

Thus an unlocked session, a never-installed companion, `connecting`, and an anonymous disconnect with no observed companion status stay quiet. The warning tone indicates weakened protection; amber remains reserved for commitment/focus. Numeric ticks use `aria-live="off"` to avoid one screen-reader announcement per second.

No notification permission path, service-worker alarm, Rust/protocol change, or new setting was added. An `extensionGraceSeconds` extension setting would be cosmetic only: it could not alter the daemon's fixed enforcement constant, so adding it would make the UI less truthful.

## 4. Alternatives and tradeoffs

1. **Estimate from the last outgoing heartbeat.** Rejected. Send success is not receipt acknowledgement, grace begins on a daemon enforcement tick, and the daemon may not be running to enforce anything.
2. **Start a 60-second countdown immediately on port disconnect.** Rejected. Disconnect is real bridge state but not proof that a daemon suspect track exists.
3. **Mirror 60 seconds in extension settings.** Rejected. The user could change the displayed number without changing enforcement. The existing daemon constant is usable as documentation, not as live grace state.
4. **Wait silently rather than ship the fallback.** The fallback was retained because it communicates the actual observation and uncertainty without a fake number. The roadmap remains explicitly partial rather than claiming parity.
5. **Add a new runtime polling RPC to the daemon.** Not possible with extension-only/no-protocol-change scope. The existing `GET_COMPANION_STATUS` is cheap but cached; the popup documents that distinction at its 10-second call site.

## 5. Open question: minimal future daemon cooperation

A future coordinated daemon change can finish the feature without a new message type:

1. Add an **optional additive field to the existing `companionStatus.status`** for this authenticated browser, conceptually:

   ```ts
   extensionLoss?: {
     state: 'connected' | 'grace';
     graceSeconds: number;
     graceRemainingMs: number | null;
     // Optional diagnostics only; never required for deadline math:
     lastHeartbeatAtMs?: number | null;
   }
   ```

   Older peers ignore unknown fields under the protocol's forward-compatibility rule.

2. Compute `graceRemainingMs` in the enforcer loop from the **same `SuspectTrack` and `now_mono_ms`** used for the close decision. Do not derive it again in UI code. Set `state: 'connected'` when that browser has a fresh authenticated heartbeat or no armed lock; clear the field in the grace track.

3. Publish the existing `companionStatus` on grace begin, recovery/lock end, and at least every 10 seconds while grace is active. The daemon may push updates more often; the extension only interpolates between authoritative observations. The background should stamp local `observedAtMs = Date.now()` when applying each status and cache the mapped observation for popup/options consumers.

The open coordination question is how best to expose the enforcer thread's suspect track to `Shared::status()` (or send targeted status frames from that loop) with the smallest locking change. That decision belongs in the companion stream; this task intentionally did not guess at or modify the Rust ownership model.

## 6. Verification

Exact commands and observed results:

- `node scripts/grace-math-test.mjs` — **21 passed, 0 failed**. Covers connected, explicit heartbeat-loss/grace input, before/at/after deadline, fresh-status recovery, unavailable status/duration, invalid values, backward/forward clock edges, cap clamps, epsilon rounding, 1-second decrements, and copy.
- `node scripts/lock-math-test.mjs` — **77 passed, 0 failed**, unchanged.
- `npm run typecheck` — passed.
- `npm run build` — both `dist/chrome` and `dist/firefox` passed. `npm ci` was run with `--ignore-scripts` as permitted by the task because the worktree had no `node_modules`.
- `npm run eval` — **PASS: no regressions** across all 15,874 cases: top-1 95.4% (9,221/9,664), productive false positives 0.4% (23/6,210), must-block recall 97.6% (7,140/7,317), collateral false positives 0.0% (0/2,280), and end-to-end decision accuracy 98.7% (15,607/15,807). Every metric was unchanged from the 2026-11-05 baseline, with no per-case changes.
- `git diff -- companion` — empty; the daemon was inspected read-only.
- No Playwright tests were run, per worktree instruction. No rendered end-to-end daemon loss was claimed: protocol v2 cannot produce the numeric state, and the current fallback was verified through code/type/build checks rather than a simulated daemon enforcement event.

A development test initially asserted `59_499ms → 59s`; that expectation was wrong for ceiling semantics and was corrected to `60s`. No production math was weakened to make the test pass.
