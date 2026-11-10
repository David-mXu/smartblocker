//! Typed desktop-app identity for the blocked-apps list.
//!
//! The original list (`appBlocklist`) is a set of case-insensitive
//! substrings matched against a process's executable stem. That is convenient
//! ("steam" also closes `steamwebhelper`) but imprecise: it can close a
//! sibling or a renamed decoy the user never meant to target.
//!
//! [`AppTarget`] is the versioned, typed replacement:
//!
//! - `exactStem` — the executable stem must be equal (never a substring);
//! - `exePath` — the full executable path must be equal after deterministic
//!   Windows normalization (case, `/` vs `\`, UNC and long-path prefixes,
//!   `.`/`..`, duplicate separators, basename extraction). There is no
//!   folder-prefix recursion: only the executable itself matches;
//! - `msixPackage` — the Microsoft Store package family name reported by
//!   Windows process metadata (`GetPackageFamilyName`).
//!
//! Precedence is explicit and independent of storage order:
//! `msixPackage` > `exePath` > `exactStem` > legacy `contains`. All identities
//! are pure and platform-independent here; only [`crate::win_meta`] reads
//! live package metadata.
//!
//! Legacy entries stay authoritative for backward compatibility: they are
//! never migrated away automatically, and a typed target for the same app
//! does not narrow a legacy entry's sibling matches. The UI shows both and
//! lets the user remove the broad rule deliberately.

use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};

/// Current typed-target schema. A target with a newer version is ignored by
/// this build instead of being interpreted with older semantics.
pub const APP_TARGETS_VERSION: u32 = 1;

/// Bounds applied on load and save. They keep a hand-edited `config.json`
/// from growing the matcher without limit.
pub const MAX_APP_TARGETS: usize = 256;
pub const MAX_LEGACY_ENTRIES: usize = 256;
pub const MAX_LEGACY_CHARS: usize = 128;
pub const MAX_STEM_CHARS: usize = 64;
pub const MAX_PATH_CHARS: usize = 1024;
pub const MAX_PACKAGE_CHARS: usize = 255;

const APP_TARGET_KINDS: &[&str] = &["exactStem", "exePath", "msixPackage"];

fn current_target_version() -> u32 {
    APP_TARGETS_VERSION
}

/// Lenient config deserializer: one malformed/unknown-kind target must not
/// discard the user's whole app list (or the rest of `config.json`). Each
/// entry is decoded independently; failures are dropped and sanitized later.
pub fn deserialize_targets_lenient<'de, D>(deserializer: D) -> Result<Vec<AppTarget>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Array(items) = raw else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect())
}

/// One saved typed target. `version` is part of the stored shape so a
/// future kind/semantic change can be rejected by older binaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppTarget {
    #[serde(rename = "exactStem")]
    ExactStem {
        #[serde(default = "current_target_version")]
        version: u32,
        /// Normalized exe stem: lowercase, no `.exe`, no path.
        stem: String,
    },
    #[serde(rename = "exePath")]
    ExePath {
        #[serde(default = "current_target_version")]
        version: u32,
        /// Normalized absolute executable path. Matching is exact equality,
        /// not a containing-folder test.
        path: String,
    },
    #[serde(rename = "msixPackage")]
    MsixPackage {
        #[serde(default = "current_target_version")]
        version: u32,
        /// Microsoft Store package family name, e.g.
        /// `Microsoft.WindowsCalculator_8wekyb3d8bbwe`.
        #[serde(rename = "familyName")]
        family_name: String,
    },
}

impl AppTarget {
    pub fn exact_stem(raw: &str) -> Option<Self> {
        normalize_exact_stem(raw).map(|stem| Self::ExactStem {
            version: APP_TARGETS_VERSION,
            stem,
        })
    }

    pub fn exe_path(raw: &str) -> Option<Self> {
        normalize_exe_path(raw).map(|path| Self::ExePath {
            version: APP_TARGETS_VERSION,
            path,
        })
    }

    pub fn msix_package(raw: &str) -> Option<Self> {
        normalize_package_family(raw).map(|family_name| Self::MsixPackage {
            version: APP_TARGETS_VERSION,
            family_name,
        })
    }

