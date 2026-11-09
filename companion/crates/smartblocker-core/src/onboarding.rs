//! Installed-browser discovery and Native Messaging registration health.
//!
//! Installation, registration and an authenticated extension connection are
//! separate facts. A valid manifest does not prove that an extension is
//! installed or enabled; connection evidence remains in `snapshot::BrowserInfo`.
//! Repairs here therefore register only detected browser installations and
//! never claim to install the extension.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::protocol::{CompanionBrowser, NM_HOST_NAME};
use crate::registration::{chromium_manifest, firefox_manifest};

pub const SUPPORTED_BROWSERS: [CompanionBrowser; 3] = [
    CompanionBrowser::Chrome,
    CompanionBrowser::Edge,
    CompanionBrowser::Firefox,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationStatus {
    Installed,
    /// Detection is positive evidence only. Absence is not proof of removal.
    NotDetected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationStatus {
    Healthy,
    Missing,
    /// Malformed JSON, wrong grants/host, or a missing host executable.
    Invalid,
    /// The OS refused a read, so health cannot be established.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIntegration {
    pub browser: CompanionBrowser,
    pub installation: InstallationStatus,
    pub registration: RegistrationStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepairOutcome {
    Repaired,
    AlreadyHealthy,
    NotDetected,
    SkippedTestMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRepairResult {
    pub browser: CompanionBrowser,
    pub outcome: RepairOutcome,
    /// Re-read after every attempted write; success is never write-only.
    pub registration: RegistrationStatus,
    pub message: String,
}

pub fn browser_name(browser: CompanionBrowser) -> &'static str {
    match browser {
        CompanionBrowser::Chrome => "Chrome",
        CompanionBrowser::Edge => "Edge",
        CompanionBrowser::Firefox => "Firefox",
    }
}

fn repair_result(
    browser: CompanionBrowser,
    outcome: RepairOutcome,
    registration: RegistrationStatus,
) -> BrowserRepairResult {
    let name = browser_name(browser);
    let message = match outcome {
        RepairOutcome::Repaired => format!(
            "{name}'s browser connection was repaired and verified. This did not install the extension; install or enable it if needed, then restart {name}."
        ),
        RepairOutcome::AlreadyHealthy => format!(
            "{name}'s browser connection is already registered. This does not verify that the extension is installed or enabled."
        ),
        RepairOutcome::NotDetected => format!(
            "{name} wasn't detected. No registration was changed, and no extension was installed."
        ),
        RepairOutcome::SkippedTestMode => format!(
            "Test mode: {name}'s registration and startup settings were left alone. No extension was installed."
        ),
    };
    BrowserRepairResult {
        browser,
        outcome,
        registration,
        message,
    }
}

pub fn skipped_test_mode(
    browser: CompanionBrowser,
    registration: RegistrationStatus,
) -> BrowserRepairResult {
    repair_result(browser, RepairOutcome::SkippedTestMode, registration)
}

#[cfg(unix)]
fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(any(windows, test))]
fn windows_manifest_path(manifest_dir: &Path, browser: CompanionBrowser) -> PathBuf {
    manifest_dir.join(match browser {
        CompanionBrowser::Chrome => "dev.davidxu.smartblocker.chrome.json",
        CompanionBrowser::Edge => "dev.davidxu.smartblocker.edge.json",
        CompanionBrowser::Firefox => "dev.davidxu.smartblocker.firefox.json",
    })
}

#[cfg(any(windows, test))]
fn legacy_shared_manifest(manifest_dir: &Path) -> PathBuf {
    manifest_dir.join("dev.davidxu.smartblocker.json")
}

#[cfg(any(windows, test))]
fn windows_manifest_compatible(
    manifest_dir: &Path,
    browser: CompanionBrowser,
    registered: &Path,
) -> bool {
    registered == windows_manifest_path(manifest_dir, browser)
        || (browser != CompanionBrowser::Firefox
            && registered == legacy_shared_manifest(manifest_dir))
}

#[cfg(any(windows, test))]
fn expected_windows_manifest(browser: CompanionBrowser, nm_host: &Path) -> serde_json::Value {
    match browser {
        CompanionBrowser::Firefox => firefox_manifest(nm_host),
        _ => chromium_manifest(nm_host),
    }
}

/// New repairs write only the selected browser's artifact. The old shared
/// Chromium manifest remains readable for compatibility but is never a write
/// target here, so repairing Chrome cannot modify Edge's registration inputs.
#[cfg(any(windows, test))]
fn write_windows_manifest(
    manifest_dir: &Path,
    nm_host: &Path,
    browser: CompanionBrowser,
) -> io::Result<PathBuf> {
    fs::create_dir_all(manifest_dir)?;
    let manifest = windows_manifest_path(manifest_dir, browser);
    fs::write(
        &manifest,
        format!("{:#}\n", expected_windows_manifest(browser, nm_host)),
    )?;
    Ok(manifest)
}

/// Compare the complete manifest so stale host paths and wrong extension
/// grants are repairable, while unrelated read failures remain distinguishable.
fn manifest_health(
    path: &Path,
    expected: &serde_json::Value,
    nm_host: &Path,
) -> RegistrationStatus {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return RegistrationStatus::Missing,
        Err(_) => return RegistrationStatus::Unreadable,
    };
    if !executable_file(nm_host) {
        return RegistrationStatus::Invalid;
    }
    match serde_json::from_slice::<serde_json::Value>(&raw) {
        Ok(actual) if &actual == expected => RegistrationStatus::Healthy,
        Ok(_) | Err(_) => RegistrationStatus::Invalid,
    }
}

fn worst_registration(
    statuses: impl IntoIterator<Item = RegistrationStatus>,
) -> RegistrationStatus {
    let mut result = RegistrationStatus::Healthy;
    for status in statuses {
        result = match (result, status) {
            (RegistrationStatus::Unreadable, _) | (_, RegistrationStatus::Unreadable) => {
                RegistrationStatus::Unreadable
            }
            (RegistrationStatus::Invalid, _) | (_, RegistrationStatus::Invalid) => {
                RegistrationStatus::Invalid
            }
            (RegistrationStatus::Missing, _) | (_, RegistrationStatus::Missing) => {
                RegistrationStatus::Missing
            }
            _ => RegistrationStatus::Healthy,
        };
    }
    result
}

/// Linux discovery uses executable evidence, not profile directories. The old
/// install flow creates those directories even for absent browsers, so using
/// them would manufacture installations after a repair.
pub mod linux {
    use super::*;

    struct Target {
        browser: CompanionBrowser,
        manifest: PathBuf,
        firefox_manifest: bool,
        detected: bool,
    }

    fn executable_detected(search_path: Option<&OsStr>, name: &str) -> bool {
        search_path
            .map(std::env::split_paths)
            .into_iter()
            .flatten()
            .any(|dir| executable_file(dir.join(name).as_path()))
    }

    fn any_executable(search_path: Option<&OsStr>, names: &[&str]) -> bool {
        names
            .iter()
            .any(|name| executable_detected(search_path, name))
    }

    fn targets(home: &Path, search_path: Option<&OsStr>) -> Vec<Target> {
        let file = format!("{NM_HOST_NAME}.json");
        vec![
            Target {
                browser: CompanionBrowser::Chrome,
                manifest: home
                    .join(".config/google-chrome/NativeMessagingHosts")
                    .join(&file),
                firefox_manifest: false,
                detected: any_executable(search_path, &["google-chrome", "google-chrome-stable"]),
            },
            Target {
                browser: CompanionBrowser::Chrome,
                manifest: home
                    .join(".config/chromium/NativeMessagingHosts")
                    .join(&file),
                firefox_manifest: false,
                detected: any_executable(search_path, &["chromium", "chromium-browser"]),
            },
            Target {
                browser: CompanionBrowser::Edge,
                manifest: home
                    .join(".config/microsoft-edge/NativeMessagingHosts")
                    .join(&file),
                firefox_manifest: false,
                detected: any_executable(search_path, &["microsoft-edge", "microsoft-edge-stable"]),
            },
            Target {
                browser: CompanionBrowser::Firefox,
                manifest: home.join(".mozilla/native-messaging-hosts").join(&file),
                firefox_manifest: true,
                detected: any_executable(search_path, &["firefox", "firefox-esr"]),
            },
        ]
    }

    fn expected(target: &Target, nm_host: &Path) -> serde_json::Value {
        if target.firefox_manifest {
            firefox_manifest(nm_host)
        } else {
            chromium_manifest(nm_host)
        }
    }

    fn orphan_requires_inspection(path: &Path) -> bool {
        match fs::metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            // Metadata and traversal failures must reach manifest_health so
            // they become Unreadable, never get downgraded to Missing.
            _ => true,
        }
    }

    pub fn integrations(
        home: &Path,
        search_path: Option<&OsStr>,
        nm_host: &Path,
    ) -> Vec<BrowserIntegration> {
        let targets = targets(home, search_path);
        SUPPORTED_BROWSERS
            .into_iter()
            .map(|browser| {
                let matching: Vec<_> = targets
                    .iter()
                    .filter(|target| target.browser == browser)
                    .collect();
                let installed = matching.iter().any(|target| target.detected);
                // For detected installations every relevant target must be
                // healthy. With no detected executable, report orphaned files
                // if present without turning them into installation evidence.
                let inspected: Vec<_> = matching
                    .iter()
                    .filter(|target| {
                        if installed {
                            target.detected
                        } else {
                            orphan_requires_inspection(&target.manifest)
                        }
                    })
                    .map(|target| {
                        manifest_health(
                            target.manifest.as_path(),
                            &expected(target, nm_host),
                            nm_host,
                        )
                    })
                    .collect();
                let registration = if inspected.is_empty() {
                    RegistrationStatus::Missing
                } else {
                    worst_registration(inspected)
                };
                BrowserIntegration {
                    browser,
                    installation: if installed {
                        InstallationStatus::Installed
                    } else {
                        InstallationStatus::NotDetected
                    },
                    registration,
                }
            })
            .collect()
    }

    pub fn repair(
        home: &Path,
        search_path: Option<&OsStr>,
        nm_host: &Path,
        browser: CompanionBrowser,
    ) -> io::Result<BrowserRepairResult> {
        if !nm_host.is_absolute() || !executable_file(nm_host) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the Native Messaging host must be an executable file at an absolute path",
            ));
        }
        let targets = targets(home, search_path);
        let selected: Vec<_> = targets
            .iter()
            .filter(|target| target.browser == browser && target.detected)
            .collect();
        if selected.is_empty() {
            let current = integrations(home, search_path, nm_host)
                .into_iter()
                .find(|integration| integration.browser == browser)
                .map(|integration| integration.registration)
                .unwrap_or(RegistrationStatus::Missing);
            return Ok(repair_result(browser, RepairOutcome::NotDetected, current));
        }

        let healthy = selected.iter().all(|target| {
            manifest_health(&target.manifest, &expected(target, nm_host), nm_host)
                == RegistrationStatus::Healthy
        });
        if healthy {
            return Ok(repair_result(
                browser,
                RepairOutcome::AlreadyHealthy,
                RegistrationStatus::Healthy,
            ));
        }

        for target in &selected {
            if let Some(parent) = target.manifest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(
                &target.manifest,
                format!("{:#}\n", expected(target, nm_host)),
            )?;
        }
        // Do not convert a successful write syscall into a success claim until
        // the exact manifest and host have been read back.
        let verified = selected.iter().all(|target| {
            manifest_health(&target.manifest, &expected(target, nm_host), nm_host)
                == RegistrationStatus::Healthy
        });
        if !verified {
            return Err(io::Error::other(
                "browser registration could not be verified after writing",
            ));
        }
        Ok(repair_result(
            browser,
            RepairOutcome::Repaired,
            RegistrationStatus::Healthy,
        ))
    }
}

