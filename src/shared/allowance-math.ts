// Pure per-category allowance/opening accounting. No browser APIs and no
// non-erasable TypeScript syntax: Node imports this file directly in
// scripts/allowance-math-test.mjs.
//
// The owner supplies both the wall clock and its local YYYY-MM-DD day key.
// This module deliberately knows nothing about time zones, persistence, or
// cross-browser coordination. A ledger models ONE category and transitions
// return new objects without mutating their inputs.

export const ALLOWANCE_LEDGER_VERSION = 1;
export const MAX_ALLOWANCE_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;
export const MAX_ALLOWANCE_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_DAILY_OPENINGS = 10_000;
export const DEFAULT_OPENING_INACTIVITY_MS = 120_000;
export const DEFAULT_OPENING_MAX_LIFETIME_MS = 30 * 60 * 1000;
/** Bounded productive-work reward defaults: 5 focused minutes -> 1 minute. */
export const DEFAULT_REWARD_WORK_MS = 5 * 60 * 1000;
export const DEFAULT_REWARD_AWARD_MS = 60 * 1000;
export const MIN_REWARD_RATIO_MS = 60 * 1000;
const EMPTY_DAY_KEY = '1970-01-01';

export type AllowanceGrantKind = 'allowance' | 'opening' | 'pomodoro';
export type AllowanceGrantStatus = 'pending' | 'active' | 'ended' | 'idle-closed';
export type AllowanceGrantEndReason =
  | 'waiting-cancelled'
  | 'early-cancelled'
  | 'expired'
  | 'idle'
  | 'explicit'
  | 'max-lifetime';

export interface AllowanceConfig {
  dailyAllowanceMs: number;
  dailyOpenings: number;
  waitingBaseMs: number;
  waitingStepMs: number;
  waitingMaxMs: number;
  rewardCapMs: number;
  /** Opt-in: productive work earns this category's daily reward pool. */
  rewardEarning?: boolean;
  /** Productive work that completes one reward unit. */
  rewardWorkMs?: number;
  /** Reward credited per completed work unit; normalized to <= rewardWorkMs. */
  rewardAwardMs?: number;
  /** Optional so existing settings get the specified two-minute default. */
  openingInactivityMs?: number;
  /** Optional fail-closed ceiling, independent of continuing activity. */
  openingMaxLifetimeMs?: number;
}

export interface NormalizedAllowanceConfig extends AllowanceConfig {
  rewardEarning: boolean;
  rewardWorkMs: number;
  rewardAwardMs: number;
  openingInactivityMs: number;
  openingMaxLifetimeMs: number;
}

export interface AllowanceGrant {
  id: string;
  kind: AllowanceGrantKind;
  status: AllowanceGrantStatus;
  requestedAtMs: number;
  /** Waiting ends and ordinary wall-clock charging starts at this instant. */
  notBeforeMs: number;
  /** Fixed ordinary/Pomodoro end, or the opening's maximum-lifetime ceiling. */
  endsAtMs: number;
  /** Reserved ordinary duration; maximum lifetime for an opening. */
  durationMs: number;
  endedAtMs: number | null;
  endReason: AllowanceGrantEndReason | null;
  /** Settled fields are diagnostic for ended ordinary grants. */
  chargedMs: number;
  refundedMs: number;
  /** Monotonic maximum observed activity; null outside openings. */
  lastActivityAtMs: number | null;
}

export interface AllowanceLedger {
  version: typeof ALLOWANCE_LEDGER_VERSION;
  dayKey: string;
  /** Expired/cancelled ordinary usage. Active elapsed time is derived. */
  spentMs: number;
  earnedRewardMs: number;
  openingsUsed: number;
  /** Accepted ordinary requests, including waiting-cancelled requests. */
  waitingEscalation: number;
  /** Maximum valid clock observation, including across day rollover. */
  lastObservedAtMs: number;
  grant: AllowanceGrant | null;
}

export interface AllowanceObservation {
  nowMs: number;
  dayKey: string;
}

export interface AllowanceGrantAction extends AllowanceObservation {
  grantId: string;
}