    pub fn version(&self) -> u32 {
        match self {
            Self::ExactStem { version, .. }
            | Self::ExePath { version, .. }
            | Self::MsixPackage { version, .. } => *version,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::ExactStem { .. } => "exactStem",
            Self::ExePath { .. } => "exePath",
            Self::MsixPackage { .. } => "msixPackage",
        }
    }

    /// Canonical identity used for dedupe and lock add-only checks. It is
    /// stable across casing/separator spellings of the same target.
    pub fn key(&self) -> String {
        match self {
            Self::ExactStem { stem, .. } => format!("exactStem:{stem}"),
            Self::ExePath { path, .. } => format!("exePath:{path}"),
            Self::MsixPackage { family_name, .. } => format!("msixPackage:{family_name}"),
        }
    }

    /// Normalize a stored target. `None` means malformed or from a newer
    /// schema, so callers should drop it rather than guess.
    pub fn canonical(&self) -> Option<Self> {
        if self.version() > APP_TARGETS_VERSION {
            return None;
        }
        match self {
            Self::ExactStem { stem, .. } => Self::exact_stem(stem),
            Self::ExePath { path, .. } => Self::exe_path(path),
            Self::MsixPackage { family_name, .. } => Self::msix_package(family_name),
        }
    }

    /// Does this target identify the given process? Typed targets only match
    /// the process itself; no parent-folder or sibling-stem recursion.
    pub fn matches(&self, identity: &ProcessIdentity<'_>) -> bool {
        match self {
            Self::ExactStem { stem, .. } => {
                normalize_exact_stem(identity.stem).as_deref() == Some(stem.as_str())
            }
            Self::ExePath { path, .. } => {
                identity.exe_path.and_then(normalize_exe_path).as_deref() == Some(path.as_str())
            }
            Self::MsixPackage { family_name, .. } => {
                identity
                    .package_family
                    .and_then(normalize_package_family)
                    .as_deref()
                    == Some(family_name.as_str())
            }
        }
    }
}

/// The bits of a running process the matcher needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity<'a> {
    /// Normalized or raw exe stem; normalization happens in the matcher.
    pub stem: &'a str,
    /// Full exe path when readable.
    pub exe_path: Option<&'a str>,
    /// Microsoft Store package family name when Windows exposes it.
    pub package_family: Option<&'a str>,
}

/// Match strength, weakest to strongest. The derived `Ord` is the explicit
/// precedence: a package match outranks a path match, which outranks an exact
/// stem, which outranks a legacy contains entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    LegacyContains,
    ExactStem,
    ExePath,
    MsixPackage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppMatch {
    pub kind: MatchKind,
    /// Index into the legacy list when the winning match is a contains rule.
    pub legacy_index: Option<usize>,
    /// Index into the typed list when the winning match is a typed target.
    pub target_index: Option<usize>,
}

/// Resolve the strongest match for one process. Typed targets take
/// precedence over legacy substrings; within typed targets, package > path >
/// stem. A process matching several entries reports the strongest one, which
/// is what the UI's preview/explanation shows.
pub fn match_process(
    identity: &ProcessIdentity<'_>,
    legacy: &[String],
    targets: &[AppTarget],
) -> Option<AppMatch> {
    let mut best: Option<AppMatch> = None;
    for (index, target) in targets.iter().enumerate() {
        if !target.matches(identity) {
            continue;
        }
        let kind = match target {
            AppTarget::MsixPackage { .. } => MatchKind::MsixPackage,
            AppTarget::ExePath { .. } => MatchKind::ExePath,
            AppTarget::ExactStem { .. } => MatchKind::ExactStem,
        };
        if best.as_ref().is_none_or(|current| kind > current.kind) {
            best = Some(AppMatch {
                kind,
                legacy_index: None,
                target_index: Some(index),
            });
        }
    }

    let stem = identity.stem.to_lowercase();
    if let Some(index) = legacy.iter().position(|entry| {
        let entry = entry.trim().to_lowercase();
        !entry.is_empty() && stem.contains(&entry)
    }) {
        if best
            .as_ref()
            .is_none_or(|current| MatchKind::LegacyContains > current.kind)
        {
            best = Some(AppMatch {
                kind: MatchKind::LegacyContains,
                legacy_index: Some(index),
                target_index: None,
            });
        }
    }
    best
}