#[cfg(windows)]
pub mod windows {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    fn registry_manifest_key(browser: CompanionBrowser) -> &'static str {
        match browser {
            CompanionBrowser::Chrome => {
                r"Software\Google\Chrome\NativeMessagingHosts\dev.davidxu.smartblocker"
            }
            CompanionBrowser::Edge => {
                r"Software\Microsoft\Edge\NativeMessagingHosts\dev.davidxu.smartblocker"
            }
            CompanionBrowser::Firefox => {
                r"Software\Mozilla\NativeMessagingHosts\dev.davidxu.smartblocker"
            }
        }
    }

    fn installed_app_path(executable: &str) -> bool {
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
            .into_iter()
            .any(|root| {
                RegKey::predef(root)
                    .open_subkey(format!(
                        r"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
                    ))
                    .ok()
                    .and_then(|key| key.get_value::<String, _>("").ok())
                    .is_some_and(|path| Path::new(&path).is_file())
            })
    }

    fn known_install(executable: &str, relative: &str) -> bool {
        ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .any(|root| root.join(relative).join(executable).is_file())
    }

    fn installed(browser: CompanionBrowser) -> bool {
        match browser {
            CompanionBrowser::Chrome => {
                installed_app_path("chrome.exe")
                    || known_install("chrome.exe", r"Google\Chrome\Application")
            }
            CompanionBrowser::Edge => {
                installed_app_path("msedge.exe")
                    || known_install("msedge.exe", r"Microsoft\Edge\Application")
            }
            CompanionBrowser::Firefox => {
                installed_app_path("firefox.exe")
                    || known_install("firefox.exe", r"Mozilla Firefox")
            }
        }
    }

    fn health(
        manifest_dir: &Path,
        nm_host: &Path,
        browser: CompanionBrowser,
    ) -> RegistrationStatus {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let registered = hkcu
            .open_subkey(registry_manifest_key(browser))
            .and_then(|key| key.get_value::<String, _>(""));
        let registered = match registered {
            Ok(value) => PathBuf::from(value),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return RegistrationStatus::Missing,
            Err(_) => return RegistrationStatus::Unreadable,
        };
        // Preserve valid registrations made by the former shared Chromium
        // installer, but selected repairs never rewrite that shared artifact.
        if !windows_manifest_compatible(manifest_dir, browser, &registered) {
            return RegistrationStatus::Invalid;
        }
        manifest_health(
            &registered,
            &expected_windows_manifest(browser, nm_host),
            nm_host,
        )
    }

    pub fn integrations(manifest_dir: &Path, nm_host: &Path) -> Vec<BrowserIntegration> {
        SUPPORTED_BROWSERS
            .into_iter()
            .map(|browser| BrowserIntegration {
                browser,
                installation: if installed(browser) {
                    InstallationStatus::Installed
                } else {
                    InstallationStatus::NotDetected
                },
                registration: health(manifest_dir, nm_host, browser),
            })
            .collect()
    }

    pub fn repair(
        manifest_dir: &Path,
        nm_host: &Path,
        browser: CompanionBrowser,
    ) -> io::Result<BrowserRepairResult> {
        if !nm_host.is_absolute() || !executable_file(nm_host) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the Native Messaging host must be an executable file at an absolute path",
            ));
        }
        if !installed(browser) {
            return Ok(repair_result(
                browser,
                RepairOutcome::NotDetected,
                health(manifest_dir, nm_host, browser),
            ));
        }
        if health(manifest_dir, nm_host, browser) == RegistrationStatus::Healthy {
            return Ok(repair_result(
                browser,
                RepairOutcome::AlreadyHealthy,
                RegistrationStatus::Healthy,
            ));
        }

        let manifest = write_windows_manifest(manifest_dir, nm_host, browser)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(registry_manifest_key(browser))?;
        key.set_value("", &manifest.to_string_lossy().to_string())?;
        if health(manifest_dir, nm_host, browser) != RegistrationStatus::Healthy {
            return Err(io::Error::other(
                "browser registration could not be verified after writing",
            ));
        }
        Ok(repair_result(
            browser,
            RepairOutcome::Repaired,
            RegistrationStatus::Healthy,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn write_executable(path: impl AsRef<Path>, contents: &[u8]) {
        let path = path.as_ref();
        fs::write(path, contents).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, OsString) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        let host = dir.path().join("smartblocker-nm-host");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        write_executable(&host, b"test host");
        let path = std::env::join_paths([bin.clone()]).unwrap();
        (dir, home, host, path)
    }

    fn integration(all: &[BrowserIntegration], browser: CompanionBrowser) -> &BrowserIntegration {
        all.iter().find(|entry| entry.browser == browser).unwrap()
    }

    #[test]
    fn test_mode_repair_is_explicitly_skipped_without_claiming_success() {
        let result = skipped_test_mode(CompanionBrowser::Firefox, RegistrationStatus::Invalid);
        assert_eq!(result.outcome, RepairOutcome::SkippedTestMode);
        assert_eq!(result.registration, RegistrationStatus::Invalid);
        assert!(result.message.contains("left alone"));
        assert!(result.message.contains("No extension was installed"));
        assert!(!result.message.contains("repaired and verified"));
    }

    #[test]
    fn profile_directories_are_not_browser_installation_evidence() {
        let (_dir, home, host, path) = fixture();
        fs::create_dir_all(home.join(".config/google-chrome/NativeMessagingHosts")).unwrap();
        fs::create_dir_all(home.join(".mozilla/native-messaging-hosts")).unwrap();
        let all = linux::integrations(&home, Some(&path), &host);
        assert!(all.iter().all(|entry| {
            entry.installation == InstallationStatus::NotDetected
                && entry.registration == RegistrationStatus::Missing
        }));
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_lookalikes_do_not_trigger_repairs() {
        let (dir, home, host, path) = fixture();
        fs::write(dir.path().join("bin/google-chrome"), b"not executable").unwrap();
        let all = linux::integrations(&home, Some(&path), &host);
        assert_eq!(
            integration(&all, CompanionBrowser::Chrome).installation,
            InstallationStatus::NotDetected
        );
        assert_eq!(
            integration(&all, CompanionBrowser::Chrome).registration,
            RegistrationStatus::Missing
        );
        let result = linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(result.outcome, RepairOutcome::NotDetected);
        assert!(!home.join(".config").exists());
    }

    #[cfg(unix)]
    #[test]
    fn orphan_metadata_errors_are_unreadable_not_missing() {
        let (_dir, home, host, path) = fixture();
        // A regular file where a parent directory must be produces a stable
        // NotADirectory metadata/read error without depending on test UID.
        fs::write(home.join(".config"), b"not a directory").unwrap();
        let all = linux::integrations(&home, Some(&path), &host);
        assert_eq!(
            integration(&all, CompanionBrowser::Chrome).installation,
            InstallationStatus::NotDetected
        );
        assert_eq!(
            integration(&all, CompanionBrowser::Chrome).registration,
            RegistrationStatus::Unreadable
        );
    }

    #[test]
    fn selected_repair_writes_only_detected_targets_and_rereads_them() {
        let (dir, home, host, path) = fixture();
        let bin = dir.path().join("bin");
        write_executable(bin.join("google-chrome"), b"fake executable");
        write_executable(bin.join("firefox"), b"fake executable");

        let result = linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(result.outcome, RepairOutcome::Repaired);
        assert_eq!(result.registration, RegistrationStatus::Healthy);
        assert!(result.message.contains("did not install the extension"));
        assert!(home
            .join(".config/google-chrome/NativeMessagingHosts/dev.davidxu.smartblocker.json")
            .is_file());
        assert!(!home.join(".config/chromium").exists());
        assert!(!home.join(".config/microsoft-edge").exists());
        assert!(!home.join(".mozilla").exists());

        let all = linux::integrations(&home, Some(&path), &host);
        assert_eq!(
            integration(&all, CompanionBrowser::Chrome).registration,
            RegistrationStatus::Healthy
        );
        assert_eq!(
            integration(&all, CompanionBrowser::Firefox).installation,
            InstallationStatus::Installed
        );
        assert_eq!(
            integration(&all, CompanionBrowser::Firefox).registration,
            RegistrationStatus::Missing
        );

        let again = linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(again.outcome, RepairOutcome::AlreadyHealthy);
    }

    #[test]
    fn repairing_an_undetected_browser_is_an_explicit_noop() {
        let (_dir, home, host, path) = fixture();
        let result = linux::repair(&home, Some(&path), &host, CompanionBrowser::Edge).unwrap();
        assert_eq!(result.outcome, RepairOutcome::NotDetected);
        assert_eq!(result.registration, RegistrationStatus::Missing);
        assert!(result.message.contains("No registration was changed"));
        assert!(!home.join(".config").exists());
    }

    #[test]
    fn wrong_host_grant_and_malformed_manifests_need_repair() {
        let (dir, home, host, path) = fixture();
        write_executable(dir.path().join("bin/microsoft-edge"), b"fake executable");
        let manifest =
            home.join(".config/microsoft-edge/NativeMessagingHosts/dev.davidxu.smartblocker.json");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(&manifest, b"{ not json").unwrap();
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Edge
            )
            .registration,
            RegistrationStatus::Invalid
        );

        let mut wrong = chromium_manifest(&host);
        wrong["path"] = serde_json::Value::String("/old/nm-host".into());
        wrong["allowed_origins"] = serde_json::json!(["chrome-extension://wrong/"]);
        fs::write(&manifest, serde_json::to_vec(&wrong).unwrap()).unwrap();
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Edge
            )
            .registration,
            RegistrationStatus::Invalid
        );
        linux::repair(&home, Some(&path), &host, CompanionBrowser::Edge).unwrap();
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Edge
            )
            .registration,
            RegistrationStatus::Healthy
        );
    }

    #[test]
    fn undetected_sibling_manifest_does_not_block_chrome_health() {
        let (dir, home, host, path) = fixture();
        write_executable(dir.path().join("bin/google-chrome"), b"fake executable");
        let orphaned =
            home.join(".config/chromium/NativeMessagingHosts/dev.davidxu.smartblocker.json");
        fs::create_dir_all(orphaned.parent().unwrap()).unwrap();
        fs::write(&orphaned, b"stale sibling registration").unwrap();

        let before = linux::integrations(&home, Some(&path), &host);
        assert_eq!(
            integration(&before, CompanionBrowser::Chrome).registration,
            RegistrationStatus::Missing
        );
        let result = linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(result.outcome, RepairOutcome::Repaired);
        assert_eq!(fs::read(&orphaned).unwrap(), b"stale sibling registration");
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Chrome
            )
            .registration,
            RegistrationStatus::Healthy
        );
    }

    #[test]
    fn chrome_and_chromium_targets_are_both_repaired_only_when_both_exist() {
        let (dir, home, host, path) = fixture();
        let bin = dir.path().join("bin");
        write_executable(bin.join("google-chrome-stable"), b"fake executable");
        write_executable(bin.join("chromium"), b"fake executable");
        let result = linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(result.outcome, RepairOutcome::Repaired);
        for base in [".config/google-chrome", ".config/chromium"] {
            assert!(home
                .join(base)
                .join("NativeMessagingHosts/dev.davidxu.smartblocker.json")
                .is_file());
        }
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Chrome
            )
            .registration,
            RegistrationStatus::Healthy
        );
    }

    #[test]
    fn windows_selected_write_preserves_sibling_artifacts_and_health_inputs() {
        let (dir, _home, host, _path) = fixture();
        let manifest_dir = dir.path().join("manifests");
        fs::create_dir_all(&manifest_dir).unwrap();
        let legacy = legacy_shared_manifest(&manifest_dir);
        let edge = windows_manifest_path(&manifest_dir, CompanionBrowser::Edge);
        fs::write(&legacy, b"legacy shared registration").unwrap();
        fs::write(&edge, b"edge-specific registration").unwrap();
        let edge_expected = expected_windows_manifest(CompanionBrowser::Edge, &host);
        let edge_health_before = manifest_health(&legacy, &edge_expected, &host);

        let chrome =
            write_windows_manifest(&manifest_dir, &host, CompanionBrowser::Chrome).unwrap();
        assert_eq!(
            chrome,
            windows_manifest_path(&manifest_dir, CompanionBrowser::Chrome)
        );
        assert_ne!(chrome, edge);
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy shared registration");
        assert_eq!(fs::read(&edge).unwrap(), b"edge-specific registration");
        assert_eq!(
            manifest_health(&legacy, &edge_expected, &host),
            edge_health_before
        );
        assert!(windows_manifest_compatible(
            &manifest_dir,
            CompanionBrowser::Chrome,
            &legacy
        ));
        assert!(windows_manifest_compatible(
            &manifest_dir,
            CompanionBrowser::Edge,
            &legacy
        ));
        assert!(!windows_manifest_compatible(
            &manifest_dir,
            CompanionBrowser::Firefox,
            &legacy
        ));
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_host_makes_an_otherwise_valid_manifest_unhealthy() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, home, host, path) = fixture();
        write_executable(dir.path().join("bin/google-chrome"), b"fake executable");
        linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).unwrap();
        let mut permissions = fs::metadata(&host).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&host, permissions).unwrap();
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &host),
                CompanionBrowser::Chrome
            )
            .registration,
            RegistrationStatus::Invalid
        );
        assert!(linux::repair(&home, Some(&path), &host, CompanionBrowser::Chrome).is_err());
    }

    #[test]
    fn missing_host_binary_makes_an_otherwise_valid_manifest_unhealthy() {
        let (dir, home, host, path) = fixture();
        write_executable(dir.path().join("bin/firefox-esr"), b"fake executable");
        linux::repair(&home, Some(&path), &host, CompanionBrowser::Firefox).unwrap();
        fs::remove_file(host).unwrap();
        assert_eq!(
            integration(
                &linux::integrations(&home, Some(&path), &dir.path().join("missing-host")),
                CompanionBrowser::Firefox
            )
            .registration,
            RegistrationStatus::Invalid
        );
    }
}
