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

/// Browsers FlowGuard has no extension for: during a forced block they are
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
}
