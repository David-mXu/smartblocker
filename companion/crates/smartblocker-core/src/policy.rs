//! Managed-browser-policy tamper-proofing — the honest version.
//!
//! Hard truth (verified 2026-07): Chrome/Edge honor `ExtensionSettings`
//! force-install from OUTSIDE their web stores only on managed devices
//! (domain/Azure-AD-joined or enrolled). On a plain consumer Windows box the
//! policy is silently ignored, HKLM or not. Firefox additionally requires
//! the XPI be Mozilla-signed. So until the Phase 3 store listing provides a
//! real `update_url`, this module ships implemented but OFF
//! (`CompanionConfig::policy_enforce = false`), the UI says "unavailable
//! until store release", and the watchdog (closing the browser) remains the
//! enforcement that always works.
//!
//! The JSON builders are pure and tested everywhere; the registry/file
//! writers are Windows-only.

use serde_json::{json, Value};

use crate::registration::{CHROME_EXTENSION_ID, GECKO_EXTENSION_ID};

/// Chrome/Edge `ExtensionSettings` policy value: pin the extension installed
/// and un-disableable. Only meaningful with a store or self-hosted
/// `update_url` on a managed device.
pub fn chromium_extension_settings(update_url: &str) -> Value {
    json!({
        CHROME_EXTENSION_ID: {
            "installation_mode": "force_installed",
            "update_url": update_url,
            "toolbar_pin": "force_pinned",
        }
    })
}

/// Firefox `policies.json` content (goes in `<install dir>/distribution/`).
/// `install_url` must point at a Mozilla-SIGNED xpi.
pub fn firefox_policies(install_url: &str) -> Value {
    json!({
        "policies": {
            "ExtensionSettings": {
                GECKO_EXTENSION_ID: {
                    "installation_mode": "force_installed",
                    "install_url": install_url,
                }
            }
        }
    })
}

/// Registry locations for the Windows writer (HKLM — sensitive policies are
/// ignored from HKCU; writing needs elevation AND a managed device to have
/// any effect).
pub const CHROME_POLICY_KEY: &str = r"SOFTWARE\Policies\Google\Chrome";
pub const EDGE_POLICY_KEY: &str = r"SOFTWARE\Policies\Microsoft\Edge";

#[cfg(windows)]
pub mod windows {
    //! Best-effort writers, called only when `policy_enforce` is true.
    use super::*;
    use std::io;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    pub fn write_chromium_policies(update_url: &str) -> io::Result<()> {
        let value = chromium_extension_settings(update_url).to_string();
        for root in [CHROME_POLICY_KEY, EDGE_POLICY_KEY] {
            let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE).create_subkey(root)?;
            key.set_value("ExtensionSettings", &value)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_policy_pins_the_stable_id() {
        let policy = chromium_extension_settings("https://example.com/updates.xml");
        let entry = &policy[CHROME_EXTENSION_ID];
        assert_eq!(entry["installation_mode"], "force_installed");
        assert_eq!(entry["update_url"], "https://example.com/updates.xml");
    }

    #[test]
    fn firefox_policy_targets_the_gecko_id() {
        let policy = firefox_policies("https://example.com/smartblocker.xpi");
        let entry = &policy["policies"]["ExtensionSettings"][GECKO_EXTENSION_ID];
        assert_eq!(entry["installation_mode"], "force_installed");
    }
}
