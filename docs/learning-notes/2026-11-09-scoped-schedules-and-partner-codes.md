# Category schedules and accountability-partner codes

## Problem and feature goals

Item 14 adds two distinct primitives:

1. schedules that affect selected categories, not the whole lock;
2. offline accountability-partner codes whose partner changes activate after a 24-hour delay.

They must coexist with existing lock types, legacy schedule locks, browser synchronization, and mixed older peers. All work remains uncommitted and both eval datasets are untouched.

## Category-scoped schedules

### Separate schema instead of rewriting legacy schedules

A legacy `schedules` entry still locks settings and forces ordinary blocking globally. Auto-resume consults only this legacy list. Putting category scope directly onto those entries would be unsafe: an older Rust daemon could discard the category list and rebroadcast the remaining entry as a global forced lock.

Instead, `categorySchedules?: CategoryScheduleRule[]` is an **optional additive state field** with its own `categorySchedulesUpdatedAt` stamp in [`lock-math.ts`](../../src/shared/lock-math.ts) and [`lock_math.rs`](../../companion/crates/smartblocker-core/src/lock_math.rs).

- Absent field: this peer has no scoped-state capability and gets **no vote**.
- Explicit stamped empty array: deliberate modern deletion.
- Malformed scoped payload (including duplicate IDs or fractional stamps): neutral update, not a deletion.

An active selected-category window applies confident classifier verdicts. An inactive selected-category window rescues ordinary classifier blocks. Ordinary blocking must still be enabled. Whitelists and deterministic allow/block rules keep their precedence; the scoped rule never becomes `forceBlocking`, `settingsLocked`, or a global lock reason. Same-category active windows win over overlapping rescue windows.

### Merging is an enforcement decision, not a simple LWW pick

Review exposed the important distinction: a global timer may coexist with an active category window. If both peers are protected, ordinary timestamp LWW could discard the only active category rule without actually shortening the timer.

The merge therefore starts with the normal protected/LWW winner, then overlays **all currently active scoped rules from both peers** in [`lock-math.ts`](../../src/shared/lock-math.ts) and [`merge.rs`](../../companion/crates/smartblocker-core/src/merge.rs). Active same-ID enforcement replaces inactive material; after every window expires, normal LWW/deletion semantics resume.

Additional parity work includes:

- Duplicate IDs rejected at write/sanitize boundaries with whole-list neutrality; already-corrupt merges prefer active material deterministically.
- Unique IDs, timezone names, categories, and raw conflicts use a common UTF-8 canonical ordering so JS UTF-16 order and Rust UTF-8 order cannot diverge.
- Metadata requires JS-safe integer stamps rather than TS keeping fractional values while Rust truncates them.
- Timezone-name limits use UTF-16 code units in both languages.
- Even unique inactive winners are canonicalized on the first merge so a self-merge cannot reorder the list a second time.

[`setCategorySchedules`](../../src/shared/lock.ts) is the guarded storage transition. It pins timezone offsets, validates list-wide integrity, requires legacy settings unlocked, and forbids editing an active scoped window. It preserves legacy values exactly.

### Classifier-generation and lazy-DOM behavior

A rule write is not the only transition. Scoped boundary time also changes policy, and metadata/classifier calls can overlap the change.

[`blocker.ts`](../../src/background/blocker.ts) uses a scoped policy epoch. Epoch increments occur on scoped edits and lock-enforcer boundaries. All three successful-classifier decision paths apply the same pure gate, with retries of the epoch at evaluation, response, and async application boundaries (including override-token mints and DNR awaits). Cached decisions are invalidated by boundary sweeps. Late old evaluations cannot clear a newer active block.

[`sanitize-page.ts`](../../src/content/sanitize-page.ts) owns a distinct issue seen only in real pages. Existing allowed cards and classifier masks previously stayed skipped forever. Classifier-owned masks now carry an ownership marker. On an epoch change, those markers, allowed states, and embedded media sources are reset/re-evaluated; deterministic masks and user-revealed states are untouched. Each scan's dispatch captures the current epoch, so a persistent `MutationObserver` still accepts **lazy cards inserted after multiple epoch changes**, not just the epoch of its first sanitizer injection.

The real Chromium E2E verifies inactive allowed → active mask → inactive allowed transitions for existing search cards and lite-YouTube embeds without navigation, lazy insertion after repeated epochs, and deterministic mask survival. A simple filename or in-memory model test would not find this lifecycle bug.

## Accountability partners

### Trust and activation

The key belongs on the **partner's** device. `partner-keygen` generates an Ed25519 secret/public pair offline with OS randomness. `partner add-key PUBLIC` registers only the public half and sets activation exactly `added + 24h`. Duplicate re-registration does not move activation. No expedite or approval channel bypasses the delay.

