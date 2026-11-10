// Pure, browser-independent reward accrual. Keep this module
// erasable-syntax-only: scripts/reward-accrual-test.mjs imports it with Node's
// native TypeScript stripping.
//
// Productive work earns reward only in bounded wall-clock checkpoints. A
// checkpoint closes the PREVIOUS segment, so switching tabs or going idle
// cannot credit the gap to the page that happens to be in front afterwards.
// The actual balance change is still an authoritative `reward` command; this
// module computes a bounded, retry-safe command intent, never a balance.

export const REWARD_ACCRUAL_VERSION = 1;
export const REWARD_ACCRUAL_STORAGE_KEY = 'rewardAccrual:v1';
/** Same conservative stale-gap bound as the usage tracker. */
export const REWARD_MAX_CHECKPOINT_GAP_MS = 135_000;
export const REWARD_MAX_CATEGORIES = 64;
export const REWARD_MAX_PROGRESS_MS = 24 * 60 * 60 * 1000;
const EMPTY_DAY_KEY = '1970-01-01';

export type RewardEarningReason =
  | 'earning'
  | 'disabled'
  | 'not-locked'
  | 'break'
  | 'focus-cycle'
  | 'idle'
  | 'unfocused'
  | 'not-productive'
  | 'relief'
  | 'unconfigured'
  | 'cap-reached'
  | 'unavailable'
  | 'unknown';

export interface RewardEarningConfig {
  /** Productive work that completes one award unit. */
  workMs: number;
  /** Authoritative reward requested per completed unit (never above workMs). */
  awardMs: number;
  /** Daily cap remaining at this observation, per authority. */
  remainingCapMs: number;
}

export interface PendingRewardAward {
  operationId: string;
  category: string;
  dayKey: string;
  nowMs: number;
  earnedMs: number;
  consumedWorkMs: number;
}

export interface RewardCategoryProgress {
  dayKey: string;
  /** Productive work since the last completed award. */
  progressMs: number;
  pending: PendingRewardAward | null;
}

export interface RewardCheckpoint {
  atMs: number;
  /** Categories that were earning up to this boundary. */
  categories: string[];
}

export interface RewardAccrualState {
  version: typeof REWARD_ACCRUAL_VERSION;
  /** Stable install-local id used for deterministic award operation ids. */
  deviceId: string;
  nextAwardOrdinal: number;
  categories: Record<string, RewardCategoryProgress>;
  checkpoint: RewardCheckpoint | null;
}

export interface RewardCheckpointInput {
  atMs: number;
  dayKey: string;
  /** Categories earning right now. Empty is a valid "not earning" boundary. */
  categories: string[];
  /** Configs for every opt-in category, including the one that just ended. */
  configs: Record<string, RewardEarningConfig>;
  /** Startup/focus/idle recovery must not charge the preceding gap. */
  discardPrevious: boolean;
}

export interface RewardTransitionResult {
  state: RewardAccrualState;
  /** Newly persisted intents; the caller submits each through authority. */
  awards: PendingRewardAward[];
}

export interface RewardProgressView {
  category: string;
  dayKey: string;
  progressMs: number;
  workMs: number;
  awardMs: number;
  pending: boolean;
}

export interface RewardAccrualStatus {
  reason: RewardEarningReason;
  earning: boolean;
  checkpointAtMs: number | null;
  progress: RewardProgressView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Define rather than assign so a category such as "__proto__" stays data. */
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function boundedInteger(value: unknown, maximum: number, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isPositiveTimestamp(value: unknown): value is number {
  return isTimestamp(value) && value > 0;
}

export function validRewardDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

export function localRewardDayKey(at: number): string {
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function validRewardCategory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    value.trim() === value
  );
}

export function validRewardOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,64}$/.test(value);
}

function validConfig(value: unknown): value is RewardEarningConfig {
  if (!isRecord(value)) return false;
  return (
    isPositiveTimestamp(value.workMs) &&
    isPositiveTimestamp(value.awardMs) &&
    value.awardMs <= value.workMs &&
    typeof value.remainingCapMs === 'number' &&
    Number.isSafeInteger(value.remainingCapMs) &&
    value.remainingCapMs >= 0
  );
}

function sanitizePending(raw: unknown, category: string): PendingRewardAward | null {
  if (!isRecord(raw)) return null;
  if (
    !validRewardOperationId(raw.operationId) ||
    raw.category !== category ||
    !validRewardDayKey(raw.dayKey) ||
    !isPositiveTimestamp(raw.nowMs) ||
    !isPositiveTimestamp(raw.earnedMs) ||
    !isPositiveTimestamp(raw.consumedWorkMs) ||
    raw.consumedWorkMs > REWARD_MAX_PROGRESS_MS
  ) {
    return null;
  }
  return {
    operationId: raw.operationId,
    category,
    dayKey: raw.dayKey,
    nowMs: raw.nowMs,
    earnedMs: raw.earnedMs,
    consumedWorkMs: raw.consumedWorkMs,
  };
}

