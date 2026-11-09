//! Daemon persistence: `lock-state.json` + `config.json` in the platform
//! data dir. Writes are atomic (temp file in the same dir + rename) so a
//! crash mid-write can never truncate the lock state; corrupt or missing
//! files load as defaults, never a crash — losing a lock file must fail
//! toward the EMPTY (unlocked) state rather than take the daemon down.

use crate::allowance::{normalize_allowance_authority_state, AllowanceAuthorityState};
use crate::lock_math::LockState;
use crate::partner::PartnerState;
use crate::protocol::{BlockingState, MAX_JS_SAFE_INTEGER};
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
const BLOCKING_STATE_FILE: &str = "blocking-state.json";
const PARTNER_STATE_FILE: &str = "partner-state.json";
const ALLOWANCE_STATE_FILE: &str = "allowance-state.json";

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

    /// Ordinary blocking lives outside `config.json`: mid-lock config healing
    /// and pairing-token writes must never accidentally roll it back. A
    /// missing/corrupt file means uninitialized, which is not a disable vote.
    pub fn load_blocking_state(&self) -> Option<BlockingState> {
        self.read_json(BLOCKING_STATE_FILE)
            .filter(|state: &BlockingState| state.revision <= MAX_JS_SAFE_INTEGER)
    }

    pub fn save_blocking_state(&self, state: &BlockingState) -> io::Result<()> {
        self.save(BLOCKING_STATE_FILE, state)
    }

    /** Missing/corrupt state cannot fabricate an active partner key. Only the
     * daemon startup migration uses the unchecked loader below; every command
     * sees a fully rehydrated state validated by this method's invariant. */
    pub fn load_partner_state(&self) -> Option<PartnerState> {
        self.read_json(PARTNER_STATE_FILE)
            .filter(|state: &PartnerState| state.validate())
    }

    /// Deserialize legacy optional clock fields without accepting them as
    /// command authority. A present but unparsable file remains corruption.
    pub(crate) fn load_partner_state_for_migration(&self) -> Option<PartnerState> {
        self.read_json(PARTNER_STATE_FILE)
    }

    /// Distinguishes a genuinely uninitialized installation from a present but
    /// corrupt file. Startup initializes only the former, fail-closed on the
    /// latter rather than manufacturing a fresh trust root over existing data.
    pub fn partner_state_file_exists(&self) -> io::Result<bool> {
        match fs::metadata(self.dir.join(PARTNER_STATE_FILE)) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn save_partner_state(&self, state: &PartnerState) -> io::Result<()> {
        if !state.validate() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid partner state",
            ));
        }
        self.save(PARTNER_STATE_FILE, state)
    }

    /** Missing and malformed observations stay `None`, preserving the crucial
     * difference between "not initialized" and a valid empty revision-0 pool. */
    pub fn load_allowance_state(&self) -> Option<AllowanceAuthorityState> {
        self.read_json(ALLOWANCE_STATE_FILE)
            .and_then(|raw| normalize_allowance_authority_state(&raw))
    }

    pub fn allowance_state_file_exists(&self) -> io::Result<bool> {
        match fs::metadata(self.dir.join(ALLOWANCE_STATE_FILE)) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn save_allowance_state(&self, state: &AllowanceAuthorityState) -> io::Result<()> {
        let raw = serde_json::to_value(state)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if normalize_allowance_authority_state(&raw).is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid allowance state",
            ));
        }
        self.save(ALLOWANCE_STATE_FILE, state)
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
    fn blocking_state_is_optional_durable_and_distinct_from_config() {
        let (dir, store) = temp_store();
        assert_eq!(store.load_blocking_state(), None);
        let state = BlockingState {
            enabled: false,
            revision: 17,
        };
        store.save_blocking_state(&state).unwrap();
        assert_eq!(store.load_blocking_state(), Some(state));
        assert_eq!(store.load_config(), CompanionConfig::default());

        let reopened = Store::new(dir.path());
        assert_eq!(reopened.load_blocking_state(), Some(state));
        fs::write(dir.path().join(BLOCKING_STATE_FILE), b"{ not json").unwrap();
        assert_eq!(reopened.load_blocking_state(), None);
    }

    #[test]
    fn blocking_state_load_enforces_the_js_safe_revision_boundary() {
        let (dir, store) = temp_store();
        let at_max = BlockingState {
            enabled: true,
            revision: MAX_JS_SAFE_INTEGER,
        };
        store.save_blocking_state(&at_max).unwrap();
        assert_eq!(store.load_blocking_state(), Some(at_max));
        assert_eq!(Store::new(dir.path()).load_blocking_state(), Some(at_max));

        let beyond_max = BlockingState {
            enabled: true,
            revision: MAX_JS_SAFE_INTEGER + 1,
        };
        store.save_blocking_state(&beyond_max).unwrap();
        assert_eq!(store.load_blocking_state(), None);
        assert_eq!(Store::new(dir.path()).load_blocking_state(), None);
    }

    #[test]
    fn partner_state_roundtrips_and_corruption_has_no_active_key_fallback() {
        let (dir, store) = temp_store();
        assert_eq!(store.load_partner_state(), None);
        let state =
            crate::partner::rehydrate(&PartnerState::new(&"01".repeat(32)).unwrap(), 0, 0).unwrap();
        let public = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let state = crate::partner::add_public_key_at(&state, &public, 100, 100).unwrap();
        store.save_partner_state(&state).unwrap();
        assert_eq!(store.load_partner_state(), Some(state));
        fs::write(dir.path().join(PARTNER_STATE_FILE), b"{ not json").unwrap();
        assert_eq!(store.load_partner_state(), None);
        fs::write(dir.path().join(PARTNER_STATE_FILE), br#"{"version":999}"#).unwrap();
        assert_eq!(store.load_partner_state(), None);
    }

    #[test]
    fn allowance_state_roundtrips_and_corruption_is_not_a_fresh_pool() {
        let (dir, store) = temp_store();
        assert_eq!(store.load_allowance_state(), None);
        let state = crate::allowance::empty_allowance_authority_state();
        store.save_allowance_state(&state).unwrap();
        assert_eq!(Store::new(dir.path()).load_allowance_state(), Some(state));
        fs::write(dir.path().join(ALLOWANCE_STATE_FILE), b"{ not json").unwrap();
        assert_eq!(store.load_allowance_state(), None);
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
