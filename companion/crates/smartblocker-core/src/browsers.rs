//! Browser process classification. The watchdog only reasons about exe
//! stems (lowercased, extension stripped) — see `procwatch` for why names
//! come from `exe()` rather than the truncated `name()` on Linux.

use crate::protocol::CompanionBrowser;

/// Exe stems of browsers the extension ships for. Chromium variants count as
/// Chrome: an extension in any Chromium-family profile reports `browser:
/// "chrome"` in its hello (Edge is distinguished by UA and listed apart).
const CHROME_STEMS: &[&str] = &[
    "chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "headless_shell",
];
const EDGE_STEMS: &[&str] = &["msedge", "microsoft-edge"];
const FIREFOX_STEMS: &[&str] = &["firefox", "firefox-esr", "firefox-bin"];

/// Browsers SmartBlocker has no extension for: during a forced block they are
/// an open bypass, so the enforcer closes them and reports "incompatible".
const INCOMPATIBLE_STEMS: &[&str] = &[
    "brave",
    "opera",
    "opera_gx",
    "vivaldi",
    "arc",
    "librewolf",
    "waterfox",
    "epiphany",
    "midori",
    "falkon",
    "zen",
    "floorp",
    "thorium",
    "mullvadbrowser",
    "palemoon",
    "seamonkey",
    "whale",
    "maxthon",
    "slimjet",
    "mercury",
    "ungoogled-chromium",
    "iceraven",
    "tor",
    "min",
    "qutebrowser",
    "nyxt",
    "dillo",
    "netsurf",
    "lynx",
    "w3m",
    "links",
    "elinks",
];

/// Command-line flags that defeat extension-based blocking: private windows
/// never load content extensions (and private/guest profiles may not carry
/// our extension at all), `--disable-extensions` kills it outright, and
/// `--load-extension` side-loads arbitrary code into the profile.
const BYPASS_FLAG_PREFIXES: &[&str] = &[
    "--incognito",
    "--inprivate",
    "--guest",
    "-private",
    "-private-window",
    "--disable-extensions",
    "--load-extension",
];

/// Unmistakable Chromium/Gecko child-process arguments. A browser renamed to
/// dodge the stem lists still drags these along because the engine spawns
/// its own child processes with fixed flags.
const ENGINE_FLAG_PREFIXES: &[&str] = &[
    "--type=renderer",
    "--type=gpu-process",
    "--utility-sub-type=network.mojom.networkservice",
    "-contentproc",
    "--tab-process",
];

/// Electron/WebView hosts whose processes legitimately carry Chromium child
/// flags: they are desktop apps, not browsers the extension could live in.
const NON_BROWSER_HOSTS: &[&str] = &[
    "code",
    "cursor",
    "windsurf",
    "electron",
    "slack",
    "discord",
    "spotify",
    "obsidian",
    "notion",
    "teams",
    "msedgewebview2",
    "steamwebhelper",
];

