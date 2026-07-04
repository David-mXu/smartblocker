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
pub const GECKO_EXTENSION_ID: &str = "flowguard-poc@davidxu.dev";

/// Chromium-family manifest (Chrome/Chromium/Edge): `allowed_origins`.
pub fn chromium_manifest(nm_host_path: &Path) -> serde_json::Value {
    json!({
        "name": NM_HOST_NAME,
        "description": "FlowGuard desktop companion bridge",
        "path": nm_host_path,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{CHROME_EXTENSION_ID}/")],
    })
}

/// Firefox uses `allowed_extensions` (gecko IDs) instead of origins.
pub fn firefox_manifest(nm_host_path: &Path) -> serde_json::Value {
    json!({
        "name": NM_HOST_NAME,
        "description": "FlowGuard desktop companion bridge",
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
    let path = dir.join("flowguard-companion.desktop");
    fs::write(
        &path,
        format!(
            "[Desktop Entry]\nType=Application\nName=FlowGuard Companion\nExec={} run\nX-GNOME-Autostart-enabled=true\n",
            daemon_path.display()
        ),
    )?;
    Ok(path)
}

pub fn uninstall_autostart_linux(home: &Path) -> bool {
    fs::remove_file(home.join(".config/autostart/flowguard-companion.desktop")).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_writes_all_four_manifests_with_the_right_grant_field() {
        let home = tempfile::tempdir().unwrap();
        let host = Path::new("/opt/flowguard/flowguard-nm-host");
        let written = install_linux(home.path(), host).unwrap();
        assert_eq!(written.len(), 4);

        let chrome: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                home.path()
                    .join(".config/google-chrome/NativeMessagingHosts/dev.davidxu.flowguard.json"),
            )
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
                    .join(".mozilla/native-messaging-hosts/dev.davidxu.flowguard.json"),
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
        let path =
            install_autostart_linux(home.path(), Path::new("/opt/flowguard/flowguard-daemon"))
                .unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("Exec=/opt/flowguard/flowguard-daemon run"));
        assert!(uninstall_autostart_linux(home.path()));
        assert!(!uninstall_autostart_linux(home.path()));
    }
}
