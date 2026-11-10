//! Offline accountability-partner authorization. No lock state lives here:
//! successful verification returns ONLY the signed arm generation. The daemon
//! must durably store the returned replay tombstone before releasing that arm.
//! The partner holds the Ed25519 secret key; installations hold public keys,
//! pending operations and replay records. `SBPRO1` HMAC data is unrelated.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const PARTNER_ACTIVATION_DELAY_MS: i64 = 24 * 60 * 60 * 1000;
pub const MAX_OPERATION_LIFETIME_MS: i64 = 15 * 60 * 1000;
const MAX_TIMESTAMP_MS: i64 = 9_007_199_254_740_991;
const MAX_MONO_MS: u64 = MAX_TIMESTAMP_MS as u64;
const MAX_KEYS: usize = 8;
const MAX_OPERATIONS: usize = 8;
const MAX_TOKEN_CHARS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartnerError {
    InvalidState,
    RngUnavailable,
    InvalidHex,
    InvalidTime,
    ClockRollback,
    TimeOverflow,
    KeyLimit,
    NoActiveKey,
    OperationLimit,
    DuplicateOperation,
    UnknownOperation,
    Expired,
    ExpiryAfterOperation,
    WrongInstallation,
    WrongArm,
    WrongNonce,
    WrongExpiry,
    Replay,
    BadSignature,
    MalformedCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartnerErrorDisplay(pub PartnerError);
impl fmt::Display for PartnerErrorDisplay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "partner authorization refused: {:?}", self.0)
    }
}
impl std::error::Error for PartnerErrorDisplay {}
impl fmt::Display for PartnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        PartnerErrorDisplay(*self).fmt(f)
    }
}

pub type PartnerResult<T> = Result<T, PartnerError>;

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex<const N: usize>(value: &str) -> PartnerResult<[u8; N]> {
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(PartnerError::InvalidHex);
    }
    let mut result = [0u8; N];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| PartnerError::InvalidHex)?;
    }
    Ok(result)
}