export interface AllowanceRequest extends AllowanceGrantAction {
  durationMs: number;
}

export interface RewardAddition extends AllowanceObservation {
  earnedMs: number;
}

export type AllowanceRefusalReason =
  | 'invalid-time'
  | 'invalid-day'
  | 'clock-rollback'
  | 'day-rollback'
  | 'invalid-grant-id'
  | 'invalid-duration'
  | 'invalid-reward'
  | 'time-overflow'
  | 'overlap'
  | 'allowance-exhausted'
  | 'no-openings'
  | 'grant-not-found'
  | 'wrong-grant-kind'
  | 'grant-ended';

export type AllowanceResult =
  | { ok: true; ledger: AllowanceLedger; grant: AllowanceGrant | null }
  | { ok: false; ledger: AllowanceLedger; reason: AllowanceRefusalReason };

export interface DerivedAllowance {
  dayKey: string;
  nowMs: number;
  totalAllowanceMs: number;
  /** Settled spent plus bounded active ordinary elapsed time. */
  consumedMs: number;
  activeElapsedMs: number;
  /** Pending full reservation, or active ordinary time still reserved. */
  reservedMs: number;
  /** Pool after consumption, before subtracting the active reservation. */
  remainingMs: number;
  /** Unspent and unreserved pool available to a future request. */
  availableMs: number;
  earnedRewardMs: number;
  openingsUsed: number;
  openingsRemaining: number;
  waitingEscalation: number;
  nextWaitingDelayMs: number;
  grant: AllowanceGrant | null;
}

export const DEFAULT_ALLOWANCE_CONFIG: NormalizedAllowanceConfig = {
  dailyAllowanceMs: 0,
  dailyOpenings: 0,
  waitingBaseMs: 0,
  waitingStepMs: 0,
  waitingMaxMs: 0,
  rewardCapMs: 0,
  rewardEarning: false,
  rewardWorkMs: DEFAULT_REWARD_WORK_MS,
  rewardAwardMs: DEFAULT_REWARD_AWARD_MS,
  openingInactivityMs: DEFAULT_OPENING_INACTIVITY_MS,
  openingMaxLifetimeMs: DEFAULT_OPENING_MAX_LIFETIME_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ALLOWANCE_TIMESTAMP_MS
  );
}

function boundedInteger(value: unknown, maximum: number, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function cleanDuration(value: unknown, fallback = 0): number {
  return boundedInteger(value, MAX_ALLOWANCE_DURATION_MS, fallback);
}

function cleanOpeningDuration(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, cleanDuration(value));
}

/** Whole milliseconds within [1 minute, 24 hours]; invalid/zero -> default. */
function cleanRewardDuration(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(
    MAX_ALLOWANCE_DURATION_MS,
    Math.max(MIN_REWARD_RATIO_MS, Math.floor(value)),
  );
}

function saturatingAdd(left: number, right: number): number {
  return left >= MAX_ALLOWANCE_TIMESTAMP_MS - right
    ? MAX_ALLOWANCE_TIMESTAMP_MS
    : left + right;
}

function safeAdd(left: number, right: number): number | null {
  const result = left + right;
  return isTimestamp(result) ? result : null;
}

function validDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

function validGrantId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim().length > 0;
}

function validKind(value: unknown): value is AllowanceGrantKind {
  return value === 'allowance' || value === 'opening' || value === 'pomodoro';
}

function validEndReason(value: unknown): value is AllowanceGrantEndReason {
  return (
    value === 'waiting-cancelled' ||
    value === 'early-cancelled' ||
    value === 'expired' ||
    value === 'idle' ||
    value === 'explicit' ||
    value === 'max-lifetime'
  );
}