/// Convenience predicate for the enforcement loop.
pub fn matches_process(
    identity: &ProcessIdentity<'_>,
    legacy: &[String],
    targets: &[AppTarget],
) -> bool {
    match_process(identity, legacy, targets).is_some()
}

/// Trim/dedupe legacy entries, reject control characters, and bound the list.
/// Legacy semantics stay substring-of-stem; this only removes accidental
/// blanks and duplicates so a hand-edited file cannot grow unbounded.
pub fn sanitize_legacy_entries(entries: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for entry in entries {
        if out.len() >= MAX_LEGACY_ENTRIES {
            break;
        }
        let entry = entry.trim().to_string();
        if entry.is_empty()
            || entry.chars().count() > MAX_LEGACY_CHARS
            || entry.chars().any(char::is_control)
        {
            continue;
        }
        if seen.insert(entry.to_lowercase()) {
            out.push(entry);
        }
    }
    out
}

/// Normalize/dedupe/drop malformed targets, preserving first-seen order.
pub fn sanitize_targets(targets: Vec<AppTarget>) -> Vec<AppTarget> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for target in targets {
        if out.len() >= MAX_APP_TARGETS {
            break;
        }
        if let Some(target) = target.canonical() {
            if seen.insert(target.key()) {
                out.push(target);
            }
        }
    }
    out
}

/// Schema version for a sanitized list: 0 when there are no typed targets,
/// otherwise the current version. This is what `config.json` stores.
pub fn version_for(targets: &[AppTarget]) -> u32 {
    if targets.is_empty() {
        0
    } else {
        APP_TARGETS_VERSION
    }
}

/// One of the recognized target-kind spellings (used by the UI test/contract).
pub fn is_target_kind(kind: &str) -> bool {
    APP_TARGET_KINDS.contains(&kind)
}

fn strip_quotes(raw: &str) -> &str {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return trimmed[1..trimmed.len() - 1].trim();
    }
    trimmed
}

fn starts_with_ci(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len()
        && value.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Deterministic exe-stem normalization shared with the running-app picker
/// and the enforcer: lowercase, no `.exe`, no self-updater numeric suffix.
pub fn normalize_exact_stem(raw: &str) -> Option<String> {
    let raw = strip_quotes(raw);
    if raw.is_empty()
        || raw.chars().any(|c| c.is_control())
        || raw.chars().any(|c| matches!(c, '/' | '\\'))
    {
        return None;
    }
    let stem = crate::procwatch::normalize_exe_stem(raw);
    if stem.is_empty() || stem.chars().count() > MAX_STEM_CHARS {
        return None;
    }
    // Typed stems are literal names, never wildcard/folder patterns.
    if stem
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return None;
    }
    Some(stem)
}

/// Deterministic executable-path normalization.
///
/// Windows: case-insensitive, `/` and `\` equivalent, `\\?\` and
/// `\\?\UNC\` long-path prefixes removed, duplicate separators collapsed,
/// `.`/`..` resolved lexically, trailing separators and component trailing
/// dots/spaces removed, UNC kept canonical, and the result lowercased.
///
/// POSIX absolute paths are normalized too (duplicate separators, `.`/`..`,
/// lowercase) so the same pure core is testable on Linux and the desktop
/// preview's mock data works off Windows.
pub fn normalize_exe_path(raw: &str) -> Option<String> {
    let raw = strip_quotes(raw);
    if raw.is_empty() || raw.chars().any(char::is_control) {
        return None;
    }
    let slash = raw.replace('\\', "/");
    let slash = strip_windows_prefixes(&slash);

    let (prefix, floor, windows, remainder) = if let Some(rest) = slash.strip_prefix("//") {
        let mut parts = rest.split('/');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (
            format!("//{server}/{share}"),
            2,
            true,
            parts.collect::<Vec<_>>().join("/"),
        )
    } else if let Some((drive, rest)) = strip_drive(&slash) {
        // The drive root is a path PREFIX, never a target itself.
        (drive, 1, true, rest.to_string())
    } else if let Some(rest) = slash.strip_prefix('/') {
        ("/".to_string(), 1, false, rest.to_string())
    } else {
        return None;
    };

    let mut components = prefix_components(&prefix);
    let prefix_len = components.len();
    for component in remainder.split('/') {
        push_component(&mut components, component, floor)?;
    }
    // A path target must include a basename. `C:\`, `/` and a bare UNC share
    // are not executable identities.
    if components.len() == prefix_len {
        return None;
    }

    let joined = if windows {
        if prefix.starts_with("//") {
            format!("\\\\{}", components.join("\\"))
        } else {
            format!("{}\\{}", components[0], components[1..].join("\\"))
        }
    } else {
        format!("/{}", components.join("/"))
    };
    let normalized = joined.to_lowercase();
    if normalized.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    Some(normalized)
}

