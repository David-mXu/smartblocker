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
//! Sorted by how present each app is on the desktop ([`AppState`]), then by
//! name, so what the user is looking at comes first and the long tail of
//! helpers comes last. Windows-only signal: elsewhere everything reads as
//! background.
//!
//! Read-only: uses its own `sysinfo::System`, never `SysinfoSource`, so a UI
//! refresh can't disturb the enforcer's recorded-PID immunity set.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::browsers::{classify, BrowserClass};
use crate::enforcer::PROTECTED_STEMS;

/// Bound shared with `src/shared/apps.ts` and the profile snapshot schema.
pub const MAX_APP_BLOCKLIST: usize = 100;

/// `"C:\Program Files\Steam\Steam.exe"` → `Some("steam")`.
///
/// Mirrors `normalizeAppName` in `src/shared/apps.ts`: one lowercase exe
/// stem, 1–64 ASCII alphanumerics/space/`._+-`, first character alphanumeric.
pub fn normalize_app_stem(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_matches(|c| c == '"' || c == '\'');
    let base = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
    let mut stem = base.trim().to_lowercase();
    if let Some(stripped) = stem.strip_suffix(".exe") {
        stem = stripped.trim().to_string();
    }
    let mut chars = stem.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() || stem.len() > 64 {
        return None;
    }
    if !stem
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '+' | '-'))
    {
        return None;
    }
    Some(stem)
}

/// Sanitize an untrusted wire/UI list: normalize, dedupe, and bound it.
pub fn normalize_app_blocklist(apps: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for app in apps {
        let Some(stem) = normalize_app_stem(app) else {
            continue;
        };
        if out.iter().any(|entry: &String| entry == &stem) {
            continue;
        }
        out.push(stem);
        if out.len() >= MAX_APP_BLOCKLIST {
            break;
        }
    }
    out
}

pub fn app_blocklist_equal(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(left, right)| left == right)
}

/// While locked, removals wait: keep every current entry in place, then learn
/// additions. Mirrors the daemon's config-tamper rule for `appBlocklist`.
pub fn merge_locked_app_blocklist(current: &[String], incoming: &[String]) -> Vec<String> {
    let mut out = normalize_app_blocklist(current);
    for app in normalize_app_blocklist(incoming) {
        if !out.iter().any(|entry| entry.eq_ignore_ascii_case(&app)) {
            out.push(app);
        }
    }
    out.truncate(MAX_APP_BLOCKLIST);
    out
}

/// How present an app is on the desktop. Declared in display order, so the
/// derived `Ord` makes the most present state the smallest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppState {
    /// Has a taskbar-style window showing on the current desktop.
    Visible,
    /// Has a taskbar-style window, but minimized or on another virtual desktop.
    Open,
    /// No taskbar-style window (helpers, services, apps closed to the tray).
    Background,
}

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
    /// The most present state across this app's processes.
    pub state: AppState,
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

/// One process as the summarizer sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppProc {
    pub stem: String,
    pub has_exe: bool,
    pub state: AppState,
}

/// What the OS reports about one top-level window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowFacts {
    pub shown: bool,
    pub titled: bool,
    /// Passes the taskbar test: not owned, tool or no-activate, unless the
    /// window explicitly asks for a taskbar button.
    pub on_taskbar: bool,
    pub minimized: bool,
    /// `DWMWA_CLOAKED` value (0 = not cloaked).
    pub cloaked: u32,
}

/// `DWM_CLOAKED_APP`: the app hid this window itself, so it isn't "open".
const CLOAKED_BY_APP: u32 = 1;

/// The state one window implies, or `None` if it isn't a window a user would
/// recognize as an open app (most top-level windows are invisible plumbing).
pub fn window_state(w: &WindowFacts) -> Option<AppState> {
    if !w.shown || !w.titled || !w.on_taskbar || w.cloaked == CLOAKED_BY_APP {
        return None;
    }
    if w.minimized || w.cloaked != 0 {
        Some(AppState::Open)
    } else {
        Some(AppState::Visible)
    }
}

fn normalize_stem(raw: &str) -> String {
    crate::procwatch::normalize_exe_stem(raw)
}

pub fn is_system_stem(stem: &str) -> bool {
    SYSTEM_STEMS.contains(&stem) || SYSTEM_PREFIXES.iter().any(|p| stem.starts_with(p))
}