export function normalizeAllowanceConfig(raw: unknown): NormalizedAllowanceConfig {
  const value = isRecord(raw) ? raw : {};
  const rewardWorkMs = cleanRewardDuration(value.rewardWorkMs, DEFAULT_REWARD_WORK_MS);
  const rewardAwardMs = Math.min(
    rewardWorkMs,
    cleanRewardDuration(value.rewardAwardMs, DEFAULT_REWARD_AWARD_MS),
  );
  return {
    dailyAllowanceMs: cleanDuration(value.dailyAllowanceMs),
    dailyOpenings: boundedInteger(value.dailyOpenings, MAX_DAILY_OPENINGS),
    waitingBaseMs: cleanDuration(value.waitingBaseMs),
    waitingStepMs: cleanDuration(value.waitingStepMs),
    waitingMaxMs: cleanDuration(value.waitingMaxMs),
    rewardCapMs: cleanDuration(value.rewardCapMs),
    rewardEarning: value.rewardEarning === true,
    rewardWorkMs,
    rewardAwardMs,
    openingInactivityMs: cleanOpeningDuration(
      value.openingInactivityMs,
      DEFAULT_OPENING_INACTIVITY_MS,
    ),
    openingMaxLifetimeMs: cleanOpeningDuration(
      value.openingMaxLifetimeMs,
      DEFAULT_OPENING_MAX_LIFETIME_MS,
    ),
  };
}

function waitingDelay(config: NormalizedAllowanceConfig, escalation: number): number {
  // Saturate before multiplying, so hostile persisted counters cannot overflow.
  const stepped =
    config.waitingStepMs > 0 && escalation > MAX_ALLOWANCE_DURATION_MS / config.waitingStepMs
      ? MAX_ALLOWANCE_DURATION_MS
      : escalation * config.waitingStepMs;
  return Math.min(config.waitingMaxMs, config.waitingBaseMs + stepped);
}

function freshLedger(dayKey: string, lastObservedAtMs: number): AllowanceLedger {
  return {
    version: ALLOWANCE_LEDGER_VERSION,
    dayKey,
    spentMs: 0,
    earnedRewardMs: 0,
    openingsUsed: 0,
    waitingEscalation: 0,
    lastObservedAtMs,
    grant: null,
  };
}

export function createEmptyAllowanceLedger(at: AllowanceObservation): AllowanceLedger {
  const dayKey = validDayKey(at?.dayKey) ? at.dayKey : EMPTY_DAY_KEY;
  const lastObservedAtMs = isTimestamp(at?.nowMs) ? at.nowMs : 0;
  return freshLedger(dayKey, lastObservedAtMs);
}

function sanitizeGrant(raw: unknown, nowMs: number): AllowanceGrant | null {
  if (!isRecord(raw) || !validGrantId(raw.id) || !validKind(raw.kind)) return null;
  const validStatus =
    raw.status === 'ended' ||
    (raw.kind === 'allowance'
      ? raw.status === 'pending' || raw.status === 'active'
      : raw.kind === 'opening'
        ? raw.status === 'active' || raw.status === 'idle-closed'
        : raw.status === 'active');
  // Never reconstruct an unknown/mismatched status into a live grant: doing
  // so could expire it again and double-settle an already charged reservation.
  if (!validStatus) return null;
  if (!isTimestamp(raw.notBeforeMs) || !isTimestamp(raw.endsAtMs)) return null;
  const notBeforeMs = raw.notBeforeMs;
  const endsAtMs = raw.endsAtMs;
  const durationMs = endsAtMs - notBeforeMs;
  if (durationMs <= 0 || durationMs > MAX_ALLOWANCE_DURATION_MS) return null;
  const requestedAtMs = isTimestamp(raw.requestedAtMs)
    ? Math.min(raw.requestedAtMs, notBeforeMs)
    : notBeforeMs;
  const lastActivityAtMs =
    raw.kind === 'opening'
      ? Math.min(
          endsAtMs,
          Math.max(
            notBeforeMs,
            isTimestamp(raw.lastActivityAtMs) ? Math.min(raw.lastActivityAtMs, nowMs) : notBeforeMs,
          ),
        )
      : null;
  const ended = raw.status === 'ended' || raw.status === 'idle-closed';
  const status: AllowanceGrantStatus = ended
    ? raw.status === 'idle-closed' && raw.kind === 'opening'
      ? 'idle-closed'
      : 'ended'
    : raw.kind === 'allowance' && nowMs < notBeforeMs
      ? 'pending'
      : 'active';
  const endReason = ended
    ? status === 'idle-closed'
      ? 'idle'
      : validEndReason(raw.endReason)
        ? raw.endReason
        : 'expired'
    : null;
  const endedAtMs = ended
    ? Math.min(
        endsAtMs,
        Math.max(
          requestedAtMs,
          isTimestamp(raw.endedAtMs) ? raw.endedAtMs : endsAtMs,
        ),
      )
    : null;
  let chargedMs = 0;
  if (raw.kind === 'allowance' && ended) {
    chargedMs =
      endReason === 'expired'
        ? durationMs
        : endReason === 'waiting-cancelled'
          ? 0
          : boundedInteger(raw.chargedMs, durationMs);
  }
  return {
    id: raw.id,
    kind: raw.kind,
    status,
    requestedAtMs,
    notBeforeMs,
    endsAtMs,
    durationMs,
    endedAtMs,
    endReason,
    chargedMs,
    refundedMs: raw.kind === 'allowance' && ended ? durationMs - chargedMs : 0,
    lastActivityAtMs,
  };
}