fn valid_id(value: &str) -> bool {
    decode_hex::<32>(value).is_ok()
}
fn valid_time(value: i64) -> bool {
    (0..=MAX_TIMESTAMP_MS).contains(&value)
}
fn valid_mono(value: u64) -> bool {
    value <= MAX_MONO_MS
}
fn valid_public_key(value: &str) -> bool {
    decode_hex::<32>(value)
        .ok()
        .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
        .is_some()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartnerPublicKey {
    pub public_key: String,
    pub added_at_ms: i64,
    pub active_at_ms: i64,
    /// Current-runtime monotonic activation start/deadline. An unproven key is
    /// re-anchored to a full delay during every startup migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_mono_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mono_ms: Option<u64>,
    /// Durable proof requires BOTH genuine observations. Historical monotonic
    /// values are evidence only after restart, never Instant values to reuse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_observed_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_observed_mono_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPartnerOperation {
    pub installation_id: String,
    pub arm_generation: String,
    pub operation_id: String,
    pub nonce: String,
    pub expires_at_ms: i64,
    /// Absolute only within this daemon runtime. Startup deletes these unsigned
    /// operations rather than trying to carry an Instant across a reboot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_mono_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpentPartnerCode {
    pub operation_id: String,
    pub signature: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartnerState {
    pub version: u32,
    pub installation_id: String,
    pub public_keys: Vec<PartnerPublicKey>,
    pub pending_operations: Vec<PendingPartnerOperation>,
    pub spent_codes: Vec<SpentPartnerCode>,
    pub last_observed_at_ms: i64,
    /// Rehydrated to the current daemon-relative monotonic clock at startup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_observed_mono_ms: Option<u64>,
}

impl PartnerState {
    pub fn new(installation_id: &str) -> PartnerResult<Self> {
        if !valid_id(installation_id) {
            return Err(PartnerError::InvalidHex);
        }
        Ok(Self {
            version: 1,
            installation_id: installation_id.into(),
            public_keys: vec![],
            pending_operations: vec![],
            spent_codes: vec![],
            last_observed_at_ms: 0,
            last_observed_mono_ms: None,
        })
    }

    /// Structural validation shared by current state and legacy migration.
    /// Partial clock pairs are corrupt, not an invitation for wall fallback.
    fn validate_structure(&self) -> bool {
        if self.version != 1
            || !valid_id(&self.installation_id)
            || !valid_time(self.last_observed_at_ms)
            || self
                .last_observed_mono_ms
                .is_some_and(|mono| !valid_mono(mono))
            || self.public_keys.len() > MAX_KEYS
            || self.pending_operations.len() > MAX_OPERATIONS
        {
            return false;
        }
        let mut keys = std::collections::BTreeSet::new();
        if !self.public_keys.iter().all(|key| {
            let mono_pair = match (key.added_mono_ms, key.active_mono_ms) {
                (Some(added), Some(active)) => {
                    valid_mono(added)
                        && valid_mono(active)
                        && added.checked_add(PARTNER_ACTIVATION_DELAY_MS as u64) == Some(active)
                }
                (None, None) => true,
                _ => false,
            };
            let proof = match (
                key.activation_observed_at_ms,
                key.activation_observed_mono_ms,
            ) {
                (Some(observed_wall), Some(observed_mono)) => {
                    mono_pair
                        && valid_time(observed_wall)
                        && valid_mono(observed_mono)
                        && observed_wall >= key.active_at_ms
                        && observed_wall <= self.last_observed_at_ms
                        && key
                            .active_mono_ms
                            .is_some_and(|active| observed_mono >= active)
                }
                (None, None) => true,
                _ => false,
            };
            valid_public_key(&key.public_key)
                && valid_time(key.added_at_ms)
                && valid_time(key.active_at_ms)
                && key.added_at_ms.checked_add(PARTNER_ACTIVATION_DELAY_MS)
                    == Some(key.active_at_ms)
                && mono_pair
                && proof
                && keys.insert(key.public_key.clone())
        }) {
            return false;
        }
        let mut operation_ids = std::collections::BTreeSet::new();
        let mut nonces = std::collections::BTreeSet::new();
        if !self.pending_operations.iter().all(|operation| {
            operation.installation_id == self.installation_id
                && valid_id(&operation.arm_generation)
                && valid_id(&operation.operation_id)
                && valid_id(&operation.nonce)
                && valid_time(operation.expires_at_ms)
                && operation.expires_mono_ms.is_none_or(valid_mono)
                && operation_ids.insert(operation.operation_id.clone())
                && nonces.insert(operation.nonce.clone())
        }) {
            return false;
        }
        let mut signatures = std::collections::BTreeSet::new();
        self.spent_codes.iter().all(|spent| {
            valid_id(&spent.operation_id)
                && spent.signature.len() == 128
                && decode_hex::<64>(&spent.signature).is_ok()
                && valid_time(spent.expires_at_ms)
                && operation_ids.insert(spent.operation_id.clone())
                && signatures.insert(spent.signature.clone())
        })
    }

    /** Every command transition validates fully rehydrated persisted state
     * first. Legacy/absent monotonic fields cannot authorize by wall time. */
    pub fn validate(&self) -> bool {
        self.validate_structure()
            && self.last_observed_mono_ms.is_some()
            && self
                .public_keys
                .iter()
                .all(|key| key.added_mono_ms.is_some() && key.active_mono_ms.is_some())
            && self
                .pending_operations
                .iter()
                .all(|operation| operation.expires_mono_ms.is_some())
    }

    fn prune(&mut self, now: i64, now_mono: u64) {
        self.pending_operations.retain(|operation| {
            operation.expires_at_ms > now
                && operation
                    .expires_mono_ms
                    .is_some_and(|expiry| expiry > now_mono)
        });
        // Beyond signed expiry, replay is impossible even if its tombstone is
        // evicted. Retain EVERY unexpired record: evicting a live tombstone
        // would let a caller-chosen operation id replay a still-valid code.
        // Expired records are the only ones safe to drop.
        self.spent_codes.retain(|spent| spent.expires_at_ms > now);
    }
}

fn checked_now(state: &PartnerState, now: i64, now_mono: u64) -> PartnerResult<(i64, u64)> {
    if !state.validate() {
        return Err(PartnerError::InvalidState);
    }
    if !valid_time(now) || !valid_mono(now_mono) {
        return Err(PartnerError::InvalidTime);
    }
    if now < state.last_observed_at_ms
        || state
            .last_observed_mono_ms
            .is_none_or(|observed| now_mono < observed)
    {
        return Err(PartnerError::ClockRollback);
    }
    Ok((now, now_mono))
}

fn key_is_active(key: &PartnerPublicKey, now: i64, now_mono: u64) -> bool {
    if key.activation_observed_at_ms.is_some() && key.activation_observed_mono_ms.is_some() {
        return true;
    }
    key.active_at_ms <= now && key.active_mono_ms.is_some_and(|active| active <= now_mono)
}

/** Restart/migration is the ONLY routine that accepts absent monotonic fields.
 * It clears unsigned operations, preserves proof/tombstones and gives every
 * unproven key a fresh wall+monotonic 24h wait. Durable writes happen in the
 * daemon before this returned state can accept any command. */
pub fn rehydrate(state: &PartnerState, now: i64, now_mono: u64) -> PartnerResult<PartnerState> {
    if !state.validate_structure() {
        return Err(PartnerError::InvalidState);
    }
    if !valid_time(now) || !valid_mono(now_mono) {
        return Err(PartnerError::InvalidTime);
    }
    let activation_wall = now.max(state.last_observed_at_ms);
    let active_at = activation_wall
        .checked_add(PARTNER_ACTIVATION_DELAY_MS)
        .filter(|time| valid_time(*time))
        .ok_or(PartnerError::TimeOverflow)?;
    let active_mono = now_mono
        .checked_add(PARTNER_ACTIVATION_DELAY_MS as u64)
        .filter(|time| valid_mono(*time))
        .ok_or(PartnerError::TimeOverflow)?;
    let mut next = state.clone();
    next.pending_operations.clear();
    next.last_observed_at_ms = activation_wall;
    next.last_observed_mono_ms = Some(now_mono);
    for key in &mut next.public_keys {
        if key.activation_observed_at_ms.is_none() {
            key.added_at_ms = activation_wall;
            key.active_at_ms = active_at;
            key.added_mono_ms = Some(now_mono);
            key.active_mono_ms = Some(active_mono);
        }
    }
    debug_assert!(next.validate());
    Ok(next)
}

/** Record a genuine clock observation. Once the wall and monotonic boundaries
 * have both been reached, the paired proof remains active across restart. */
pub fn observe_at(state: &PartnerState, now: i64, now_mono: u64) -> PartnerResult<PartnerState> {
    checked_now(state, now, now_mono)?;
    let mut next = state.clone();
    next.prune(now, now_mono);
    for key in &mut next.public_keys {
        if key.activation_observed_at_ms.is_none() && key_is_active(key, now, now_mono) {
            key.activation_observed_at_ms = Some(now);
            key.activation_observed_mono_ms = Some(now_mono);
        }
    }
    next.last_observed_at_ms = now;
    next.last_observed_mono_ms = Some(now_mono);
    debug_assert!(next.validate());
    Ok(next)
}

pub fn add_public_key_at(
    state: &PartnerState,
    public_key: &str,
    now: i64,
    now_mono: u64,
) -> PartnerResult<PartnerState> {
    let observed = observe_at(state, now, now_mono)?;
    if !valid_public_key(public_key) {
        return Err(PartnerError::InvalidHex);
    }
    if observed
        .public_keys
        .iter()
        .any(|key| key.public_key == public_key)
    {
        // Re-registration never moves either activation boundary.
        return Ok(observed);
    }
    if observed.public_keys.len() >= MAX_KEYS {
        return Err(PartnerError::KeyLimit);
    }
    let active_at_ms = now
        .checked_add(PARTNER_ACTIVATION_DELAY_MS)
        .filter(|time| valid_time(*time))
        .ok_or(PartnerError::TimeOverflow)?;
    let active_mono_ms = now_mono
        .checked_add(PARTNER_ACTIVATION_DELAY_MS as u64)
        .filter(|time| valid_mono(*time))
        .ok_or(PartnerError::TimeOverflow)?;
    let mut next = observed;
    next.public_keys.push(PartnerPublicKey {
        public_key: public_key.into(),
        added_at_ms: now,
        active_at_ms,
        added_mono_ms: Some(now_mono),
        active_mono_ms: Some(active_mono_ms),
        activation_observed_at_ms: None,
        activation_observed_mono_ms: None,
    });
    Ok(next)
}

/** Secure random material for installations/operations. The daemon fills these
 * values; JS/UI callers never conjure timestamp identifiers instead. */
pub fn random_id() -> PartnerResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| PartnerError::RngUnavailable)?;
    Ok(encode_hex(&bytes))
}