/// Strip `\\?\`, `\\?\UNC\`, `\\.\` and `\??\` prefixes after separators
/// have been normalized to `/`.
fn strip_windows_prefixes(path: &str) -> String {
    for prefix in ["//?/UNC/", "//?/unc/", "//./", "//?/"] {
        if starts_with_ci(path, prefix) {
            let rest = &path[prefix.len()..];
            return if prefix.eq_ignore_ascii_case("//?/unc/") {
                format!("//{rest}")
            } else {
                rest.to_string()
            };
        }
    }
    if starts_with_ci(path, "/??/") {
        return path["/??/".len()..].to_string();
    }
    path.to_string()
}

fn strip_drive(path: &str) -> Option<(String, &str)> {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        Some((path[..2].to_lowercase(), &path[2..]))
    } else {
        None
    }
}

fn prefix_components(prefix: &str) -> Vec<String> {
    prefix
        .split('/')
        .filter(|component| !component.is_empty())
        .map(str::to_string)
        .collect()
}

fn push_component(out: &mut Vec<String>, raw: &str, floor: usize) -> Option<()> {
    let component = raw.trim_end_matches([' ', '.']);
    if component.is_empty() || component == ".." {
        if raw == ".." && out.len() > floor {
            out.pop();
        }
        return Some(());
    }
    if component.chars().any(|c| {
        matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0' | '/') || c.is_control()
    }) {
        return None;
    }
    out.push(component.to_string());
    Some(())
}

/// Last path component (basename) of a normalized or raw path. Useful for
/// showing "steam.exe" next to a full path and for exact-stem fallback.
pub fn path_basename(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or_default();
    let drive_only = base.len() == 2 && base.as_bytes()[1] == b':';
    if base.is_empty() || base == "." || base == ".." || drive_only {
        None
    } else {
        Some(base.to_string())
    }
}