export function createEmptyRewardAccrualState(deviceId: string): RewardAccrualState {
  return {
    version: REWARD_ACCRUAL_VERSION,
    deviceId: validRewardOperationId(deviceId) && deviceId.length === 32 ? deviceId : '0'.repeat(32),
    nextAwardOrdinal: 0,
    categories: {},
    checkpoint: null,
  };
}

export function cloneRewardAccrualState(state: RewardAccrualState): RewardAccrualState {
  return {
    version: REWARD_ACCRUAL_VERSION,
    deviceId: state.deviceId,
    nextAwardOrdinal: state.nextAwardOrdinal,
    categories: Object.fromEntries(
      Object.entries(state.categories).map(([category, entry]) => [
        category,
        {
          dayKey: entry.dayKey,
          progressMs: entry.progressMs,
          pending: entry.pending ? { ...entry.pending } : null,
        },
      ]),
    ),
    checkpoint: state.checkpoint
      ? { atMs: state.checkpoint.atMs, categories: [...state.checkpoint.categories] }
      : null,
  };
}

/** Sanitize untrusted persistence into a bounded, retry-safe shape. */
export function sanitizeRewardAccrualState(
  raw: unknown,
  fallbackDeviceId: string,
): RewardAccrualState {
  const empty = createEmptyRewardAccrualState(fallbackDeviceId);
  if (!isRecord(raw) || raw.version !== REWARD_ACCRUAL_VERSION) return empty;
  const state = empty;
  state.deviceId =
    validRewardOperationId(raw.deviceId) && raw.deviceId.length === 32
      ? raw.deviceId
      : empty.deviceId;
  state.nextAwardOrdinal = boundedInteger(raw.nextAwardOrdinal, Number.MAX_SAFE_INTEGER);
  const rawCategories = isRecord(raw.categories) ? raw.categories : {};
  const seenPending = new Set<string>();
  let categoryCount = 0;
  for (const [category, value] of Object.entries(rawCategories)) {
    if (categoryCount >= REWARD_MAX_CATEGORIES) break;
    if (!validRewardCategory(category) || !isRecord(value) || !validRewardDayKey(value.dayKey)) {
      continue;
    }
    const pending = sanitizePending(value.pending, category);
    if (pending) {
      if (seenPending.has(pending.operationId)) continue;
      seenPending.add(pending.operationId);
    }
    put(state.categories, category, {
      dayKey: value.dayKey,
      progressMs: boundedInteger(value.progressMs, REWARD_MAX_PROGRESS_MS),
      pending,
    });
    categoryCount += 1;
  }
  if (isRecord(raw.checkpoint) && isTimestamp(raw.checkpoint.atMs)) {
    const categories: string[] = [];
    for (const category of Array.isArray(raw.checkpoint.categories)
      ? raw.checkpoint.categories
      : []) {
      if (validRewardCategory(category) && !categories.includes(category)) categories.push(category);
      if (categories.length >= REWARD_MAX_CATEGORIES) break;
    }
    state.checkpoint = { atMs: raw.checkpoint.atMs, categories };
  }
  return state;
}

function ordinalToken(value: number): string {
  return Math.max(0, Math.floor(value)).toString(16).padStart(16, '0').slice(-16);
}

function operationIdFor(state: RewardAccrualState): string {
  // deviceId is 32 hex; 32 + 16 = 48 lowercase hex, inside the authority's
  // accepted 32..64 range. The ordinal is persisted WITH the pending intent,
  // so a crash/retry reuses the exact same id and fingerprint.
  return `${state.deviceId}${ordinalToken(state.nextAwardOrdinal)}`;
}