function cloneGrant(grant: AllowanceGrant): AllowanceGrant {
  return { ...grant };
}

/**
 * Sanitize untrusted persistence and advance deterministic time transitions.
 * Forward day keys reset all daily counters / grants; backward keys do not.
 * Backward clocks use lastObservedAtMs, so no elapsed interval becomes negative.
 */
export function normalizeAllowanceLedger(
  raw: unknown,
  rawConfig: AllowanceConfig,
  at: AllowanceObservation,
): AllowanceLedger {
  const config = normalizeAllowanceConfig(rawConfig);
  const suppliedNow = isTimestamp(at?.nowMs) ? at.nowMs : null;
  const suppliedDay = validDayKey(at?.dayKey) ? at.dayKey : null;
  if (!isRecord(raw) || !validDayKey(raw.dayKey)) {
    return freshLedger(suppliedDay ?? EMPTY_DAY_KEY, suppliedNow ?? 0);
  }

  const storedDay = raw.dayKey;
  const priorObserved = boundedInteger(raw.lastObservedAtMs, MAX_ALLOWANCE_TIMESTAMP_MS);
  // A forward day string is not enough to reset pools when its clock is stale
  // or invalid. Wait for an unambiguous non-rollback observation instead.
  const mayAdvanceDay = suppliedNow !== null && suppliedNow >= priorObserved;
  const dayKey =
    suppliedDay !== null && suppliedDay > storedDay && mayAdvanceDay ? suppliedDay : storedDay;
  const nowMs = suppliedNow === null ? priorObserved : Math.max(priorObserved, suppliedNow);
  if (dayKey !== storedDay) return freshLedger(dayKey, nowMs);

  const ledger: AllowanceLedger = {
    version: ALLOWANCE_LEDGER_VERSION,
    dayKey,
    spentMs: boundedInteger(raw.spentMs, MAX_ALLOWANCE_TIMESTAMP_MS),
    // Finite is not necessarily safe: clamping MAX_VALUE to MAX_SAFE_INTEGER
    // here would manufacture a full reward. Invalid persistence earns nothing.
    earnedRewardMs: isTimestamp(raw.earnedRewardMs)
      ? Math.min(config.rewardCapMs, raw.earnedRewardMs)
      : 0,
    openingsUsed: boundedInteger(raw.openingsUsed, MAX_ALLOWANCE_TIMESTAMP_MS),
    waitingEscalation: boundedInteger(raw.waitingEscalation, MAX_ALLOWANCE_TIMESTAMP_MS),
    lastObservedAtMs: nowMs,
    grant: sanitizeGrant(raw.grant, nowMs),
  };

  let grant = ledger.grant;
  if (grant === null || grant.status === 'ended' || grant.status === 'idle-closed') return ledger;

  if (grant.kind === 'allowance') {
    if (nowMs >= grant.endsAtMs) {
      // Status is the settlement marker. Once ended, later normalization never
      // adds this reservation again, even when it had still been pending.
      ledger.spentMs = saturatingAdd(ledger.spentMs, grant.durationMs);
      grant = {
        ...grant,
        status: 'ended',
        endedAtMs: grant.endsAtMs,
        endReason: 'expired',
        chargedMs: grant.durationMs,
        refundedMs: 0,
      };
    } else if (nowMs >= grant.notBeforeMs && grant.status !== 'active') {
      grant = { ...grant, status: 'active' };
    }
  } else if (grant.kind === 'pomodoro') {
    if (nowMs >= grant.endsAtMs) {
      grant = { ...grant, status: 'ended', endedAtMs: grant.endsAtMs, endReason: 'expired' };
    }
  } else {
    const activityAt = grant.lastActivityAtMs ?? grant.notBeforeMs;
    if (nowMs >= grant.endsAtMs) {
      grant = {
        ...grant,
        status: 'ended',
        endedAtMs: grant.endsAtMs,
        endReason: 'max-lifetime',
      };
    } else if (nowMs >= activityAt && nowMs - activityAt >= config.openingInactivityMs) {
      grant = {
        ...grant,
        status: 'idle-closed',
        endedAtMs: activityAt + config.openingInactivityMs,
        endReason: 'idle',
      };
    }
  }
  ledger.grant = grant;
  return ledger;
}

