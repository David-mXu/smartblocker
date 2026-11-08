//! Running-apps picker source for the "Blocked apps" page: the user's
//! currently running programs as lowercase exe stems (the same identity the
//! enforcer matches the blocklist against), deduped with process counts.
//!
//! Excluded: processes without a readable exe path (kernel threads, other
//! users' / protected processes — nothing the user could meaningfully
//! block), the companion's own binaries (blocking them would be a footgun;
//! the enforcer never kills them anyway), and an OS/desktop-plumbing
//! denylist (killing `explorer`/`dwm`/`systemd` mid-lock would wreck the
//! session, not stop a distraction). Browsers are kept but TAGGED, so the
//! UI can explain they're handled by browser protection instead.
//!
//! Read-only: uses its own `sysinfo::System`, never `SysinfoSource`, so a UI
//! refresh can't disturb the enforcer's recorded-PID immunity set.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::browsers::{classify, BrowserClass};
use crate::enforcer::PROTECTED_STEMS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    /// Lowercase exe stem, no `.exe`.
    pub name: String,
    /// Number of running processes with this stem.
    pub count: u32,
    /// Supported or incompatible browser (closed by browser protection, not
    /// the app blocklist).
    pub is_browser: bool,
}

/// Exact stems of OS / desktop-session plumbing (Windows + Linux).
const SYSTEM_STEMS: &[&str] = &[
    // Windows core + shell
    "system",
    "registry",
    "idle",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
    "lsaiso",
    "svchost",
    "dwm",
    "explorer",
    "fontdrvhost",
    "sihost",
    "ctfmon",
    "taskhostw",
    "taskmgr",
    "runtimebroker",
    "searchhost",
    "searchapp",
    "searchindexer",
    "searchprotocolhost",
    "searchfilterhost",
    "startmenuexperiencehost",
    "shellexperiencehost",
    "shellhost",
    "textinputhost",
    "applicationframehost",
    "systemsettings",
    "systemsettingsbroker",
    "lockapp",
    "logonui",
    "userinit",
    "useroobebroker",
    "backgroundtaskhost",
    "conhost",
    "openconsole",
    "dllhost",
    "rundll32",
    "spoolsv",
    "wmiprvse",
    "wudfhost",
    "audiodg",
    "memcompression",
    "memory compression",
    "secure system",
    "msmpeng",
    "mpdefendercoreservice",
    "nissrv",
    "securityhealthservice",
    "securityhealthsystray",
    "smartscreen",
    "sgrmbroker",
    "msedgewebview2",
    "widgets",
    "widgetservice",
    "phoneexperiencehost",
    "crossdeviceresume",
    "gamebarpresencewriter",
    "wlanext",
    "dashost",
    "unsecapp",
    "vmmem",
    "vmmemwsl",
    "wslhost",
    "wslservice",
    "wsl",
    // Linux core + desktop session
    "systemd",
    "init",
    "kthreadd",
    "kworker",
    "dbus-daemon",
    "dbus-broker",
    "dbus-broker-launch",
    "polkitd",
    "networkmanager",
    "wpa_supplicant",
    "udisksd",
    "upowerd",
    "accounts-daemon",
    "rtkit-daemon",
    "pipewire",
    "pipewire-pulse",
    "wireplumber",
    "pulseaudio",
    "xorg",
    "xwayland",
    "gnome-shell",
    "plasmashell",
    "kwin_x11",
    "kwin_wayland",
    "gdm",
    "sddm",
    "lightdm",
    "agetty",
    "login",
    "sshd",
    "cron",
    "crond",
];

/// Stem prefixes of daemon families (`gvfsd-fuse`, `gsd-power`, `xdg-*`…).
const SYSTEM_PREFIXES: &[&str] = &[
    "systemd-",
    "kworker",
    "ksoftirqd",
    "migration",
    "rcu_",
    "gvfs",
    "gsd-",
    "xdg-",
    "at-spi",
    "evolution-",
    "ibus-",
    "kded",
];

/// One process as the summarizer sees it: (exe stem, has readable exe path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppProc {
    pub stem: String,
    pub has_exe: bool,
}

