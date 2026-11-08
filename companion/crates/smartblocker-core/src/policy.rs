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

/// Full Chromium hardening policy object: kills the extension-free bypass
/// surfaces (incognito when requested, guest mode, extra profiles) and —
/// when `update_url` is available — force-installs the extension itself.
///
/// - `IncognitoModeAvailability: 1`  → incognito disabled entirely.
/// - `DeveloperToolsAvailability: 2` → devtools blocked for FORCE-INSTALLED
///   extensions specifically (policy scope that doesn't cripple web dev),
///   so the storage-wipe trick against the extension stops working under a
///   managed browser.
pub fn chromium_hardening_policies(
    update_url: Option<&str>,
    block_incognito: bool,
    block_devtools: bool,
) -> Value {
    let mut policy = serde_json::Map::new();
    if block_incognito {
        policy.insert("IncognitoModeAvailability".into(), json!(1));
    }
    policy.insert("BrowserGuestModeEnabled".into(), json!(false));
    policy.insert("BrowserAddPersonEnabled".into(), json!(false));
    if block_devtools {
        policy.insert("DeveloperToolsAvailability".into(), json!(2));
    }
    if let Some(url) = update_url {
        policy.insert("ExtensionSettings".into(), chromium_extension_settings(url));
    }
    Value::Object(policy)
}

/// Write Firefox's `distribution/policies.json` next to the browser binary.
/// Returns the file written. Linux/macOS Firefox installs honor this too,
/// so unlike the Chromium registry side this writer is cross-platform.
pub fn write_firefox_policies(
    install_dir: &std::path::Path,
    install_url: &str,
) -> std::io::Result<std::path::PathBuf> {
    let dir = install_dir.join("distribution");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("policies.json");
    std::fs::write(&path, format!("{:#}\n", firefox_policies(install_url)))?;
    Ok(path)
}

/// Best-effort application of managed-browser policies from config. Returns
/// true when a platform writer actually ran: off Windows the Chromium writer
/// is registry-based and doesn't exist yet, so this is an honest no-op there
/// (the watchdog remains the enforcement that works everywhere).
pub fn apply_configured_policies(config: &crate::store::CompanionConfig) -> std::io::Result<bool> {
    if !config.policy_enforce {
        return Ok(false);
    }
    let Some(update_url) = config.extension_update_url.as_deref() else {
        return Ok(false);
    };
    #[cfg(windows)]
    {
        windows::write_chromium_policies(update_url)?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = update_url;
        Ok(false)
    }
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

    #[test]
    fn hardening_policies_cover_bypass_surfaces() {
        let full = chromium_hardening_policies(Some("https://example.com/u.xml"), true, true);
        assert_eq!(full["IncognitoModeAvailability"], 1);
        assert_eq!(full["BrowserGuestModeEnabled"], false);
        assert_eq!(full["BrowserAddPersonEnabled"], false);
        assert_eq!(full["DeveloperToolsAvailability"], 2);
        assert_eq!(
            full["ExtensionSettings"][CHROME_EXTENSION_ID]["installation_mode"],
            "force_installed"
        );

        // Without an update_url there is no ExtensionSettings block at all,
        // and the optional kill switches stay off when not requested.
        let bare = chromium_hardening_policies(None, false, false);
        assert!(bare.get("ExtensionSettings").is_none());
        assert!(bare.get("IncognitoModeAvailability").is_none());
        assert!(bare.get("DeveloperToolsAvailability").is_none());
        assert_eq!(bare["BrowserGuestModeEnabled"], false);
    }

    #[test]
    fn firefox_policies_file_lands_in_distribution_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_firefox_policies(dir.path(), "https://example.com/sb.xpi").unwrap();
        assert_eq!(path, dir.path().join("distribution").join("policies.json"));
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let entry = &written["policies"]["ExtensionSettings"][GECKO_EXTENSION_ID];
        assert_eq!(entry["installation_mode"], "force_installed");
        assert_eq!(entry["install_url"], "https://example.com/sb.xpi");
    }

    #[test]
    fn apply_configured_policies_only_runs_when_armed() {
        let mut config = crate::store::CompanionConfig::default();
        // Off by default: never touches the system.
        assert!(!apply_configured_policies(&config).unwrap());
        // Armed but no update_url: still a no-op.
        config.policy_enforce = true;
        assert!(!apply_configured_policies(&config).unwrap());
    }

    #[cfg(not(windows))]
    #[test]
    fn apply_configured_policies_is_an_honest_noop_off_windows() {
        let config = crate::store::CompanionConfig {
            policy_enforce: true,
            extension_update_url: Some("https://example.com/u.xml".into()),
            ..crate::store::CompanionConfig::default()
        };
        assert!(!apply_configured_policies(&config).unwrap());
    }
}
