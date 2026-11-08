//! Daemon persistence: `lock-state.json` + `config.json` in the platform
//! data dir. Writes are atomic (temp file in the same dir + rename) so a
//! crash mid-write can never truncate the lock state; corrupt or missing
//! files load as defaults, never a crash — losing a lock file must fail
//! toward the EMPTY (unlocked) state rather than take the daemon down.

use crate::lock_math::LockState;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Environment override for the data dir (the desktop app's safe test mode
/// points it at a scratch folder so a test instance never touches real
/// lock state). Empty = unset.
pub const DATA_DIR_ENV: &str = "SMARTBLOCKER_DATA_DIR";

/// Daemon-side configuration (`config.json`), user/e2e-editable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompanionConfig {
    /// Case-insensitive substrings matched against process exe stems while a
    /// forced block is active.
    pub app_blocklist: Vec<String>,
    /// Managed-browser policy enforcement. Ships false until the extension
    /// has a store listing (needs an update_url).
    pub policy_enforce: bool,
    pub extension_update_url: Option<String>,
    /// Extra exe stems treated as incompatible browsers — the e2e uses this
    /// to nominate a fake browser binary.
    pub extra_incompatible_browsers: Vec<String>,
    /// Pro license key (`SBPRO1.<payload_hex>.<hmac_hex>`). Fail-CLOSED
    /// (#24): None/empty or an unverifiable key is NOT Pro; the pre-store
    /// dev period is covered by the daemon's SBPRO_DEV_OPEN=1 escape hatch
    /// instead. Expiry/grace semantics — see `license`.
    pub license_key: Option<String>,
    /// Bearer tokens pairing browser profiles to the daemon (TOFU, one per
    /// extension profile; the extension sends its token in `hello.pairing`).
    /// Connections presenting none/unknown tokens get redacted status, their
    /// password writes stripped, and their heartbeats ignored. New tokens
    /// are only adopted while UNLOCKED — while locked, the pairing set is as
    /// frozen as every other setting. Bounded: oldest evicted past the cap.
    pub pairing_tokens: Vec<String>,
}

/// Cap on remembered pairing tokens — one per browser profile is the honest
/// workload; the bound keeps an unlocked-window attacker from growing the
/// file (or flushing honest tokens) without limit.
pub const MAX_PAIRING_TOKENS: usize = 32;

const LOCK_STATE_FILE: &str = "lock-state.json";
const CONFIG_FILE: &str = "config.json";

pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// `dir` override exists for tests and the e2e; production uses
    /// [`Store::at_default_dir`].
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Platform data dir via `directories` (qualifier "dev", org "davidxu",
    /// app "smartblocker"). `None` only on systems with no resolvable home.
    pub fn at_default_dir() -> Option<Self> {
        let dirs = directories::ProjectDirs::from("dev", "davidxu", "smartblocker")?;
        Some(Self::new(dirs.data_dir()))
    }

    /// `SMARTBLOCKER_DATA_DIR` when set and non-empty, else the platform
    /// default dir. `None` only when neither resolves.
    pub fn from_env_or_default() -> Option<Self> {
        Self::from_env_value(std::env::var_os(DATA_DIR_ENV))
    }

    /// Pure core of [`Store::from_env_or_default`] (tests never mutate the
    /// process environment — other tests run concurrently).
    fn from_env_value(value: Option<OsString>) -> Option<Self> {
        match value {
            Some(dir) if !dir.is_empty() => Some(Self::new(PathBuf::from(dir))),
            _ => Self::at_default_dir(),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn load_lock_state(&self) -> LockState {
        self.load_or_default(LOCK_STATE_FILE)
    }

    pub fn save_lock_state(&self, state: &LockState) -> io::Result<()> {
        self.save(LOCK_STATE_FILE, state)
    }

    pub fn load_config(&self) -> CompanionConfig {
        self.load_or_default(CONFIG_FILE)
    }

    pub fn save_config(&self, config: &CompanionConfig) -> io::Result<()> {
        self.save(CONFIG_FILE, config)
    }

    fn load_or_default<T: DeserializeOwned + Default>(&self, file: &str) -> T {
        self.read_json(file).unwrap_or_default()
    }

    fn save<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()> {
        self.write_json_atomic(file, value)
    }

    /// Missing or unparseable = `None` (callers decide the fallback).
    pub(crate) fn read_json<T: DeserializeOwned>(&self, file: &str) -> Option<T> {
        fs::read(self.dir.join(file))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    /// A fully-written temp file in the data dir, ready to be renamed into
    /// place (the caller picks clobbering `persist` or `persist_noclobber`).
    pub(crate) fn temp_json<T: Serialize>(&self, value: &T) -> io::Result<tempfile::NamedTempFile> {
        fs::create_dir_all(&self.dir)?;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.dir)?;
        serde_json::to_writer_pretty(&mut tmp, value)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        tmp.write_all(b"\n")?;
        tmp.flush()?;
        Ok(tmp)
    }

    /// Atomic write: temp file in the same dir + rename. Same-dir rename is
    /// atomic on every platform we ship, so readers never see a torn file.
    pub(crate) fn write_json_atomic<T: Serialize>(&self, file: &str, value: &T) -> io::Result<()> {
        let tmp = self.temp_json(value)?;
        tmp.persist(self.dir.join(file)).map_err(|e| e.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        (dir, store)
    }

    #[test]
    fn missing_files_load_as_defaults() {
        let (_dir, store) = temp_store();
        assert_eq!(store.load_lock_state(), LockState::default());
        assert_eq!(store.load_config(), CompanionConfig::default());
    }

    #[test]
    fn corrupt_files_load_as_defaults() {
        let (dir, store) = temp_store();
        fs::write(dir.path().join(LOCK_STATE_FILE), b"{ not json").unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"[1,2,3]").unwrap();
        assert_eq!(store.load_lock_state(), LockState::default());
        assert_eq!(store.load_config(), CompanionConfig::default());
    }

    #[test]
    // `..default()` covers LockState fields added by in-flight work; on a tree
    // without them every field is listed and clippy would call it needless.
    #[allow(clippy::needless_update)]
    fn lock_state_roundtrips() {
        let (_dir, store) = temp_store();
        let state = LockState {
            timer_until: Some(1_720_000_000_000),
            frozen_until: None,
            password_hash: Some("ab".repeat(32)),
            password_ts: 4,
            schedules: vec![],
            schedules_updated_at: 5,
            ..LockState::default()
        };
        store.save_lock_state(&state).unwrap();
        assert_eq!(store.load_lock_state(), state);
    }

    #[test]
    fn config_roundtrips_and_defaults_missing_fields() {
        let (dir, store) = temp_store();
        let config = CompanionConfig {
            app_blocklist: vec!["steam".into()],
            extra_incompatible_browsers: vec!["fakebrowser".into()],
            ..CompanionConfig::default()
        };
        store.save_config(&config).unwrap();
        assert_eq!(store.load_config(), config);

        // Partial config (hand-edited) keeps defaults for absent fields.
        fs::write(
            dir.path().join(CONFIG_FILE),
            br#"{ "appBlocklist": ["x"] }"#,
        )
        .unwrap();
        let loaded = store.load_config();
        assert_eq!(loaded.app_blocklist, vec!["x".to_string()]);
        assert!(!loaded.policy_enforce);
        assert!(loaded.extra_incompatible_browsers.is_empty());
    }

    #[test]
    fn env_override_wins_and_empty_falls_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::from_env_value(Some(dir.path().as_os_str().to_owned())).unwrap();
        assert_eq!(store.dir(), dir.path());
        // Unset and empty both mean "platform default" (None only when no
        // home dir resolves, which the default-dir resolver decides).
        let default = Store::at_default_dir().map(|s| s.dir().to_path_buf());
        assert_eq!(
            Store::from_env_value(None).map(|s| s.dir().to_path_buf()),
            default
        );
        assert_eq!(
            Store::from_env_value(Some(OsString::new())).map(|s| s.dir().to_path_buf()),
            default
        );
    }

    #[test]
    fn save_creates_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("nested").join("data"));
        store.save_lock_state(&LockState::default()).unwrap();
        assert_eq!(store.load_lock_state(), LockState::default());
    }
}