fn normalize_stem(raw: &str) -> String {
    crate::procwatch::normalize_exe_stem(raw)
}

pub fn is_system_stem(stem: &str) -> bool {
    SYSTEM_STEMS.contains(&stem) || SYSTEM_PREFIXES.iter().any(|p| stem.starts_with(p))
}

/// Pure core: filter, dedupe with counts, tag browsers, sort by name.
pub fn summarize_apps(procs: &[AppProc]) -> Vec<RunningApp> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for p in procs {
        if !p.has_exe {
            continue;
        }
        let stem = normalize_stem(&p.stem);
        if stem.is_empty() || PROTECTED_STEMS.contains(&stem.as_str()) || is_system_stem(&stem) {
            continue;
        }
        *counts.entry(stem).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .map(|(name, count)| RunningApp {
            is_browser: classify(&name, &[]) != BrowserClass::Unrelated,
            name,
            count,
        })
        .collect()
}

/// Snapshot the live process table (exe paths only — no cmdlines).
pub fn list_running_apps() -> Vec<RunningApp> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let procs: Vec<AppProc> = sys
        .processes()
        .values()
        .map(|p| match p.exe().and_then(|path| path.file_stem()) {
            Some(stem) => AppProc {
                stem: stem.to_string_lossy().into_owned(),
                has_exe: true,
            },
            None => AppProc {
                stem: p.name().to_string_lossy().into_owned(),
                has_exe: false,
            },
        })
        .collect();
    summarize_apps(&procs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(stem: &str) -> AppProc {
        AppProc {
            stem: stem.into(),
            has_exe: true,
        }
    }

    #[test]
    fn dedupes_counts_tags_and_sorts() {
        let apps = summarize_apps(&[
            p("Steam"),
            p("steamwebhelper"),
            p("steam"),
            p("msedge"),
            p("msedge"),
            p("Discord.exe"),
            p("brave"),
        ]);
        assert_eq!(
            apps,
            vec![
                RunningApp {
                    name: "brave".into(),
                    count: 1,
                    is_browser: true
                },
                RunningApp {
                    name: "discord".into(),
                    count: 1,
                    is_browser: false
                },
                RunningApp {
                    name: "msedge".into(),
                    count: 2,
                    is_browser: true
                },
                RunningApp {
                    name: "steam".into(),
                    count: 2,
                    is_browser: false
                },
                RunningApp {
                    name: "steamwebhelper".into(),
                    count: 1,
                    is_browser: false
                },
            ]
        );
    }

    #[test]
    fn excludes_system_companion_and_exeless() {
        let apps = summarize_apps(&[
            p("svchost"),
            p("Explorer.EXE"),
            p("dwm"),
            p("systemd"),
            p("systemd-journald"),
            p("kworker/0:1"),
            p("gvfsd-fuse"),
            p("smartblocker-daemon"),
            p("smartblocker-companion"),
            p("smartblocker-nm-host"),
            p("msedgewebview2"),
            p(""),
            AppProc {
                stem: "ghostapp".into(),
                has_exe: false,
            },
            p("spotify"),
        ]);
        assert_eq!(
            apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["spotify"]
        );
    }

    #[test]
    fn decoy_named_like_companion_with_suffix_is_still_listed() {
        // Exact-stem exclusion only: a renamed `smartblocker-steam` is a
        // normal app the user may block.
        let apps = summarize_apps(&[p("smartblocker-steam")]);
        assert_eq!(apps.len(), 1);
    }

    #[test]
    fn json_shape_is_camel_case() {
        let v = serde_json::to_value(RunningApp {
            name: "x".into(),
            count: 1,
            is_browser: true,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "name": "x", "count": 1, "isBrowser": true })
        );
    }

    #[test]
    fn live_listing_never_panics_and_respects_exclusions() {
        let apps = list_running_apps();
        for a in &apps {
            assert!(!a.name.is_empty());
            assert!(!is_system_stem(&a.name), "{}", a.name);
            assert!(!PROTECTED_STEMS.contains(&a.name.as_str()));
            assert!(a.count >= 1);
        }
        let mut sorted = apps.clone();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(apps, sorted);
    }
}
