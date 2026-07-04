//! flowguard-core: pure data core for the FlowGuard desktop companion.
//! No async, no UI deps — the daemon/nm-host bins (M5) and the tray app
//! (M7) layer plumbing on top of these sync building blocks.
//!
//! `lock_math` / `merge` / `protocol` mirror `src/shared/lock-math.ts` and
//! `src/shared/companion-protocol.ts`; cross-language parity is enforced by
//! `tests/fixtures/lock-cases.json`, which the TS suite
//! (`scripts/lock-math-test.mjs`) consumes too.

pub mod browsers;
pub mod daemon;
pub mod enforcer;
pub mod framing;
pub mod ipc;
pub mod lock_math;
pub mod merge;
pub mod procwatch;
pub mod protocol;
pub mod registration;
pub mod store;