export function deriveAllowance(
  raw: unknown,
  configInput: AllowanceConfig,
  at: AllowanceObservation,
): DerivedAllowance {
  const config = normalizeAllowanceConfig(configInput);
  const ledger = normalizeAllowanceLedger(raw, config, at);
  const totalAllowanceMs = config.dailyAllowanceMs + ledger.earnedRewardMs;
  let activeElapsedMs = 0;
  let reservedMs = 0;
  if (ledger.grant?.kind === 'allowance') {
    if (ledger.grant.status === 'active') {
      activeElapsedMs = Math.min(
        ledger.grant.durationMs,
        Math.max(0, ledger.lastObservedAtMs - ledger.grant.notBeforeMs),
      );
      reservedMs = ledger.grant.endsAtMs - ledger.lastObservedAtMs;
    } else if (ledger.grant.status === 'pending') {
      reservedMs = ledger.grant.durationMs;
    }
  }
  const consumedMs = saturatingAdd(ledger.spentMs, activeElapsedMs);
  const remainingMs = Math.max(0, totalAllowanceMs - consumedMs);
  return {
    dayKey: ledger.dayKey,
    nowMs: ledger.lastObservedAtMs,
    totalAllowanceMs,
    consumedMs,
    activeElapsedMs,
    reservedMs,
    remainingMs,
    availableMs: Math.max(0, remainingMs - reservedMs),
    earnedRewardMs: ledger.earnedRewardMs,
    openingsUsed: ledger.openingsUsed,
    openingsRemaining: Math.max(0, config.dailyOpenings - ledger.openingsUsed),
    waitingEscalation: ledger.waitingEscalation,
    nextWaitingDelayMs: waitingDelay(config, ledger.waitingEscalation),
    grant: ledger.grant === null ? null : cloneGrant(ledger.grant),
  };
}

interface Prepared {
  config: NormalizedAllowanceConfig;
  ledger: AllowanceLedger;
  refusal: AllowanceRefusalReason | null;
}

function prepare(raw: unknown, config: AllowanceConfig, at: AllowanceObservation): Prepared {
  const cleanConfig = normalizeAllowanceConfig(config);
  const ledger = normalizeAllowanceLedger(raw, cleanConfig, at);
  let refusal: AllowanceRefusalReason | null = null;
  if (!isTimestamp(at?.nowMs)) refusal = 'invalid-time';
  else if (!validDayKey(at?.dayKey)) refusal = 'invalid-day';
  else if (at.dayKey < ledger.dayKey) refusal = 'day-rollback';
  else if (at.nowMs < ledger.lastObservedAtMs) refusal = 'clock-rollback';
  return { config: cleanConfig, ledger, refusal };
}