/// Command-line fragments that mark an Electron/WebView host even when its
/// exe stem is renamed (an unpacked Electron app's main bundle, Electron's
/// run-as-node switch, WebView2's host-exe marker).
const NON_BROWSER_CMD_MARKERS: &[&str] = &[
    "app.asar",
    "--ms-enable-electron-run-as-node",
    "--webview-exe-name",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserClass {
    Supported(CompanionBrowser),
    Incompatible,
    Unrelated,
}

/// `extra_incompatible` comes from `CompanionConfig` — the e2e nominates a
/// fake browser binary through it.
pub fn classify(name: &str, extra_incompatible: &[String]) -> BrowserClass {
    if CHROME_STEMS.contains(&name) {
        return BrowserClass::Supported(CompanionBrowser::Chrome);
    }
    if EDGE_STEMS.contains(&name) {
        return BrowserClass::Supported(CompanionBrowser::Edge);
    }
    if FIREFOX_STEMS.contains(&name) {
        return BrowserClass::Supported(CompanionBrowser::Firefox);
    }
    if INCOMPATIBLE_STEMS.contains(&name)
        || extra_incompatible
            .iter()
            .any(|e| e.eq_ignore_ascii_case(name))
    {
        return BrowserClass::Incompatible;
    }
    BrowserClass::Unrelated
}

/// Case-insensitive prefix match without allocation.
fn starts_with_ci(arg: &str, prefix: &str) -> bool {
    arg.len() >= prefix.len()
        && arg.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Case-insensitive substring match without allocation.
fn contains_ci(haystack: &str, needle: &str) -> bool {
    needle.is_empty()
        || haystack
            .as_bytes()
            .windows(needle.len())
            .any(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// True when the command line carries a blocking bypass flag: Chrome with
/// `--incognito`, Edge with `--inprivate`, any private/guest profile, or a
/// bare `--disable-extensions` launch. All of these strip the extension, so
/// a "supported" browser started this way is functionally an incompatible
/// one for the duration of the lock.
pub fn has_bypass_flags(cmd: &[String]) -> bool {
    cmd.iter().any(|arg| {
        BYPASS_FLAG_PREFIXES
            .iter()
            .any(|flag| starts_with_ci(arg, flag))
    })
}

/// The extension-dev loading pair: `--load-extension=<dir>` TOGETHER WITH
/// `--disable-extensions-except=<dir>` is the only way Chromium loads a
/// single unpacked extension (Playwright, the e2e, real development). Alone,
/// each flag is a bypass vector; as a pair they are the documented dev
/// launch — treating it as a bypass would shoot every developer's browser.
fn is_dev_extension_load(cmd: &[String]) -> bool {
    let loads = cmd
        .iter()
        .any(|arg| starts_with_ci(arg, "--load-extension="));
    let keeps = cmd
        .iter()
        .any(|arg| starts_with_ci(arg, "--disable-extensions-except="));
    loads && keeps
}

/// Process-aware classification: stem match first (unchanged `classify`
/// semantics), then command-line heuristics.
///
/// 1. A supported browser launched with bypass flags counts as
///    `Incompatible` — during a forced block it gets the same
///    notice-then-close treatment as Brave.
/// 2. A process `classify` calls `Unrelated` but whose command line carries
///    unmistakable Chromium/Gecko child-process flags (`--type=renderer`,
///    `-contentproc`, …) WITHOUT being an Electron/WebView host (VS Code,
///    Slack, msedgewebview2, app.asar bundles, …) is a renamed browser —
///    `Incompatible`. This is what catches `brave.exe` → `surf.exe`.
pub fn classify_process(name: &str, cmd: &[String], extra_incompatible: &[String]) -> BrowserClass {
    match classify(name, extra_incompatible) {
        BrowserClass::Supported(kind) => {
            if has_bypass_flags(cmd) && !is_dev_extension_load(cmd) {
                BrowserClass::Incompatible
            } else {
                BrowserClass::Supported(kind)
            }
        }
        BrowserClass::Incompatible => BrowserClass::Incompatible,
        BrowserClass::Unrelated => {
            let engine_flags = cmd
                .iter()
                .any(|arg| ENGINE_FLAG_PREFIXES.iter().any(|f| starts_with_ci(arg, f)));
            if !engine_flags {
                return BrowserClass::Unrelated;
            }
            let excluded_host = NON_BROWSER_HOSTS.contains(&name)
                || cmd
                    .iter()
                    .any(|arg| NON_BROWSER_CMD_MARKERS.iter().any(|m| contains_ci(arg, m)));
            if excluded_host {
                BrowserClass::Unrelated
            } else {
                BrowserClass::Incompatible
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_browsers_map_to_their_kind() {
        assert_eq!(
            classify("chrome", &[]),
            BrowserClass::Supported(CompanionBrowser::Chrome)
        );
        assert_eq!(
            classify("chromium-browser", &[]),
            BrowserClass::Supported(CompanionBrowser::Chrome)
        );
        assert_eq!(
            classify("msedge", &[]),
            BrowserClass::Supported(CompanionBrowser::Edge)
        );
        assert_eq!(
            classify("firefox-esr", &[]),
            BrowserClass::Supported(CompanionBrowser::Firefox)
        );
    }

    #[test]
    fn incompatible_browsers_are_flagged() {
        assert_eq!(classify("brave", &[]), BrowserClass::Incompatible);
        assert_eq!(classify("vivaldi", &[]), BrowserClass::Incompatible);
    }

    #[test]
    fn config_extends_the_incompatible_list() {
        let extra = vec!["fakebrowser".to_string()];
        assert_eq!(classify("fakebrowser", &extra), BrowserClass::Incompatible);
        assert_eq!(
            classify("FakeBrowser".to_lowercase().as_str(), &extra),
            BrowserClass::Incompatible
        );
        assert_eq!(classify("fakebrowser", &[]), BrowserClass::Unrelated);
    }

    #[test]
    fn everything_else_is_unrelated() {
        assert_eq!(classify("code", &[]), BrowserClass::Unrelated);
        assert_eq!(classify("steam", &[]), BrowserClass::Unrelated);
    }

    #[test]
    fn second_wave_incompatible_browsers_are_flagged() {
        for stem in [
            "floorp",
            "thorium",
            "palemoon",
            "ungoogled-chromium",
            "iceraven",
            "tor",
            "qutebrowser",
            "lynx",
            "elinks",
        ] {
            assert_eq!(classify(stem, &[]), BrowserClass::Incompatible, "{stem}");
        }
    }

    fn cmd(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bypass_flags_cover_private_guest_and_extension_kills() {
        assert!(has_bypass_flags(&cmd(&["chrome", "--incognito"])));
        assert!(has_bypass_flags(&cmd(&["msedge", "--inprivate"])));
        assert!(has_bypass_flags(&cmd(&["chrome", "--guest"])));
        assert!(has_bypass_flags(&cmd(&["firefox", "-private"])));
        assert!(has_bypass_flags(&cmd(&["firefox", "-private-window"])));
        assert!(has_bypass_flags(&cmd(&["chrome", "--disable-extensions"])));
        assert!(has_bypass_flags(&cmd(&[
            "chrome",
            "--load-extension=/tmp/evil"
        ])));
        assert!(!has_bypass_flags(&cmd(&["chrome", "--new-window"])));
        assert!(!has_bypass_flags(&cmd(&[])));
    }

    #[test]
    fn supported_browser_with_bypass_flags_counts_as_incompatible() {
        let c = cmd(&["chrome", "--incognito"]);
        assert_eq!(
            classify_process("chrome", &c, &[]),
            BrowserClass::Incompatible
        );
        let c = cmd(&["firefox", "-private-window"]);
        assert_eq!(
            classify_process("firefox", &c, &[]),
            BrowserClass::Incompatible
        );
        let c = cmd(&["msedge", "--disable-extensions"]);
        assert_eq!(
            classify_process("msedge", &c, &[]),
            BrowserClass::Incompatible
        );
        // Clean launches stay supported.
        let c = cmd(&["chrome", "--restore-last-session"]);
        assert_eq!(
            classify_process("chrome", &c, &[]),
            BrowserClass::Supported(CompanionBrowser::Chrome)
        );
    }

    #[test]
    fn dev_extension_load_pair_is_not_a_bypass() {
        // How the e2e and any developer loads the unpacked extension:
        // --load-extension alone is a bypass vector, but the pair with
        // --disable-extensions-except is the documented dev launch.
        let dev = cmd(&[
            "chromium",
            "--disable-extensions-except=/repo/dist/chrome",
            "--load-extension=/repo/dist/chrome",
        ]);
        assert_eq!(
            classify_process("chromium", &dev, &[]),
            BrowserClass::Supported(CompanionBrowser::Chrome)
        );
        // The raw flag detector still reports the pair (enforcement layer
        // applies the carve-out); plain bypass flags on their own still hit.
        assert!(has_bypass_flags(&cmd(&["--load-extension=/repo/dist"])));
        let c = cmd(&["chrome", "--load-extension=/tmp/evil"]);
        assert_eq!(
            classify_process("chrome", &c, &[]),
            BrowserClass::Incompatible
        );
    }

    #[test]
    fn incompatible_stays_incompatible_regardless_of_cmdline() {
        assert_eq!(
            classify_process("brave", &cmd(&[]), &[]),
            BrowserClass::Incompatible
        );
    }

    #[test]
    fn renamed_browser_is_caught_by_engine_child_flags() {
        // brave.exe renamed to surf.exe: stem match fails, but Brave's own
        // child processes still carry Chromium's fixed --type= flags.
        let c = cmd(&["c:/users/x/surf/surf.exe", "--type=renderer"]);
        assert_eq!(
            classify_process("surf", &c, &[]),
            BrowserClass::Incompatible
        );
        // A renamed Firefox content process carries -contentproc.
        let c = cmd(&["/opt/citrus/citrus", "-contentproc", "-parentbuildid"]);
        assert_eq!(
            classify_process("citrus", &c, &[]),
            BrowserClass::Incompatible
        );
        let c = cmd(&["x", "--utility-sub-type=network.mojom.networkservice"]);
        assert_eq!(classify_process("x", &c, &[]), BrowserClass::Incompatible);
    }

    #[test]
    fn electron_and_webview_hosts_are_not_browsers() {
        // VS Code renderer processes carry --type=renderer but stay Unrelated.
        let c = cmd(&["/usr/share/code/code", "--type=renderer"]);
        assert_eq!(classify_process("code", &c, &[]), BrowserClass::Unrelated);
        // A renamed Electron app is still caught by its app.asar bundle path.
        let c = cmd(&[
            "/opt/writely/writely",
            "--type=renderer",
            "/opt/writely/resources/app.asar",
        ]);
        assert_eq!(
            classify_process("writely", &c, &[]),
            BrowserClass::Unrelated
        );
        // WebView2 runtime + electron run-as-node markers stay Unrelated too.
        let c = cmd(&["host", "--webview-exe-name=widget.exe", "--type=renderer"]);
        assert_eq!(classify_process("host", &c, &[]), BrowserClass::Unrelated);
        let c = cmd(&["tool", "--ms-enable-electron-run-as-node", "-e", "x"]);
        assert_eq!(classify_process("tool", &c, &[]), BrowserClass::Unrelated);
        // No engine flags at all: plain Unrelated regardless.
        assert_eq!(
            classify_process("steam", &cmd(&["steam", "-silent"]), &[]),
            BrowserClass::Unrelated
        );
    }
}
