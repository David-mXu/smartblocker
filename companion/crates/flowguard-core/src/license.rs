//! License stub. Phase 4 ships the companion as "Pro" with no gate; real
//! key validation (Stripe/Lemon Squeezy, $39 lifetime — see ROADMAP.md) is a
//! later milestone. The config field and this seam exist now so the check
//! lands in exactly one place later.

use crate::store::CompanionConfig;

pub fn is_pro(_config: &CompanionConfig) -> bool {
    // TODO(licensing): validate config.license_key offline (signed token)
    // once the payment flow exists. Until then every install is Pro.
    true
}