/// Pure core: filter, dedupe with counts, tag browsers, sort by state then
/// name.
pub fn summarize_apps(procs: &[AppProc]) -> Vec<RunningApp> {
    let mut seen: BTreeMap<String, (u32, AppState)> = BTreeMap::new();
    for p in procs {
        if !p.has_exe {
            continue;
        }
        let stem = normalize_stem(&p.stem);
        if stem.is_empty() || PROTECTED_STEMS.contains(&stem.as_str()) || is_system_stem(&stem) {
            continue;
        }
        let entry = seen.entry(stem).or_insert((0, AppState::Background));
        entry.0 += 1;
        entry.1 = entry.1.min(p.state);
    }
    let mut apps: Vec<RunningApp> = seen
        .into_iter()
        .map(|(name, (count, state))| RunningApp {
            is_browser: classify(&name, &[]) != BrowserClass::Unrelated,
            name,
            count,
            state,
        })
        .collect();
    // Stable, so each state keeps the map's name order.
    apps.sort_by_key(|a| a.state);
    apps
}

#[cfg(windows)]
mod win {
    //! Top-level window survey. Callbacks must not panic: unwinding across
    //! `extern "system"` aborts the process.

    use std::collections::HashMap;

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindow, GetWindowLongW,
        GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
        GW_OWNER, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    use super::{window_state, AppState, WindowFacts};

    /// UWP apps draw inside a frame owned by ApplicationFrameHost; the app's
    /// own process only appears as a child of this window class.
    const UWP_FRAME_CLASS: &str = "ApplicationFrameWindow";

    fn merge(states: &mut HashMap<u32, AppState>, pid: u32, state: AppState) {
        let slot = states.entry(pid).or_insert(state);
        *slot = (*slot).min(state);
    }

    unsafe fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        pid
    }

    unsafe fn is_uwp_frame(hwnd: HWND) -> bool {
        let mut buf = [0u16; 64];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        len > 0 && String::from_utf16_lossy(&buf[..len as usize]) == UWP_FRAME_CLASS
    }

    unsafe fn facts(hwnd: HWND) -> WindowFacts {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let owned = !GetWindow(hwnd, GW_OWNER).is_null();
        let hidden_from_taskbar = owned || ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) != 0;
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        );
        WindowFacts {
            shown: IsWindowVisible(hwnd) != 0,
            titled: GetWindowTextLengthW(hwnd) > 0,
            on_taskbar: !hidden_from_taskbar || ex & WS_EX_APPWINDOW != 0,
            minimized: IsIconic(hwnd) != 0,
            cloaked: if hr == 0 { cloaked } else { 0 },
        }
    }

    unsafe extern "system" fn collect_child_pid(child: HWND, lparam: LPARAM) -> BOOL {
        let pids = &mut *(lparam as *mut Vec<u32>);
        pids.push(window_pid(child));
        1
    }

    unsafe extern "system" fn visit_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let states = &mut *(lparam as *mut HashMap<u32, AppState>);
        if let Some(state) = window_state(&facts(hwnd)) {
            let pid = window_pid(hwnd);
            merge(states, pid, state);
            if is_uwp_frame(hwnd) {
                let mut children: Vec<u32> = Vec::new();
                EnumChildWindows(
                    hwnd,
                    Some(collect_child_pid),
                    &mut children as *mut Vec<u32> as LPARAM,
                );
                for child in children.into_iter().filter(|c| *c != pid) {
                    merge(states, child, state);
                }
            }
        }
        1
    }

    pub fn window_states() -> HashMap<u32, AppState> {
        let mut states: HashMap<u32, AppState> = HashMap::new();
        // SAFETY: `states` outlives the synchronous enumeration, and the
        // callback is the only user of the pointer while it runs.
        unsafe {
            EnumWindows(
                Some(visit_window),
                &mut states as *mut HashMap<u32, AppState> as LPARAM,
            );
        }
        states
    }
}

#[cfg(windows)]
use win::window_states;

/// No window signal off Windows (the companion UI is Windows-only).
#[cfg(not(windows))]
fn window_states() -> std::collections::HashMap<u32, AppState> {
    Default::default()
}