function sameCategories(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function pendingRewardAwards(state: RewardAccrualState): PendingRewardAward[] {
  return Object.values(state.categories)
    .map((entry) => entry.pending)
    .filter((award): award is PendingRewardAward => award !== null)
    .map((award) => ({ ...award }));
}

/**
 * Close the preceding productive segment and install the next boundary.
 *
 * `discardPrevious` (startup, idle, API loss) charges nothing before `atMs`.
 * A gap beyond REWARD_MAX_CHECKPOINT_GAP_MS is discarded in full, so a late
 * alarm cannot manufacture a capped tail of productive time. A local day
 * change resets the progress remainder; work does not carry across midnight.
 * Awards are stored as pending intents, and only one may be in flight per
 * category, so repeated checkpoints cannot double-count the same work.
 */
export function transitionRewardCheckpoint(
  state: RewardAccrualState,
  input: RewardCheckpointInput,
): RewardTransitionResult {
  if (
    !isPositiveTimestamp(input.atMs) ||
    !validRewardDayKey(input.dayKey) ||
    !Array.isArray(input.categories) ||
    !isRecord(input.configs)
  ) {
    return { state, awards: [] };
  }
  const next = cloneRewardAccrualState(state);
  const configs: Record<string, RewardEarningConfig> = {};
  for (const [category, config] of Object.entries(input.configs)) {
    if (validRewardCategory(category) && validConfig(config)) {
      put(configs, category, {
        workMs: config.workMs,
        awardMs: config.awardMs,
        remainingCapMs: config.remainingCapMs,
      });
    }
  }
  const current: string[] = [];
  for (const category of input.categories) {
    if (validRewardCategory(category) && configs[category] && !current.includes(category)) {
      current.push(category);
    }
  }

  const previous = next.checkpoint;
  const elapsedMs =
    previous !== null &&
    !input.discardPrevious &&
    input.atMs > previous.atMs &&
    input.atMs - previous.atMs <= REWARD_MAX_CHECKPOINT_GAP_MS
      ? input.atMs - previous.atMs
      : 0;

  // Install current entries first and reset a stale local day. Resetting
  // before adding elapsed time is what makes a midnight crossing safe.
  for (const category of current) {
    const existing = next.categories[category];
    if (!existing) {
      put(next.categories, category, { dayKey: input.dayKey, progressMs: 0, pending: null });
    } else if (existing.dayKey < input.dayKey) {
      existing.dayKey = input.dayKey;
      existing.progressMs = 0;
    }
  }

  // Credit the segment to the categories that were earning when it STARTED.
  // `configs` includes categories no longer in front, so a tab switch still
  // settles the page the user actually worked on.
  if (elapsedMs > 0 && previous) {
    for (const category of previous.categories) {
      const config = configs[category];
      const entry = next.categories[category];
      if (!config || !entry || entry.dayKey !== input.dayKey) continue;
      entry.progressMs = Math.min(
        REWARD_MAX_PROGRESS_MS,
        entry.progressMs + elapsedMs,
      );
    }
  }

  next.checkpoint = { atMs: input.atMs, categories: current };

  const awards: PendingRewardAward[] = [];
  for (const [category, entry] of Object.entries(next.categories)) {
    const config = configs[category];
    if (!config || entry.pending || entry.dayKey !== input.dayKey) continue;
    if (entry.progressMs < config.workMs || config.remainingCapMs <= 0) continue;
    const units = Math.floor(entry.progressMs / config.workMs);
    const consumedWorkMs = units * config.workMs;
    if (!Number.isSafeInteger(consumedWorkMs) || consumedWorkMs <= 0) continue;
    const earnedMs = Math.min(units * config.awardMs, config.remainingCapMs);
    if (!isPositiveTimestamp(earnedMs)) continue;
    const pending: PendingRewardAward = {
      operationId: operationIdFor(next),
      category,
      dayKey: entry.dayKey,
      nowMs: input.atMs,
      earnedMs,
      consumedWorkMs,
    };
    next.nextAwardOrdinal = Math.min(Number.MAX_SAFE_INTEGER, next.nextAwardOrdinal + 1);
    entry.pending = pending;
    awards.push({ ...pending });
  }
  return { state: next, awards };
}

/**
 * True only for a real, confident classifier allow. Whitelisted pages have no
 * classifier verdict and are deliberately excluded; so are overrides,
 * browsing containers, blocked/fail-closed pages, and weak verdicts below the
 * configured threshold.
 */
export function rewardVerdictEligible(
  status: { kind?: unknown; score?: unknown } | null | undefined,
  threshold: number,
): boolean {
  return (
    status?.kind === 'allowed' &&
    typeof status.score === 'number' &&
    Number.isFinite(status.score) &&
    threshold >= 0 &&
    threshold <= 1 &&
    status.score >= threshold
  );
}

/**
 * Resolve (commit or terminally drop) a pending intent. Either way the work it
 * consumed is spent, so a terminal refusal cannot mint a second intent for the
 * same minutes; a transient submission failure keeps the pending intent.
 */
export function settleRewardAward(
  state: RewardAccrualState,
  operationId: string,
  consumed = true,
): RewardAccrualState {
  const next = cloneRewardAccrualState(state);
  for (const entry of Object.values(next.categories)) {
    if (entry.pending?.operationId !== operationId) continue;
    if (consumed) {
      entry.progressMs = Math.max(0, entry.progressMs - entry.pending.consumedWorkMs);
    }
    entry.pending = null;
  }
  return next;
}

export function rewardAccrualStatus(
  state: RewardAccrualState,
  reason: RewardEarningReason,
  configs: Record<string, RewardEarningConfig>,
): RewardAccrualStatus {
  return {
    reason,
    earning: reason === 'earning',
    checkpointAtMs: state.checkpoint?.atMs ?? null,
    progress: Object.entries(state.categories)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([category, entry]) => {
        const config = configs[category];
        return {
          category,
          dayKey: entry.dayKey,
          progressMs: entry.progressMs,
          workMs: config?.workMs ?? 0,
          awardMs: config?.awardMs ?? 0,
          pending: entry.pending !== null,
        };
      }),
  };
}

/** Duplicate suppression for identical persisted boundaries. */
export function sameRewardCheckpoint(
  left: RewardCheckpoint | null,
  right: RewardCheckpoint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.atMs === right.atMs && sameCategories(left.categories, right.categories);
}

export { EMPTY_DAY_KEY as EMPTY_REWARD_DAY_KEY };