/** Explicit offline keygen result: (PRIVATE signing key, PUBLIC verifying key).
 * Never add the first value to PartnerState, snapshots or event logs. */
pub fn generate_signing_material() -> PartnerResult<(String, String)> {
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|_| PartnerError::RngUnavailable)?;
    let signing = SigningKey::from_bytes(&secret);
    let verifying = signing.verifying_key();
    Ok((encode_hex(&secret), encode_hex(&verifying.to_bytes())))
}

pub fn has_active_key_at(state: &PartnerState, now: i64, now_mono: u64) -> bool {
    checked_now(state, now, now_mono).is_ok()
        && state
            .public_keys
            .iter()
            .any(|key| key_is_active(key, now, now_mono))
}

pub fn begin_operation_at(
    state: &PartnerState,
    arm_generation: &str,
    operation_id: &str,
    nonce: &str,
    now: i64,
    now_mono: u64,
    expires_at_ms: i64,
) -> PartnerResult<PartnerState> {
    checked_now(state, now, now_mono)?;
    if !valid_id(arm_generation) || !valid_id(operation_id) || !valid_id(nonce) {
        return Err(PartnerError::InvalidHex);
    }
    if !valid_time(expires_at_ms) || expires_at_ms <= now {
        return Err(PartnerError::Expired);
    }
    let lifetime = expires_at_ms - now;
    if lifetime > MAX_OPERATION_LIFETIME_MS {
        return Err(PartnerError::InvalidTime);
    }
    let expires_mono_ms = now_mono
        .checked_add(lifetime as u64)
        .filter(|time| valid_mono(*time))
        .ok_or(PartnerError::TimeOverflow)?;
    if !has_active_key_at(state, now, now_mono) {
        return Err(PartnerError::NoActiveKey);
    }
    if state
        .pending_operations
        .iter()
        .any(|operation| operation.operation_id == operation_id || operation.nonce == nonce)
        || state
            .spent_codes
            .iter()
            .any(|spent| spent.operation_id == operation_id)
    {
        return Err(PartnerError::DuplicateOperation);
    }
    let mut next = observe_at(state, now, now_mono)?;
    if next.pending_operations.len() >= MAX_OPERATIONS {
        return Err(PartnerError::OperationLimit);
    }
    next.pending_operations.push(PendingPartnerOperation {
        installation_id: state.installation_id.clone(),
        arm_generation: arm_generation.into(),
        operation_id: operation_id.into(),
        nonce: nonce.into(),
        expires_at_ms,
        expires_mono_ms: Some(expires_mono_ms),
    });
    debug_assert!(next.validate());
    Ok(next)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedPayload {
    version: u32,
    installation_id: String,
    arm_generation: String,
    operation_id: String,
    nonce: String,
    expires_at_ms: i64,
}

fn token_payload(operation: &PendingPartnerOperation, expires_at_ms: i64) -> SignedPayload {
    SignedPayload {
        version: 1,
        installation_id: operation.installation_id.clone(),
        arm_generation: operation.arm_generation.clone(),
        operation_id: operation.operation_id.clone(),
        nonce: operation.nonce.clone(),
        expires_at_ms,
    }
}

/** Partner-side offline helper. Random operation IDs/nonces are caller-owned;
 * predictable placeholders are not a substitute for secure random generation. */
pub fn sign_operation(
    operation: &PendingPartnerOperation,
    expires_at_ms: i64,
    signing_key: &SigningKey,
) -> PartnerResult<String> {
    if !valid_id(&operation.installation_id)
        || !valid_id(&operation.arm_generation)
        || !valid_id(&operation.operation_id)
        || !valid_id(&operation.nonce)
        || !valid_time(operation.expires_at_ms)
        || !operation.expires_mono_ms.is_some_and(valid_mono)
    {
        return Err(PartnerError::InvalidState);
    }
    if !valid_time(expires_at_ms) {
        return Err(PartnerError::InvalidTime);
    }
    if expires_at_ms > operation.expires_at_ms {
        return Err(PartnerError::ExpiryAfterOperation);
    }
    let payload = serde_json::to_vec(&token_payload(operation, expires_at_ms))
        .map_err(|_| PartnerError::MalformedCode)?;
    let signature: Signature = signing_key.sign(&payload);
    Ok(format!(
        "SBP1.{}.{}",
        encode_hex(&payload),
        encode_hex(&signature.to_bytes())
    ))
}

fn mapped_mono_expiry(operation: &PendingPartnerOperation, signed_expiry: i64) -> Option<u64> {
    let earlier = u64::try_from(operation.expires_at_ms.checked_sub(signed_expiry)?).ok()?;
    operation
        .expires_mono_ms?
        .checked_sub(earlier)
        // An earlier signed expiry can map below this runtime's zero.
        .or(Some(0))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAuthorization {
    pub state: PartnerState,
    pub arm_generation: String,
    pub operation_id: String,
}

pub fn redeem_operation_at(
    state: &PartnerState,
    token: &str,
    now: i64,
    now_mono: u64,
) -> PartnerResult<ReleaseAuthorization> {
    checked_now(state, now, now_mono)?;
    if token.len() > MAX_TOKEN_CHARS {
        return Err(PartnerError::MalformedCode);
    }
    let mut parts = token.split('.');
    let (Some(prefix), Some(payload_hex), Some(signature_hex), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(PartnerError::MalformedCode);
    };
    if prefix != "SBP1" || payload_hex.len() * 2 > MAX_TOKEN_CHARS {
        return Err(PartnerError::MalformedCode);
    }
    if payload_hex.len() % 2 != 0
        || payload_hex.is_empty()
        || !payload_hex
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(PartnerError::InvalidHex);
    }
    let payload_bytes = (0..payload_hex.len() / 2)
        .map(|index| {
            u8::from_str_radix(&payload_hex[index * 2..index * 2 + 2], 16)
                .map_err(|_| PartnerError::InvalidHex)
        })
        .collect::<PartnerResult<Vec<_>>>()?;
    let payload: SignedPayload =
        serde_json::from_slice(&payload_bytes).map_err(|_| PartnerError::MalformedCode)?;
    if payload.version != 1 || !valid_time(payload.expires_at_ms) {
        return Err(PartnerError::InvalidState);
    }
    if state
        .spent_codes
        .iter()
        .any(|spent| spent.operation_id == payload.operation_id || spent.signature == signature_hex)
    {
        return Err(PartnerError::Replay);
    }
    let Some(operation) = state
        .pending_operations
        .iter()
        .find(|operation| operation.operation_id == payload.operation_id)
        .cloned()
    else {
        return Err(PartnerError::UnknownOperation);
    };
    if payload.installation_id != state.installation_id
        || payload.installation_id != operation.installation_id
    {
        return Err(PartnerError::WrongInstallation);
    }
    if payload.arm_generation != operation.arm_generation {
        return Err(PartnerError::WrongArm);
    }
    if payload.nonce != operation.nonce {
        return Err(PartnerError::WrongNonce);
    }
    if payload.expires_at_ms > operation.expires_at_ms {
        return Err(PartnerError::WrongExpiry);
    }
    let mono_expiry =
        mapped_mono_expiry(&operation, payload.expires_at_ms).ok_or(PartnerError::InvalidState)?;
    if now >= payload.expires_at_ms
        || now >= operation.expires_at_ms
        || now_mono
            >= operation
                .expires_mono_ms
                .ok_or(PartnerError::InvalidState)?
        || now_mono >= mono_expiry
    {
        return Err(PartnerError::Expired);
    }
    let signature_bytes = decode_hex::<64>(signature_hex).map_err(|_| PartnerError::InvalidHex)?;
    let signature = Signature::from_bytes(&signature_bytes);
    let verified = state.public_keys.iter().any(|key| {
        if !key_is_active(key, now, now_mono) {
            return false;
        }
        decode_hex::<32>(&key.public_key)
            .ok()
            .and_then(|bytes| VerifyingKey::from_bytes(&bytes).ok())
            .is_some_and(|public| public.verify_strict(&payload_bytes, &signature).is_ok())
    });
    if !verified {
        return Err(PartnerError::BadSignature);
    }

    let mut next = observe_at(state, now, now_mono)?;
    next.pending_operations
        .retain(|pending| pending.operation_id != operation.operation_id);
    next.spent_codes.push(SpentPartnerCode {
        operation_id: operation.operation_id.clone(),
        signature: signature_hex.into(),
        expires_at_ms: operation.expires_at_ms,
    });
    next.prune(now, now_mono);
    debug_assert!(next.validate());
    Ok(ReleaseAuthorization {
        state: next,
        arm_generation: operation.arm_generation,
        operation_id: operation.operation_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;
    const NOW: i64 = 2 * DAY + 100_000;
    const MONO_ADD: u64 = 10_000;
    const MONO_NOW: u64 = MONO_ADD + (NOW - DAY) as u64;
    fn id(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }
    fn install() -> String {
        id(1)
    }
    fn arm() -> String {
        id(2)
    }
    fn operation() -> String {
        id(3)
    }
    fn nonce() -> String {
        id(4)
    }
    fn signing() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }
    fn other_signing() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32])
    }
    fn public(key: &SigningKey) -> String {
        encode_hex(&key.verifying_key().to_bytes())
    }
    fn initialized() -> PartnerState {
        rehydrate(&PartnerState::new(&install()).unwrap(), 0, 0).unwrap()
    }
    fn added() -> PartnerState {
        add_public_key_at(&initialized(), &public(&signing()), DAY, MONO_ADD).unwrap()
    }
    fn pending() -> PendingPartnerOperation {
        PendingPartnerOperation {
            installation_id: install(),
            arm_generation: arm(),
            operation_id: operation(),
            nonce: nonce(),
            expires_at_ms: NOW + 60_000,
            expires_mono_ms: Some(MONO_NOW + 60_000),
        }
    }
    fn ready() -> PartnerState {
        begin_operation_at(
            &added(),
            &arm(),
            &operation(),
            &nonce(),
            NOW,
            MONO_NOW,
            NOW + 60_000,
        )
        .unwrap()
    }
    fn token() -> String {
        sign_operation(&pending(), NOW + 60_000, &signing()).unwrap()
    }

    #[test]
    fn activation_requires_wall_and_elapsed_time_then_proof_survives_restart() {
        let added = added();
        assert_eq!(
            begin_operation_at(
                &added,
                &arm(),
                &operation(),
                &nonce(),
                DAY + DAY,
                MONO_ADD + 1,
                NOW + 60_000,
            ),
            Err(PartnerError::NoActiveKey),
            "a forward wall jump alone cannot activate"
        );
        assert_eq!(
            begin_operation_at(
                &added,
                &arm(),
                &operation(),
                &nonce(),
                DAY + DAY - 1,
                MONO_ADD + DAY as u64,
                NOW + 60_000,
            ),
            Err(PartnerError::NoActiveKey),
            "elapsed monotonic time without wall eligibility cannot activate"
        );
        let proven = observe_at(&added, DAY + DAY, MONO_ADD + DAY as u64).unwrap();
        assert!(proven.public_keys[0].activation_observed_at_ms.is_some());
        assert!(proven.public_keys[0].activation_observed_mono_ms.is_some());
        let restarted = rehydrate(&proven, DAY + DAY + 1, 5).unwrap();
        assert_eq!(restarted.public_keys, proven.public_keys);
        assert!(has_active_key_at(&restarted, DAY + DAY + 1, 5));
    }

    #[test]
    fn unproven_restart_and_legacy_migration_restart_a_full_delay() {
        let added = added();
        let old_wall_active = added.public_keys[0].active_at_ms;
        let restarted = rehydrate(&added, DAY + DAY - 1, 7).unwrap();
        assert_eq!(restarted.public_keys[0].added_at_ms, DAY + DAY - 1);
        assert_eq!(restarted.public_keys[0].active_at_ms, DAY + DAY - 1 + DAY);
        assert_eq!(restarted.public_keys[0].added_mono_ms, Some(7));
        assert_eq!(
            restarted.public_keys[0].active_mono_ms,
            Some(7 + DAY as u64)
        );
        assert!(!has_active_key_at(&restarted, old_wall_active + DAY, 8));

        let legacy_json = serde_json::json!({
            "version": 1,
            "installationId": install(),
            "publicKeys": [{
                "publicKey": public(&signing()),
                "addedAtMs": 0,
                "activeAtMs": DAY
            }],
            "pendingOperations": [],
            "spentCodes": [],
            "lastObservedAtMs": DAY * 2
        });
        let legacy: PartnerState = serde_json::from_value(legacy_json).unwrap();
        assert!(!legacy.validate());
        assert_eq!(
            add_public_key_at(&legacy, &public(&other_signing()), DAY * 3, 20),
            Err(PartnerError::InvalidState)
        );
        let migrated = rehydrate(&legacy, DAY * 3, 20).unwrap();
        assert_eq!(migrated.public_keys[0].added_at_ms, DAY * 3);
        assert_eq!(migrated.public_keys[0].active_at_ms, DAY * 4);
        assert_eq!(
            migrated.public_keys[0].active_mono_ms,
            Some(20 + DAY as u64)
        );
        assert!(!has_active_key_at(&migrated, DAY * 4, 21));
    }

    #[test]
    fn asymmetric_verification_observes_activation_at_exactly_24h() {
        let added = added();
        let duplicate =
            add_public_key_at(&added, &public(&signing()), DAY + 1000, MONO_ADD + 1000).unwrap();
        assert_eq!(duplicate.public_keys, added.public_keys);
        let operation = ready();
        assert!(operation.public_keys[0].activation_observed_at_ms.is_some());
        let release = redeem_operation_at(&operation, &token(), NOW + 1, MONO_NOW + 1).unwrap();
        assert_eq!(release.arm_generation, arm());
        assert!(release.state.pending_operations.is_empty());
    }

    #[test]
    fn wrong_key_payload_and_each_operation_binding_fail_without_mutation() {
        let state = ready();
        assert_eq!(
            redeem_operation_at(
                &state,
                &sign_operation(&pending(), NOW + 60_000, &other_signing()).unwrap(),
                NOW + 1,
                MONO_NOW + 1,
            ),
            Err(PartnerError::BadSignature)
        );
        for (change, expected) in [
            ("installation", PartnerError::WrongInstallation),
            ("arm", PartnerError::WrongArm),
            ("operation", PartnerError::UnknownOperation),
            ("nonce", PartnerError::WrongNonce),
        ] {
            let mut altered = pending();
            match change {
                "installation" => altered.installation_id = id(8),
                "arm" => altered.arm_generation = id(8),
                "operation" => altered.operation_id = id(8),
                _ => altered.nonce = id(8),
            }
            let signed = sign_operation(&altered, NOW + 60_000, &signing()).unwrap();
            assert_eq!(
                redeem_operation_at(&state, &signed, NOW + 1, MONO_NOW + 1),
                Err(expected)
            );
            assert_eq!(state, ready());
        }
    }

    #[test]
    fn wall_and_monotonic_expiry_rollback_and_forward_jumps_are_refused() {
        let state = ready();
        assert_eq!(
            redeem_operation_at(&state, &token(), NOW + 60_000, MONO_NOW + 1),
            Err(PartnerError::Expired)
        );
        assert_eq!(
            redeem_operation_at(&state, &token(), NOW, MONO_NOW + 60_000),
            Err(PartnerError::Expired),
            "rolling wall back to the operation start cannot undo elapsed expiry"
        );
        assert_eq!(
            redeem_operation_at(&state, &token(), NOW + 120_000, MONO_NOW + 60_000),
            Err(PartnerError::Expired),
            "a forward wall jump cannot extend an invalid monotonic operation"
        );
        assert_eq!(
            redeem_operation_at(&state, &token(), NOW - 1, MONO_NOW + 1),
            Err(PartnerError::ClockRollback)
        );
        let too_late = sign_operation(&pending(), NOW + 60_001, &signing());
        assert_eq!(too_late, Err(PartnerError::ExpiryAfterOperation));
    }

    #[test]
    fn earlier_signed_wall_expiry_maps_to_an_earlier_monotonic_deadline() {
        let state = ready();
        let earlier = sign_operation(&pending(), NOW + 30_000, &signing()).unwrap();
        assert_eq!(
            redeem_operation_at(&state, &earlier, NOW + 29_999, MONO_NOW + 30_000),
            Err(PartnerError::Expired)
        );
        assert!(redeem_operation_at(&state, &earlier, NOW + 29_999, MONO_NOW + 29_999).is_ok());
    }

    #[test]
    fn restart_deletes_unsigned_operations_but_preserves_proof_and_replay() {
        let released = redeem_operation_at(&ready(), &token(), NOW + 1, MONO_NOW + 1).unwrap();
        let with_new_pending = begin_operation_at(
            &released.state,
            &arm(),
            &id(10),
            &id(11),
            NOW + 2,
            MONO_NOW + 2,
            NOW + 60_002,
        )
        .unwrap();
        let restarted = rehydrate(&with_new_pending, NOW + 3, 4).unwrap();
        assert!(restarted.pending_operations.is_empty());
        assert_eq!(restarted.spent_codes, with_new_pending.spent_codes);
        assert_eq!(restarted.public_keys, with_new_pending.public_keys);
        assert!(has_active_key_at(&restarted, NOW + 3, 4));
        assert_eq!(
            redeem_operation_at(&restarted, &token(), NOW + 4, 5),
            Err(PartnerError::Replay)
        );
        let token_for_deleted_operation = sign_operation(
            &with_new_pending.pending_operations[0],
            NOW + 60_002,
            &signing(),
        )
        .unwrap();
        assert_eq!(
            redeem_operation_at(&restarted, &token_for_deleted_operation, NOW + 4, 5),
            Err(PartnerError::UnknownOperation)
        );
    }

    #[test]
    fn restart_after_expiry_and_wall_rollback_cannot_redeem_unsigned_operation() {
        let before_restart = ready();
        // The signed/wall expiry is still in the future at NOW, while the old
        // runtime's monotonic deadline has elapsed. Restart cannot carry that
        // Instant forward, so it fails closed by deleting the operation.
        let restarted = rehydrate(&before_restart, NOW, 0).unwrap();
        assert!(restarted.pending_operations.is_empty());
        assert_eq!(
            redeem_operation_at(&restarted, &token(), NOW, 0),
            Err(PartnerError::UnknownOperation)
        );
        assert!(restarted.public_keys[0].activation_observed_at_ms.is_some());
        assert!(restarted.public_keys[0]
            .activation_observed_mono_ms
            .is_some());
        assert_eq!(restarted.spent_codes, before_restart.spent_codes);
    }

    #[test]
    fn replay_remains_closed_after_serde_restart() {
        let released = redeem_operation_at(&ready(), &token(), NOW + 1, MONO_NOW + 1).unwrap();
        let encoded = serde_json::to_string(&released.state).unwrap();
        let decoded: PartnerState = serde_json::from_str(&encoded).unwrap();
        let restored = rehydrate(&decoded, NOW + 2, 2).unwrap();
        assert!(restored.validate());
        assert_eq!(
            redeem_operation_at(&restored, &token(), NOW + 3, 3),
            Err(PartnerError::Replay)
        );
        assert_eq!(
            begin_operation_at(
                &restored,
                &arm(),
                &operation(),
                &id(5),
                NOW + 4,
                4,
                NOW + 60_004,
            ),
            Err(PartnerError::DuplicateOperation)
        );
    }

    #[test]
    fn malformed_tokens_unknown_fields_and_bad_hex_never_verify() {
        let state = ready();
        for invalid in ["", "SBP1.x.y", "SBPRO1.a.b", "SBP1.00.00"] {
            assert!(redeem_operation_at(&state, invalid, NOW + 1, MONO_NOW + 1).is_err());
        }
        let valid = token();
        let mut parts = valid.split('.');
        let payload_hex = parts.nth(1).unwrap().to_string();
        let payload_bytes = (0..payload_hex.len() / 2)
            .map(|i| u8::from_str_radix(&payload_hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let mut json: serde_json::Value = serde_json::from_slice(&payload_bytes).unwrap();
        json["unexpected"] = serde_json::json!(true);
        let altered = format!(
            "SBP1.{}.{}",
            encode_hex(&serde_json::to_vec(&json).unwrap()),
            parts.next().unwrap()
        );
        assert_eq!(
            redeem_operation_at(&state, &altered, NOW + 1, MONO_NOW + 1),
            Err(PartnerError::MalformedCode)
        );
        let oversized = format!("SBP1.{}.{}", "00".repeat(3000), "00".repeat(64));
        assert_eq!(
            redeem_operation_at(&state, &oversized, NOW + 1, MONO_NOW + 1),
            Err(PartnerError::MalformedCode)
        );
    }

    #[test]
    fn live_replay_tombstones_survive_beyond_the_old_cap() {
        let mut state = added();
        for n in 0..300u64 {
            state.spent_codes.push(SpentPartnerCode {
                operation_id: format!("{n:064x}"),
                signature: format!("{n:0128x}"),
                expires_at_ms: NOW + 60_000,
            });
        }
        assert!(state.validate());
        let observed = observe_at(&state, NOW, MONO_NOW).unwrap();
        assert_eq!(
            observed.spent_codes.len(),
            300,
            "no unexpired replay tombstone is evicted"
        );
        let later = observe_at(&observed, NOW + 61_000, MONO_NOW + 61_000).unwrap();
        assert!(
            later.spent_codes.is_empty(),
            "expired tombstones are the only ones pruned"
        );
    }

    #[test]
    fn malformed_persistence_and_modified_inputs_cannot_authorize() {
        let state = ready();
        for alteration in [0u32, 2, 99] {
            let mut bad = state.clone();
            bad.version = alteration;
            assert!(!bad.validate());
            assert_eq!(
                redeem_operation_at(&bad, &token(), NOW + 1, MONO_NOW + 1),
                Err(PartnerError::InvalidState)
            );
        }
        let mut partial_proof = state.clone();
        partial_proof.public_keys[0].activation_observed_mono_ms = None;
        assert!(!partial_proof.validate());
        assert_eq!(
            rehydrate(&partial_proof, NOW + 1, 1),
            Err(PartnerError::InvalidState)
        );
        let mut duplicate_keys = state.clone();
        duplicate_keys
            .public_keys
            .push(duplicate_keys.public_keys[0].clone());
        assert!(!duplicate_keys.validate());
        let result = redeem_operation_at(&state, &token(), NOW + 1, MONO_NOW + 1).unwrap();
        assert_eq!(
            state,
            ready(),
            "successful pure transitions do not mutate inputs"
        );
        assert_eq!(result.state.spent_codes.len(), 1);
    }

    #[test]
    fn operation_limits_and_no_expedited_paths_hold() {
        let mut state = added();
        for n in 0..MAX_OPERATIONS {
            state = begin_operation_at(
                &state,
                &id((n + 10) as u8),
                &id((n + 20) as u8),
                &id((n + 30) as u8),
                NOW + n as i64,
                MONO_NOW + n as u64,
                NOW + 60_000,
            )
            .unwrap();
        }
        assert_eq!(
            begin_operation_at(
                &state,
                &id(99),
                &id(98),
                &id(97),
                NOW + 99,
                MONO_NOW + 99,
                NOW + 60_000,
            ),
            Err(PartnerError::OperationLimit)
        );
    }
}