/// Normalize a Microsoft Store package family name. Format is
/// `<PackageName>_<PublisherId>`, case-insensitive.
pub fn normalize_package_family(raw: &str) -> Option<String> {
    let raw = strip_quotes(raw);
    if raw.is_empty() || raw.chars().count() > MAX_PACKAGE_CHARS {
        return None;
    }
    let lower = raw.to_lowercase();
    if lower.chars().any(|c| c.is_control() || c.is_whitespace())
        || !lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    let (name, publisher) = lower.rsplit_once('_')?;
    if name.is_empty() || publisher.is_empty() {
        return None;
    }
    Some(lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity<'a>(stem: &'a str, path: Option<&'a str>) -> ProcessIdentity<'a> {
        ProcessIdentity {
            stem,
            exe_path: path,
            package_family: None,
        }
    }

    #[test]
    fn windows_path_normalization_handles_case_separators_unc_and_long_paths() {
        let expected = "c:\\program files\\steam\\steam.exe";
        for raw in [
            r"C:\Program Files\Steam\Steam.exe",
            "c:/program files/steam/steam.exe",
            r"\\?\C:\Program Files\Steam\Steam.exe",
            r"\??\C:\Program Files\Steam\Steam.exe",
            r"C:\Program Files\.\Steam\\Steam.exe",
            r"C:\Program Files\Tools\..\Steam\Steam.exe",
            r#" "C:\Program Files\Steam\Steam.exe" "#,
        ] {
            assert_eq!(normalize_exe_path(raw).as_deref(), Some(expected), "{raw}");
        }

        assert_eq!(
            normalize_exe_path(r"\\?\UNC\Server\Share\Games\Steam.exe").as_deref(),
            Some(r"\\server\share\games\steam.exe")
        );
        assert_eq!(
            normalize_exe_path(r"\\Server\Share\Games\Steam.exe").as_deref(),
            Some(r"\\server\share\games\steam.exe")
        );
        assert_eq!(
            normalize_exe_path(r"C:\Games\Steam.exe.").as_deref(),
            Some(r"c:\games\steam.exe")
        );
    }

    #[test]
    fn windows_path_normalization_rejects_relative_and_malformed_paths() {
        for raw in [
            "",
            "steam.exe",
            "C:",
            r"C:Steam\Steam.exe",
            r"C:\",
            r"\\server",
            r"\\server\share",
            r"C:\Games\bad|name.exe",
            r"C:\Games\steam.exe:ads",
        ] {
            assert_eq!(normalize_exe_path(raw), None, "{raw}");
        }
        assert_eq!(
            normalize_exe_path("/usr/bin/Code").as_deref(),
            Some("/usr/bin/code")
        );
        assert_eq!(
            normalize_exe_path("/usr/local/../bin/code").as_deref(),
            Some("/usr/bin/code")
        );
    }

    #[test]
    fn basename_and_stem_normalization_are_deterministic() {
        assert_eq!(
            path_basename(r"C:\Program Files\Steam\Steam.exe").as_deref(),
            Some("Steam.exe")
        );
        assert_eq!(
            path_basename("C:\\Games\\Steam\\").as_deref(),
            Some("Steam")
        );
        assert_eq!(path_basename("C:\\"), None);
        for raw in ["Steam.exe", "  STEAM.EXE  ", "steam"] {
            assert_eq!(normalize_exact_stem(raw).as_deref(), Some("steam"));
        }
        assert_eq!(
            normalize_exact_stem("agy.exe.1793826601058390500").as_deref(),
            Some("agy")
        );
        assert_eq!(normalize_exact_stem(""), None);
        assert_eq!(normalize_exact_stem(r"C:\Steam\steam.exe"), None);
        assert_eq!(normalize_exact_stem("bad*name"), None);
    }

    #[test]
    fn target_constructors_normalize_and_reject_malformed_input() {
        assert_eq!(
            AppTarget::exact_stem(" Steam.exe ").unwrap(),
            AppTarget::ExactStem {
                version: APP_TARGETS_VERSION,
                stem: "steam".into()
            }
        );
        assert_eq!(
            AppTarget::exe_path(r"C:\Program Files\Steam\Steam.exe").unwrap(),
            AppTarget::ExePath {
                version: APP_TARGETS_VERSION,
                path: r"c:\program files\steam\steam.exe".into()
            }
        );
        assert_eq!(
            AppTarget::msix_package("Microsoft.WindowsCalculator_8wekyb3d8bbwe").unwrap(),
            AppTarget::MsixPackage {
                version: APP_TARGETS_VERSION,
                family_name: "microsoft.windowscalculator_8wekyb3d8bbwe".into()
            }
        );
        assert!(AppTarget::exact_stem("").is_none());
        assert!(AppTarget::exe_path(r"relative.exe").is_none());
        assert!(AppTarget::msix_package("NoPublisherSuffix").is_none());
        assert!(AppTarget::msix_package("bad/name_publisher").is_none());
    }

    #[test]
    fn versioned_targets_roundtrip_and_newer_versions_are_dropped() {
        let target = AppTarget::exe_path(r"C:\Games\Steam.exe").unwrap();
        let wire = serde_json::to_value(&target).unwrap();
        assert_eq!(wire["version"], 1);
        assert_eq!(wire["kind"], "exePath");
        assert_eq!(serde_json::from_value::<AppTarget>(wire).unwrap(), target);

        let newer: AppTarget = serde_json::from_value(serde_json::json!({
            "version": 99,
            "kind": "exePath",
            "path": r"C:\Games\Steam.exe"
        }))
        .unwrap();
        assert_eq!(newer.version(), 99);
        assert_eq!(newer.canonical(), None);
        assert_eq!(sanitize_targets(vec![newer, target.clone()]), vec![target]);
    }

    #[test]
    fn exact_targets_never_substring_or_folder_match() {
        let stem = AppTarget::exact_stem("steam").unwrap();
        let path = AppTarget::exe_path(r"C:\Games\Steam\steam.exe").unwrap();
        let package = AppTarget::msix_package("Microsoft.WindowsCalculator_8wekyb3d8bbwe").unwrap();

        assert!(stem.matches(&identity("steam", None)));
        assert!(!stem.matches(&identity("steamwebhelper", None)));
        assert!(!stem.matches(&identity("smartblocker-steam", None)));

        assert!(path.matches(&identity("steam", Some(r"C:\Games\Steam\steam.exe"))));
        assert!(path.matches(&identity("renamed", Some(r"c:/games/steam/STEAM.EXE"))));
        // A process inside the folder but not the target executable.
        assert!(!path.matches(&identity(
            "steamwebhelper",
            Some(r"C:\Games\Steam\steamwebhelper.exe")
        )));
        // The folder itself (or a parent) is not a recursive match.
        assert!(!path.matches(&identity("steam", Some(r"C:\Games\Steam"))));

        let packaged = ProcessIdentity {
            stem: "calculator",
            exe_path: None,
            package_family: Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
        };
        assert!(package.matches(&packaged));
        let unpackaged = ProcessIdentity {
            package_family: None,
            ..packaged
        };
        assert!(!package.matches(&unpackaged));
    }

    #[test]
    fn legacy_contains_matches_but_loses_precedence_to_typed_targets() {
        let legacy = vec!["steam".to_string()];
        let targets = vec![AppTarget::exact_stem("steam").unwrap()];
        assert_eq!(
            match_process(&identity("steamwebhelper", None), &legacy, &[]),
            Some(AppMatch {
                kind: MatchKind::LegacyContains,
                legacy_index: Some(0),
                target_index: None
            })
        );
        assert_eq!(
            match_process(&identity("steam", None), &legacy, &targets),
            Some(AppMatch {
                kind: MatchKind::ExactStem,
                legacy_index: None,
                target_index: Some(0)
            })
        );
        assert_eq!(
            match_process(&identity("steamwebhelper", None), &legacy, &targets)
                .unwrap()
                .kind,
            MatchKind::LegacyContains
        );
        assert_eq!(
            match_process(&identity("discord", None), &legacy, &targets),
            None
        );
    }

    #[test]
    fn package_path_and_stem_precedence_is_explicit() {
        let pkg = AppTarget::msix_package("Microsoft.WindowsCalculator_8wekyb3d8bbwe").unwrap();
        let path = AppTarget::exe_path(r"C:\Apps\calc.exe").unwrap();
        let stem = AppTarget::exact_stem("calc").unwrap();
        let targets = vec![stem.clone(), path.clone(), pkg.clone()];
        let identity = ProcessIdentity {
            stem: "calc",
            exe_path: Some(r"C:\Apps\calc.exe"),
            package_family: Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe"),
        };
        assert_eq!(
            match_process(&identity, &["calc".into()], &targets)
                .unwrap()
                .kind,
            MatchKind::MsixPackage
        );
        // Storage order does not decide precedence.
        let reversed = vec![pkg, path, stem];
        assert_eq!(
            match_process(&identity, &[], &reversed).unwrap().kind,
            MatchKind::MsixPackage
        );
    }

    #[test]
    fn sanitize_bounds_and_dedupes_both_lists() {
        let mut legacy = vec![" Steam ".into(), "steam".into(), "".into(), "a\nb".into()];
        legacy.extend((0..MAX_LEGACY_ENTRIES + 20).map(|n| format!("entry{n}")));
        let legacy = sanitize_legacy_entries(legacy);
        assert_eq!(legacy[0], "Steam");
        assert_eq!(legacy.len(), MAX_LEGACY_ENTRIES);
        assert!(legacy
            .iter()
            .all(|entry| !entry.is_empty() && !entry.contains('\n')));

        let target = AppTarget::exact_stem("steam").unwrap();
        let dupes = vec![
            target.clone(),
            AppTarget::exact_stem("STEAM.exe").unwrap(),
            AppTarget::ExePath {
                version: APP_TARGETS_VERSION,
                path: "relative.exe".into(),
            },
            AppTarget::ExactStem {
                version: APP_TARGETS_VERSION,
                stem: "bad*name".into(),
            },
        ];
        assert_eq!(sanitize_targets(dupes), vec![target]);
        assert_eq!(version_for(&[]), 0);
        assert_eq!(version_for(&[AppTarget::exact_stem("x").unwrap()]), 1);
        assert!(is_target_kind("exePath"));
        assert!(!is_target_kind("pid"));
    }
}
