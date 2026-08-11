//! Native-messaging host registration + autostart. Linux file paths here;
//! the Windows registry variants (HKCU NativeMessagingHosts keys via winreg)
//! land with the Tauri shell in M7. All paths take a `home` override so
//! tests never touch the real profile dirs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::protocol::NM_HOST_NAME;

/// Fixed by the committed `"key"` in manifests/chrome.json (Edge loads the
/// same dist/chrome build, so it shares the ID).
pub const CHROME_EXTENSION_ID: &str = "dhbhbhhcjkfdkfbloeaeedndfjfadajh";
/// Fixed by browser_specific_settings.gecko.id in manifests/firefox.json.
pub const GECKO_EXTENSION_ID: &str = "smartblocker-poc@davidxu.dev";

/// Chromium-family manifest (Chrome/Chromium/Edge): `allowed_origins`.
pub fn chromium_manifest(nm_host_path: &Path) -> serde_json::Value {
    json!({
        "name": NM_HOST_NAME,
        "description": "SmartBlocker desktop companion bridge",
        "path": nm_host_path,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{CHROME_EXTENSION_ID}/")],
    })
}

/// Firefox uses `allowed_extensions` (gecko IDs) instead of origins.
pub fn firefox_manifest(nm_host_path: &Path) -> serde_json::Value {
    json!({
        "name": NM_HOST_NAME,
        "description": "SmartBlocker desktop companion bridge",
        "path": nm_host_path,
        "type": "stdio",
        "allowed_extensions": [GECKO_EXTENSION_ID],
    })
}

/// Per-user manifest locations on Linux. Chromium-family browsers read
/// `NativeMessagingHosts/` under their user-data dir; Firefox reads
/// `~/.mozilla/native-messaging-hosts/`.
fn linux_targets(home: &Path) -> Vec<(PathBuf, bool /* firefox */)> {
    let file = format!("{NM_HOST_NAME}.json");
    vec![
        (
            home.join(".config/google-chrome/NativeMessagingHosts")
                .join(&file),
            false,
        ),
        (
            home.join(".config/chromium/NativeMessagingHosts")
                .join(&file),
            false,
        ),
        (
            home.join(".config/microsoft-edge/NativeMessagingHosts")
                .join(&file),
            false,
        ),
        (
            home.join(".mozilla/native-messaging-hosts").join(&file),
            true,
        ),
    ]
}

/// Write NM manifests for every supported browser. `nm_host_path` must be
/// absolute (browsers refuse relative paths).
pub fn install_linux(home: &Path, nm_host_path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for (path, firefox) in linux_targets(home) {
        let manifest = if firefox {
            firefox_manifest(nm_host_path)
        } else {
            chromium_manifest(nm_host_path)
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&path, format!("{:#}\n", manifest))?;
        written.push(path);
    }
    Ok(written)
}

pub fn uninstall_linux(home: &Path) -> Vec<PathBuf> {
    linux_targets(home)
        .into_iter()
        .filter_map(|(path, _)| fs::remove_file(&path).is_ok().then_some(path))
        .collect()
}

/// XDG autostart entry so the daemon survives logout/login. Windows uses the
/// HKCU Run key (M7).
pub fn install_autostart_linux(home: &Path, daemon_path: &Path) -> io::Result<PathBuf> {
    let dir = home.join(".config/autostart");
    fs::create_dir_all(&dir)?;
    let path = dir.join("smartblocker-companion.desktop");
    fs::write(
        &path,
        format!(
            "[Desktop Entry]\nType=Application\nName=SmartBlocker Companion\nExec={} run\nX-GNOME-Autostart-enabled=true\n",
            daemon_path.display()
        ),
    )?;
    Ok(path)
}

pub fn uninstall_autostart_linux(home: &Path) -> bool {
    fs::remove_file(home.join(".config/autostart/smartblocker-companion.desktop")).is_ok()
}

#[cfg(windows)]
pub mod windows {
    //! Windows registration: HKCU NativeMessagingHosts keys (per-user, no
    //! elevation) whose default value is the absolute path to a manifest
    //! JSON on disk, plus the HKCU Run key for autostart.
    use super::*;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const NM_KEYS: &[&str] = &[
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\Mozilla\NativeMessagingHosts",
    ];
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    /// Writes the two manifest JSONs next to the binaries (`manifest_dir`)
    /// and points all three browsers' HKCU keys at them.
    pub fn install(manifest_dir: &Path, nm_host_path: &Path) -> io::Result<()> {
        fs::create_dir_all(manifest_dir)?;
        let chromium_path = manifest_dir.join("dev.davidxu.smartblocker.json");
        let firefox_path = manifest_dir.join("dev.davidxu.smartblocker.firefox.json");
        fs::write(
            &chromium_path,
            format!("{:#}\n", chromium_manifest(nm_host_path)),
        )?;
        fs::write(
            &firefox_path,
            format!("{:#}\n", firefox_manifest(nm_host_path)),
        )?;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for key_path in NM_KEYS {
            let manifest = if key_path.contains("Mozilla") {
                &firefox_path
            } else {
                &chromium_path
            };
            let (key, _) = hkcu.create_subkey(format!(r"{key_path}\{NM_HOST_NAME}"))?;
            key.set_value("", &manifest.to_string_lossy().to_string())?;
        }
        Ok(())
    }

    pub fn uninstall() -> io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for key_path in NM_KEYS {
            let _ = hkcu.delete_subkey_all(format!(r"{key_path}\{NM_HOST_NAME}"));
        }
        let _ = hkcu
            .open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE)
            .and_then(|k| k.delete_value("SmartBlockerCompanion"));
        Ok(())
    }

    pub fn install_autostart(companion_exe: &Path) -> io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
        key.set_value(
            "SmartBlockerCompanion",
            &format!("\"{}\"", companion_exe.display()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_writes_all_four_manifests_with_the_right_grant_field() {
        let home = tempfile::tempdir().unwrap();
        let host = Path::new("/opt/smartblocker/smartblocker-nm-host");
        let written = install_linux(home.path(), host).unwrap();
        assert_eq!(written.len(), 4);

        let chrome: serde_json::Value =
            serde_json::from_str(
                &fs::read_to_string(home.path().join(
                    ".config/google-chrome/NativeMessagingHosts/dev.davidxu.smartblocker.json",
                ))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            chrome["allowed_origins"][0],
            format!("chrome-extension://{CHROME_EXTENSION_ID}/")
        );
        assert!(chrome.get("allowed_extensions").is_none());

        let firefox: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                home.path()
                    .join(".mozilla/native-messaging-hosts/dev.davidxu.smartblocker.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(firefox["allowed_extensions"][0], GECKO_EXTENSION_ID);
        assert!(firefox.get("allowed_origins").is_none());

        assert_eq!(uninstall_linux(home.path()).len(), 4);
        assert!(uninstall_linux(home.path()).is_empty());
    }

    #[test]
    fn autostart_entry_roundtrips() {
        let home = tempfile::tempdir().unwrap();
        let path = install_autostart_linux(
            home.path(),
            Path::new("/opt/smartblocker/smartblocker-daemon"),
        )
        .unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("Exec=/opt/smartblocker/smartblocker-daemon run"));
        assert!(uninstall_autostart_linux(home.path()));
        assert!(!uninstall_autostart_linux(home.path()));
    }
}
