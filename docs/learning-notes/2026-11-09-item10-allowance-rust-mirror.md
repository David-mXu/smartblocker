# Item 10 allowance pure Rust mirror

## Goal and context

Mirror the final TypeScript allowance/accounting and authority-command behavior in the companion core without adding storage, daemon, IPC, time, or timezone dependencies. The source of truth was [`src/shared/allowance-math.ts`](../../src/shared/allowance-math.ts), [`src/shared/allowance-state.ts`](../../src/shared/allowance-state.ts), and their two Node test scripts.

The implementation is in [`companion/crates/smartblocker-core/src/allowance.rs`](../../companion/crates/smartblocker-core/src/allowance.rs), registered by `pub mod allowance;` in [`companion/crates/smartblocker-core/src/lib.rs`](../../companion/crates/smartblocker-core/src/lib.rs).

## Main concepts and decisions

- JavaScript safe integer timestamps and counters become validated `u64` values in persisted state. Command/config inputs remain `f64` until validation so NaN, infinity, negative, fractional, and unsafe values receive the same neutralization or explicit refusal as the TypeScript reducers.
- Per-ledger math and authority state are separate layers. Normalization handles real Gregorian day keys, monotonic observations, and forward-only rollover; no system clock or timezone is consulted.
- `AllowanceCategoryState.ledger` intentionally stores `serde_json::Value`. The TypeScript authority normalizer validates only category shape and day-key syntax, then postpones ledger sanitization until an observation. Keeping raw JSON preserves malformed-but-admitted history during `configure`, refusals, and duplicate retries instead of accidentally advancing or repairing it.
- Every transition takes borrowed inputs and returns owned clones. Command refusal returns normalized authority state without persisting an observation; commit separately validates a strictly higher safe revision and appends/trims the last 64 receipts.
- Matching operation ID and fingerprint is checked before expected revision, so an exact retry succeeds with `duplicate: true` and unchanged state even on a stale base. Reusing an ID with different content is `duplicate-operation`.
- Fingerprints are emitted manually as a compact JSON array to preserve TypeScript field order, explicit nulls, normalized config property order, and JavaScript integer spelling. Two exact Node-derived golden strings pin configure and request fingerprints.
- Rust stores strings as UTF-8. Validation uses UTF-16 code-unit length and the ECMAScript trim whitespace list where JavaScript does, including its BOM/NEL difference from Rust's default Unicode trimming.

## Investigation and implementation sequence

1. Read both TypeScript modules and both test scripts; ran the Node suites first as a baseline: 28 math tests and 11 authority tests passed.
2. Translated per-kind grant sanitization, pending reservation, wall-clock charging, exact-once settlement, cancellation/refund, capped rewards, opening idle/lifetime behavior, and free fixed-end Pomodoro grants.
3. Added strict top-level authority snapshot validation, a 64-category cap, raw per-category config and ledger storage, typed commands with closed serde shapes, explicit result refusals, and bounded atomic revision receipts.
4. Captured fingerprints and normalized state through Node v24 from the TypeScript reducer and embedded exact values as Rust tests; no external fixture file was added.
5. Ported the scenarios into 34 Rust tests, including malformed snapshots/statuses, unsafe numbers, time ceilings, immutability, rollover ambiguity, duplicate mismatch/retry, receipt cap, category independence, raw-history preservation, serde shape checks, and exact output goldens.
6. Ran rustfmt and strict Clippy; fixed one `clone_on_copy` warning and reran focused and full library verification.

## Alternatives and tradeoffs

- A fully typed `AllowanceLedger` inside each authority category would be more ergonomic but would not reproduce TypeScript's delayed ledger sanitization. The public `category_ledger` method and `derive_allowance_category` provide typed observation views while preserving the correct command semantics.
- JSON object member order is not used for authority persistence equality; semantic JSON values and exact fingerprint strings are asserted instead. Valid authority output uses the TypeScript field names and shape.
- Unknown JSON command kinds are admitted through `apply_allowance_command_value` and explicitly refused. Typed callers use `AllowanceCommand`; unknown fields fail closed at serde admission.
- No TypeScript discrepancies requiring a source edit were found. One intentional detail is that authority category validation checks day-key shape only, while real Gregorian validation occurs at ledger observation.

## Verification

Observed results in the companion workspace:

- `node scripts/allowance-math-test.mjs` — 28 passed before the port, establishing the source baseline.
- `node scripts/allowance-state-test.mjs` — 11 passed before the port.
- `CARGO_HOME=/tmp/opencode/smartblocker-cargo-home cargo test -p smartblocker-core allowance` — 34 passed; remaining tests filtered out.
- `CARGO_HOME=/tmp/opencode/smartblocker-cargo-home cargo clippy -p smartblocker-core --lib -- -D warnings` — no issues.
- `rustfmt --edition 2021 --check crates/smartblocker-core/src/allowance.rs crates/smartblocker-core/src/lib.rs` — passed.
- `CARGO_HOME=/tmp/opencode/smartblocker-cargo-home cargo test -p smartblocker-core --lib` — 237 passed.

Only pure Rust logic, unit tests, and module registration were implemented. No daemon integration, native packaging, platform enforcement, or TypeScript changes were performed or verified.
