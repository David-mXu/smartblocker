//! smartblocker-core: pure data core for the SmartBlocker desktop companion.
//! No async, no UI deps — the daemon/nm-host bins (M5) and the tray app
//! (M7) layer plumbing on top of these sync building blocks.
//!
//! `lock_math` / `merge` / `protocol` mirror `src/shared/lock-math.ts` and
//! `src/shared/companion-protocol.ts`; cross-language parity is enforced by
//! `tests/fixtures/lock-cases.json`, which the TS suite
//! (`scripts/lock-math-test.mjs`) consumes too.

pub mod activity;
pub mod allowance;
pub mod app_targets;
pub mod apps;
pub mod browsers;
pub mod daemon;
pub mod enforcer;
pub mod focus_session;
pub mod framing;
pub mod ipc;
pub mod license;
pub mod lock_math;
pub mod merge;
pub mod onboarding;
pub mod partner;
pub mod policy;
pub mod procwatch;
pub mod protocol;
pub mod registration;
pub mod snapshot;
pub mod store;
pub mod supervisor;
pub mod win_meta;