/// Snapshot the live process table (exe paths only — no cmdlines).
pub fn list_running_apps() -> Vec<RunningApp> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let windows = window_states();
    let procs: Vec<AppProc> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            let state = windows
                .get(&pid.as_u32())
                .copied()
                .unwrap_or(AppState::Background);
            match p.exe().and_then(|path| path.file_stem()) {
                Some(stem) => AppProc {
                    stem: stem.to_string_lossy().into_owned(),
                    has_exe: true,
                    state,
                },
                None => AppProc {
                    stem: p.name().to_string_lossy().into_owned(),
                    has_exe: false,
                    state,
                },
            }
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
            state: AppState::Background,
        }
    }

    fn with_state(stem: &str, state: AppState) -> AppProc {
        AppProc { state, ..p(stem) }
    }

    fn window() -> WindowFacts {
        WindowFacts {
            shown: true,
            titled: true,
            on_taskbar: true,
            minimized: false,
            cloaked: 0,
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
                    is_browser: true,
                    state: AppState::Background,
                },
                RunningApp {
                    name: "discord".into(),
                    count: 1,
                    is_browser: false,
                    state: AppState::Background,
                },
                RunningApp {
                    name: "msedge".into(),
                    count: 2,
                    is_browser: true,
                    state: AppState::Background,
                },
                RunningApp {
                    name: "steam".into(),
                    count: 2,
                    is_browser: false,
                    state: AppState::Background,
                },
                RunningApp {
                    name: "steamwebhelper".into(),
                    count: 1,
                    is_browser: false,
                    state: AppState::Background,
                },
            ]
        );
    }

    #[test]
    fn sorts_visible_then_open_then_background_and_by_name_within() {
        let apps = summarize_apps(&[
            p("anki"),
            with_state("zoom", AppState::Visible),
            with_state("slack", AppState::Open),
            with_state("code", AppState::Visible),
            with_state("notion", AppState::Open),
            p("spotify"),
        ]);
        assert_eq!(
            apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["code", "zoom", "notion", "slack", "anki", "spotify"]
        );
    }

    #[test]
    fn most_present_process_decides_regardless_of_order() {
        for procs in [
            [
                p("code"),
                with_state("code", AppState::Visible),
                with_state("code", AppState::Open),
            ],
            [
                with_state("code", AppState::Open),
                with_state("code", AppState::Visible),
                p("code"),
            ],
        ] {
            let apps = summarize_apps(&procs);
            assert_eq!(apps.len(), 1);
            assert_eq!(apps[0].count, 3);
            assert_eq!(apps[0].state, AppState::Visible);
        }
    }

    #[test]
    fn window_states_follow_what_the_user_can_see() {
        assert_eq!(window_state(&window()), Some(AppState::Visible));
        let minimized = WindowFacts {
            minimized: true,
            ..window()
        };
        assert_eq!(window_state(&minimized), Some(AppState::Open));
        // DWM_CLOAKED_SHELL: parked on another virtual desktop.
        let other_desktop = WindowFacts {
            cloaked: 2,
            ..window()
        };
        assert_eq!(window_state(&other_desktop), Some(AppState::Open));
    }

    #[test]
    fn plumbing_windows_do_not_count_as_open() {
        for w in [
            WindowFacts {
                shown: false,
                ..window()
            },
            WindowFacts {
                titled: false,
                ..window()
            },
            WindowFacts {
                on_taskbar: false,
                ..window()
            },
            WindowFacts {
                cloaked: 1,
                ..window()
            },
        ] {
            assert_eq!(window_state(&w), None, "{w:?}");
        }
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
                state: AppState::Background,
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
    fn app_blocklist_normalization_matches_the_extension_contract() {
        assert_eq!(
            normalize_app_stem(r#""C:\Program Files\Steam\Steam.exe""#),
            Some("steam".into())
        );
        assert_eq!(normalize_app_stem("  Discord.EXE "), Some("discord".into()));
        assert_eq!(normalize_app_stem("vs code"), Some("vs code".into()));
        assert_eq!(normalize_app_stem("!!!"), None);
        assert_eq!(normalize_app_stem(".hidden"), None);
        assert_eq!(normalize_app_stem(""), None);

        let list = vec![
            "Steam.exe".to_string(),
            r"C:\Games\steam.exe".to_string(),
            "Discord".to_string(),
            "!!!".to_string(),
        ];
        assert_eq!(
            normalize_app_blocklist(&list),
            vec!["steam".to_string(), "discord".to_string()]
        );
    }

    #[test]
    fn locked_app_blocklist_keeps_current_and_learns_additions() {
        let current = vec!["steam".to_string(), "discord".to_string()];
        let incoming = vec!["discord".to_string(), "notion".to_string()];
        assert_eq!(
            merge_locked_app_blocklist(&current, &incoming),
            vec![
                "steam".to_string(),
                "discord".to_string(),
                "notion".to_string()
            ]
        );
        // An empty incoming list cannot remove anything while locked.
        assert_eq!(
            merge_locked_app_blocklist(&current, &[]),
            vec!["steam".to_string(), "discord".to_string()]
        );
    }

    #[test]
    fn json_shape_is_camel_case() {
        let v = serde_json::to_value(RunningApp {
            name: "x".into(),
            count: 1,
            is_browser: true,
            state: AppState::Open,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "name": "x", "count": 1, "isBrowser": true, "state": "open" })
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
        sorted.sort_by(|a, b| a.state.cmp(&b.state).then_with(|| a.name.cmp(&b.name)));
        assert_eq!(apps, sorted);
    }
}