Arming requires an already-active key and no active settings lock. It creates a fresh random arm generation in `lock-state.json`; ordinary `enabled` is not changed automatically. Adding or rotating keys does not release or replace an existing arm. Present corrupt `partner-state.json` is not replaced by a new trust root.

### Signed operation lifecycle

`partner begin` requires that current arm and emits a pending operation with:

- installation ID,
- exact arm generation,
- random operation ID and nonce,
- locally minted expiry (15 minutes maximum).

[`partner.rs`](../../companion/crates/smartblocker-core/src/partner.rs) uses RustCrypto/dalek-cryptography's strict Ed25519 verification. Code form is bounded `SBP1.<payloadHex>.<signatureHex>`, with all those fields signed and denied unknown fields. `SBPRO1` HMAC licensing material is independent and never serves as partner signing authority.

Redemption validates the pending operation, matching paid expiry, active public key, exact nonce, and one-time signature. It does not authorize a generic lock reset. The daemon first persists the replay tombstone, then clears only this exact arm if the current generation still matches. If the second file fails, there is no success acknowledgement; the replay was consumed but the arm remains locked, which may require a fresh partner code rather than falsely claiming a crash-free unlock.

Browser lock synchronization cannot bypass this path: partner fields are pinned against generic remote merges on both authenticated and unauthenticated paths. Raw storage edits cannot release an arm.

**2026-11-10 revision:** the daemon pins partner fields, but the browser previously merged the raw `lockState` copy with ordinary LWW. A raw `{partnerArmGeneration: null, partnerArmUpdatedAt: future}` could therefore make settings editable while the daemon stayed armed. The daemon-confirmed arm is now also stored in a separate `partnerArmState` pin; `getLockState` overlays it and `mergeRemoteLockState` treats daemon partner fields as authoritative, repairing a forged raw field. A partner-bearing frame older than the pin's stamp is ignored, daemon merges are serialized, and an armed raw state seeds the pin on the first read after an upgrade. Unauthenticated redacted syncs do not clear the pin. A same-user DevTools adversary can edit both storage keys, so this is an accidental/stale-write guard rather than the hard blocking boundary. Replay tombstones now retain every unexpired record; only expired records are pruned, so the old 256-entry cap cannot evict a live replay memo.

### Browser command path and UI

The native message bridge in [`companion.ts`](../../src/background/companion.ts) serializes partner commands because the legacy `CommandResult` has no operation ID. A result belongs only to the one command outstanding in that connection epoch. Disconnect rejects pending work and never resolves it through the new daemon epoch.

[`PartnerSection.tsx`](../../src/options/pages/PartnerSection.tsx) exposes public-key activation state, guarded arming, the actual pending operation JSON for `partner sign`, and code redemption. It never asks for or displays the private signing half. Its copy explicitly limits release to this arm: timer, Frozen, legacy schedules, password, delay, random-text and ordinary enabled remain unchanged.

## Verification

| Area | Executed evidence |
| --- | --- |
| Shared lock semantics | 155 TS lock-math cases, including scoped active overlays, Unicode conflicts, duplicates, partner LWW/release/sanitization and compound locks |
| Lock storage transitions | 24 focused store/gate tests, including category duplicate refusal/clock guards |
| Pure category gate | 17 tests: precedence, thresholds, confidence, top-2 mass, overnight and pinned zones |
| Partner protocol and browser bridge | 5 protocol groups (including real `partnerOperationFromResult` selection/refusal) + 8 browser-pin tests + all 12 actual-background tests for ordinary sync and partner single-flight/reconnect behavior |
| Companion core/daemon/relay | 255 Rust tests across six suites at implementation; **320** after the 2026-11-10 review fixes; clippy and rustfmt passed |
| Scoped browser lifecycle | Real lazy-card/embed active/inactive transition tests without navigation, plus deterministic ownership preservation |
| Full partner browser flow | `PARTNER E2E: ALL PASSED` (15 checks): aged active public key, new delayed key, real UI arm, forged raw-release refusal, reloaded-UI settings lock, wrong-key rejection, correct offline signing, exact release, other-gate preservation and replay failure |

Evidence is limited to Linux/WSL, Node, Rust, and real Chromium/native-messaging tests. Frontend Chrome/Firefox bundles and Rust wrappers were built/table checked, but Firefox native messaging, native Windows behavior, and a real Tauri shell were **not** exercised and are not claimed as verification. Item 12 deliberately remains hardware-blocked.

## Further notes

Extra intermittent startup latency has occurred in the broad legacy companion E2E harness. I do not claim a cause from individual timings; focused deterministic harnesses and isolated real browser/daemon loops are used for the new feature semantics. Remaining review findings should be recorded here with their actual remediation rather than treated as passing evidence ahead of the checks.