function success(ledger: AllowanceLedger): AllowanceResult {
  return { ok: true, ledger, grant: ledger.grant === null ? null : cloneGrant(ledger.grant) };
}

function refusal(ledger: AllowanceLedger, reason: AllowanceRefusalReason): AllowanceResult {
  return { ok: false, ledger, reason };
}

function liveGrant(ledger: AllowanceLedger): AllowanceGrant | null {
  return ledger.grant !== null && ledger.grant.status !== 'ended' && ledger.grant.status !== 'idle-closed'
    ? ledger.grant
    : null;
}

function findGrant(
  ledger: AllowanceLedger,
  action: AllowanceGrantAction,
  kind: AllowanceGrantKind,
): AllowanceResult | AllowanceGrant {
  if (!validGrantId(action.grantId)) return refusal(ledger, 'invalid-grant-id');
  if (ledger.grant === null || ledger.grant.id !== action.grantId) {
    return refusal(ledger, 'grant-not-found');
  }
  if (ledger.grant.kind !== kind) return refusal(ledger, 'wrong-grant-kind');
  if (ledger.grant.status === 'ended' || ledger.grant.status === 'idle-closed') {
    return refusal(ledger, 'grant-ended');
  }
  return ledger.grant;
}

function isGrant(value: AllowanceResult | AllowanceGrant): value is AllowanceGrant {
  return !('ok' in value);
}

export function requestAllowance(
  raw: unknown,
  configInput: AllowanceConfig,
  request: AllowanceRequest,
): AllowanceResult {
  const prepared = prepare(raw, configInput, request);
  const { ledger, config } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  if (!validGrantId(request.grantId)) return refusal(ledger, 'invalid-grant-id');
  if (!isTimestamp(request.durationMs) || request.durationMs <= 0) {
    return refusal(ledger, 'invalid-duration');
  }
  if (liveGrant(ledger) !== null) return refusal(ledger, 'overlap');
  const availableMs = deriveAllowance(ledger, config, request).availableMs;
  if (availableMs <= 0) return refusal(ledger, 'allowance-exhausted');

  const durationMs = Math.min(request.durationMs, availableMs, MAX_ALLOWANCE_DURATION_MS);
  const delayMs = waitingDelay(config, ledger.waitingEscalation);
  const notBeforeMs = safeAdd(request.nowMs, delayMs);
  const endsAtMs = notBeforeMs === null ? null : safeAdd(notBeforeMs, durationMs);
  if (notBeforeMs === null || endsAtMs === null) return refusal(ledger, 'time-overflow');
  ledger.waitingEscalation = boundedInteger(
    ledger.waitingEscalation + 1,
    MAX_ALLOWANCE_TIMESTAMP_MS,
  );
  ledger.grant = {
    id: request.grantId,
    kind: 'allowance',
    status: delayMs === 0 ? 'active' : 'pending',
    requestedAtMs: request.nowMs,
    notBeforeMs,
    endsAtMs,
    durationMs,
    endedAtMs: null,
    endReason: null,
    chargedMs: 0,
    refundedMs: 0,
    lastActivityAtMs: null,
  };
  return success(ledger);
}

export function cancelAllowanceGrant(
  raw: unknown,
  config: AllowanceConfig,
  action: AllowanceGrantAction,
): AllowanceResult {
  const prepared = prepare(raw, config, action);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  const found = findGrant(ledger, action, 'allowance');
  if (!isGrant(found)) return found;

  const elapsedMs =
    found.status === 'active'
      ? Math.min(found.durationMs, Math.max(0, action.nowMs - found.notBeforeMs))
      : 0;
  ledger.spentMs = saturatingAdd(ledger.spentMs, elapsedMs);
  ledger.grant = {
    ...found,
    status: 'ended',
    endedAtMs: action.nowMs,
    endReason: found.status === 'pending' ? 'waiting-cancelled' : 'early-cancelled',
    chargedMs: elapsedMs,
    refundedMs: found.durationMs - elapsedMs,
  };
  // Deliberately no escalation decrement and no waiting-clock adjustment.
  return success(ledger);
}

export function addReward(
  raw: unknown,
  config: AllowanceConfig,
  addition: RewardAddition,
): AllowanceResult {
  const prepared = prepare(raw, config, addition);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  if (!isTimestamp(addition.earnedMs) || addition.earnedMs <= 0) {
    return refusal(ledger, 'invalid-reward');
  }
  const creditedMs = Math.min(
    addition.earnedMs,
    Math.max(0, prepared.config.rewardCapMs - ledger.earnedRewardMs),
  );
  ledger.earnedRewardMs += creditedMs;
  return success(ledger);
}

export function startOpening(
  raw: unknown,
  config: AllowanceConfig,
  action: AllowanceGrantAction,
): AllowanceResult {
  const prepared = prepare(raw, config, action);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  if (!validGrantId(action.grantId)) return refusal(ledger, 'invalid-grant-id');
  if (liveGrant(ledger) !== null) return refusal(ledger, 'overlap');
  if (ledger.openingsUsed >= prepared.config.dailyOpenings) return refusal(ledger, 'no-openings');
  const durationMs = prepared.config.openingMaxLifetimeMs;
  const endsAtMs = safeAdd(action.nowMs, durationMs);
  if (endsAtMs === null) return refusal(ledger, 'time-overflow');

  ledger.openingsUsed += 1;
  ledger.grant = {
    id: action.grantId,
    kind: 'opening',
    status: 'active',
    requestedAtMs: action.nowMs,
    notBeforeMs: action.nowMs,
    endsAtMs,
    durationMs,
    endedAtMs: null,
    endReason: null,
    chargedMs: 0,
    refundedMs: 0,
    lastActivityAtMs: action.nowMs,
  };
  // No allowance spent/reserved and no waiting escalation.
  return success(ledger);
}

export function recordOpeningActivity(
  raw: unknown,
  config: AllowanceConfig,
  action: AllowanceGrantAction,
): AllowanceResult {
  const prepared = prepare(raw, config, action);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  const found = findGrant(ledger, action, 'opening');
  if (!isGrant(found)) return found;
  ledger.grant = {
    ...found,
    lastActivityAtMs: Math.max(found.lastActivityAtMs ?? 0, action.nowMs),
  };
  return success(ledger);
}

export function closeOpening(
  raw: unknown,
  config: AllowanceConfig,
  action: AllowanceGrantAction,
): AllowanceResult {
  const prepared = prepare(raw, config, action);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  const found = findGrant(ledger, action, 'opening');
  if (!isGrant(found)) return found;
  ledger.grant = {
    ...found,
    status: 'ended',
    endedAtMs: action.nowMs,
    endReason: 'explicit',
  };
  // Explicit close consumes the opening just as idle/max-lifetime close does.
  return success(ledger);
}

export function startPomodoro(
  raw: unknown,
  config: AllowanceConfig,
  request: AllowanceRequest,
): AllowanceResult {
  const prepared = prepare(raw, config, request);
  const { ledger } = prepared;
  if (prepared.refusal !== null) return refusal(ledger, prepared.refusal);
  if (!validGrantId(request.grantId)) return refusal(ledger, 'invalid-grant-id');
  if (!isTimestamp(request.durationMs) || request.durationMs <= 0) {
    return refusal(ledger, 'invalid-duration');
  }
  if (liveGrant(ledger) !== null) return refusal(ledger, 'overlap');
  const durationMs = Math.min(request.durationMs, MAX_ALLOWANCE_DURATION_MS);
  const endsAtMs = safeAdd(request.nowMs, durationMs);
  if (endsAtMs === null) return refusal(ledger, 'time-overflow');
  ledger.grant = {
    id: request.grantId,
    kind: 'pomodoro',
    status: 'active',
    requestedAtMs: request.nowMs,
    notBeforeMs: request.nowMs,
    endsAtMs,
    durationMs,
    endedAtMs: null,
    endReason: null,
    chargedMs: 0,
    refundedMs: 0,
    lastActivityAtMs: null,
  };
  // Programmed fixed-end relief spends neither pool nor opening count.
  return success(ledger);
}
