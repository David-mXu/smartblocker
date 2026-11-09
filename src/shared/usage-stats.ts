// Pure, browser-independent usage aggregation. Keep this module
// erasable-syntax-only: scripts/usage-stats-test.mjs imports it with Node's
// native TypeScript stripping.
//
// Privacy boundary: durable state contains local-day hostname/category totals
// and bounded opaque navigation IDs used only to suppress duplicate blocked
// decisions. It never contains a URL, path, query, title, score, or rule text.
//
// Accounting model (v2):
// - activeMs is the one total. Protection/lock/break fields are annotations,
//   never added on top: protectedMs + unprotectedMs + unknownMs == activeMs,
//   and lockedMs/breakMs are each <= activeMs (subsets, not additional time).
// - pagesSilenced is the one block total. Every reason counter is disjoint and
//   their sum is kept equal to pagesSilenced, including after migration.

export const USAGE_STATS_VERSION = 2;
export const USAGE_STATS_STORAGE_KEY = 'usageStats:v2';
/** Pre-v2 data is read once, migrated in memory, then removed after a write. */
export const USAGE_STATS_LEGACY_STORAGE_KEY = 'usageStats:v1';
export const USAGE_STATS_RETENTION_DAYS = 35;
export const USAGE_STATS_MAX_DECISION_IDS = 2000;
export const USAGE_STATS_MAX_SITES_PER_DAY = 100;
export const USAGE_STATS_MAX_CATEGORIES_PER_DAY = 50;
export const USAGE_STATS_OTHER_SITES_BUCKET = 'other.invalid';
export const USAGE_STATS_OTHER_CATEGORIES_BUCKET = 'other categories';
export const USAGE_STATS_HEARTBEAT_MINUTES = 1;
export const USAGE_STATS_MAX_CHECKPOINT_GAP_MS = 135_000;
export const USAGE_STATS_WRITE_BATCH_MS = 15_000;
export const USAGE_STATS_IDLE_SECONDS = 30;
export const UNCATEGORIZED_USAGE_CATEGORY = 'uncategorized';
export const RULE_USAGE_CATEGORY = 'blocked by rule';

const RULE_DERIVED_LABEL_PREFIXES = ['blocked rule:', 'title rule:', 'channel block:'];

export type UsageBlockReason =
  | 'classifier'
  | 'deterministic'
  | 'channel'
  | 'adult'
  | 'fail-closed'
  | 'unknown';

export interface UsageBlockCounts {
  classifier: number;
  deterministic: number;
  channel: number;
  adult: number;
  failClosed: number;
  /** Pre-v2 decisions whose exact reason was not recorded. */
  unknown: number;
}

/**
 * Active-time annotations. All values are milliseconds of otherwise-counted
 * on-page active time; they are never summed into additional time.
 */
export interface UsageProtectionTime {
  /** Active time while blocking was enabled or a lock forced it on. */
  protectedMs: number;
  /** Active time while blocking was explicitly off (no lock forcing it). */
  unprotectedMs: number;
  /** Active time inside an active lock (subset of active time). */
  lockedMs: number;
  /** Active time inside a classifier-break relief window (subset). */
  breakMs: number;
  /** Pre-v2 active time whose protection state was never recorded. */
  unknownMs: number;
}

/** The protection/lock/break state attached to one active-time interval. */
export interface UsageContext {
  protected: boolean;
  locked: boolean;
  break: boolean;
}

export interface UsageBucket {
  /** Approximate focused, non-idle time on an active http/https tab. */
  activeMs: number;
  /** Distinct transitions into a blocked/blocked-rule page decision. */
  pagesSilenced: number;
  /** Completed, token-validated block-screen override actions. */
  overrides: number;
}

export interface UsageTarget {
  hostname: string;
  category: string;
}

export interface UsageCheckpoint {
  at: number;
  target: UsageTarget | null;
  /** Null when unknown (legacy v1 or missing browser APIs). */
  context: UsageContext | null;
}

export interface UsageDay {
  totals: UsageBucket;
  protection: UsageProtectionTime;
  blocks: UsageBlockCounts;
  sites: Record<string, UsageBucket>;
  categories: Record<string, UsageBucket>;
}

interface SilencedDecision {
  id: string;
  day: string;
}

export interface UsageStatsState {
  version: typeof USAGE_STATS_VERSION;
  days: Record<string, UsageDay>;
  checkpoint: UsageCheckpoint | null;
  /** Bounded, URL-free duplicate suppression; omitted from exports. */
  recentSilenced: SilencedDecision[];
}

export interface UsageDayExport extends UsageDay {
  date: string;
}

export interface UsageStatsExport {
  version: typeof USAGE_STATS_VERSION;
  generatedAt: number;
  retentionDays: number;
  metricDefinitions: {
    activeMs: string;
    protectedMs: string;
    unprotectedMs: string;
    lockedMs: string;
    breakMs: string;
    pagesSilenced: string;
    blockReasons: string;
    overrides: string;
    overrideRate: string;
  };
  days: UsageDayExport[];
}

export interface UsageSummary {
  days: number;
  totals: UsageBucket;
  protection: UsageProtectionTime;
  blocks: UsageBlockCounts;
  /** Null when pagesSilenced is zero; never turns an empty denominator into 0%. */
  overrideRate: number | null;
}

export interface LocalIntervalChunk {
  date: string;
  start: number;
  end: number;
}

export function emptyUsageBucket(): UsageBucket {
  return { activeMs: 0, pagesSilenced: 0, overrides: 0 };
}

export function emptyUsageProtectionTime(): UsageProtectionTime {
  return { protectedMs: 0, unprotectedMs: 0, lockedMs: 0, breakMs: 0, unknownMs: 0 };
}

export function emptyUsageBlockCounts(): UsageBlockCounts {
  return { classifier: 0, deterministic: 0, channel: 0, adult: 0, failClosed: 0, unknown: 0 };
}

export function emptyUsageStatsState(): UsageStatsState {
  return {
    version: USAGE_STATS_VERSION,
    days: {},
    checkpoint: null,
    recentSilenced: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Define rather than assign so labels such as "__proto__" remain data keys. */
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(year, month - 1, date);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === date
  );
}

function cleanHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hostname = value.trim().toLowerCase().replace(/\.$/, '').slice(0, 253);
  if (!hostname || /[/?#@\s]/.test(hostname)) return null;
  return hostname;
}

export function normalizeUsageCategory(value: unknown): string {
  if (typeof value !== 'string') return UNCATEGORIZED_USAGE_CATEGORY;
  const label = value.trim();
  const lower = label.toLowerCase();
  // Deterministic verdict labels embed the user's actual rule, which may be a
  // URL/path/query. Never let that detail cross into durable usage categories.
  if (RULE_DERIVED_LABEL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return RULE_USAGE_CATEGORY;
  }
  return label.slice(0, 120) || UNCATEGORIZED_USAGE_CATEGORY;
}

export function normalizeUsageBlockReason(value: unknown): UsageBlockReason {
  switch (value) {
    case 'classifier':
    case 'deterministic':
    case 'channel':
    case 'adult':
    case 'fail-closed':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

/** Extract only an http/https hostname. Paths and queries never leave this call. */
export function usageHostnameFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return cleanHostname(url.hostname);
  } catch {
    return null;
  }
}

export function localUsageDate(at: number): string {
  const date = new Date(at);
  if (!Number.isFinite(at) || !Number.isFinite(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Date construction across civil dates handles 23/25-hour DST days. */
export function nextLocalUsageMidnight(at: number): number | null {
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

export function splitUsageIntervalAtLocalMidnight(start: number, end: number): LocalIntervalChunk[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const chunks: LocalIntervalChunk[] = [];
  let cursor = start;
  while (cursor < end) {
    const boundary = nextLocalUsageMidnight(cursor);
    const day = localUsageDate(cursor);
    if (boundary === null || !day || boundary <= cursor) return [];
    const chunkEnd = Math.min(boundary, end);
    chunks.push({ date: day, start: cursor, end: chunkEnd });
    if (chunkEnd <= cursor) return [];
    cursor = chunkEnd;
  }
  return chunks;
}

function sanitizeBucket(value: unknown): UsageBucket {
  const bucket = isRecord(value) ? value : {};
  return {
    activeMs: finiteCounter(bucket.activeMs),
    pagesSilenced: finiteCounter(bucket.pagesSilenced),
    overrides: finiteCounter(bucket.overrides),
  };
}

function sanitizeBucketMap(value: unknown, hostnames: boolean): Record<string, UsageBucket> {
  const result: Record<string, UsageBucket> = {};
  if (!isRecord(value)) return result;
  for (const [rawKey, rawBucket] of Object.entries(value)) {
    const key = hostnames ? cleanHostname(rawKey) : normalizeUsageCategory(rawKey);
    if (!key || (hostnames && key !== rawKey.trim().toLowerCase().replace(/\.$/, ''))) continue;
    put(result, key, sanitizeBucket(rawBucket));
  }
  return result;
}

/**
 * Keep the three coverage buckets exactly equal to activeMs. A malformed or
 * partially written value never manufactures or hides time.
 */
function reconcileProtection(
  protection: UsageProtectionTime,
  activeMs: number,
): UsageProtectionTime {
  let protectedMs = Math.min(protection.protectedMs, activeMs);
  let unprotectedMs = Math.min(protection.unprotectedMs, activeMs - protectedMs);
  let unknownMs = Math.min(
    protection.unknownMs,
    Math.max(0, activeMs - protectedMs - unprotectedMs),
  );
  const missing = activeMs - protectedMs - unprotectedMs - unknownMs;
  if (missing > 0) unknownMs += missing;
  return {
    protectedMs,
    unprotectedMs,
    lockedMs: Math.min(protection.lockedMs, activeMs),
    breakMs: Math.min(protection.breakMs, activeMs),
    unknownMs,
  };
}

/**
 * Reason counters are disjoint. Force their sum back to pagesSilenced so the
 * UI's breakdown and total can never disagree, even for corrupted input.
 */
function reconcileBlocks(blocks: UsageBlockCounts, pagesSilenced: number): UsageBlockCounts {
  const result: UsageBlockCounts = { ...blocks };
  const keys: (keyof UsageBlockCounts)[] = [
    'unknown',
    'classifier',
    'deterministic',
    'channel',
    'adult',
    'failClosed',
  ];
  let sum = keys.reduce((total, key) => total + result[key], 0);
  if (sum > pagesSilenced) {
    let excess = sum - pagesSilenced;
    for (const key of keys) {
      if (excess <= 0) break;
      const take = Math.min(excess, result[key]);
      result[key] -= take;
      excess -= take;
    }
    sum = pagesSilenced;
  }
  if (sum < pagesSilenced) result.unknown += pagesSilenced - sum;
  return result;
}

function sanitizeProtection(
  value: unknown,
  activeMs: number,
  present: boolean,
): UsageProtectionTime {
  if (!present) {
    // Migrated day: active time exists but its protection state is unknown.
    return reconcileProtection(
      { protectedMs: 0, unprotectedMs: 0, lockedMs: 0, breakMs: 0, unknownMs: activeMs },
      activeMs,
    );
  }
  const raw = isRecord(value) ? value : {};
  return reconcileProtection(
    {
      protectedMs: finiteCounter(raw.protectedMs),
      unprotectedMs: finiteCounter(raw.unprotectedMs),
      lockedMs: finiteCounter(raw.lockedMs),
      breakMs: finiteCounter(raw.breakMs),
      unknownMs: finiteCounter(raw.unknownMs),
    },
    activeMs,
  );
}

function sanitizeBlocks(
  value: unknown,
  pagesSilenced: number,
  present: boolean,
): UsageBlockCounts {
  if (!present) {
    return reconcileBlocks(
      { ...emptyUsageBlockCounts(), unknown: pagesSilenced },
      pagesSilenced,
    );
  }
  const raw = isRecord(value) ? value : {};
  return reconcileBlocks(
    {
      classifier: finiteCounter(raw.classifier),
      deterministic: finiteCounter(raw.deterministic),
      channel: finiteCounter(raw.channel),
      adult: finiteCounter(raw.adult),
      failClosed: finiteCounter(raw.failClosed),
      unknown: finiteCounter(raw.unknown),
    },
    pagesSilenced,
  );
}

function sanitizeTarget(value: unknown): UsageTarget | null {
  if (!isRecord(value)) return null;
  const hostname = cleanHostname(value.hostname);
  return hostname
    ? { hostname, category: normalizeUsageCategory(value.category) }
    : null;
}

function sanitizeContext(value: unknown): UsageContext | null {
  if (!isRecord(value)) return null;
  return {
    protected: value.protected === true,
    locked: value.locked === true,
    break: value.break === true,
  };
}

function sanitizeCheckpoint(value: unknown): UsageCheckpoint | null {
  if (!isRecord(value)) return null;
  const at = value.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null;
  return {
    at,
    target: sanitizeTarget(value.target),
    context: sanitizeContext(value.context),
  };
}

function sanitizeSilenced(value: unknown): SilencedDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is SilencedDecision =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        entry.id.length <= 160 &&
        typeof entry.day === 'string' &&
        validDay(entry.day),
    )
    .slice(-USAGE_STATS_MAX_DECISION_IDS)
    .map((entry) => ({ id: entry.id, day: entry.day }));
}

export function sanitizeUsageStatsState(value: unknown): UsageStatsState {
  if (!isRecord(value) || value.version !== USAGE_STATS_VERSION) return emptyUsageStatsState();
  const state = emptyUsageStatsState();
  if (isRecord(value.days)) {
    for (const [day, rawDay] of Object.entries(value.days)) {
      if (!validDay(day) || !isRecord(rawDay)) continue;
      const totals = sanitizeBucket(rawDay.totals);
      put(state.days, day, {
        totals,
        protection: sanitizeProtection(
          rawDay.protection,
          totals.activeMs,
          isRecord(rawDay.protection),
        ),
        blocks: sanitizeBlocks(rawDay.blocks, totals.pagesSilenced, isRecord(rawDay.blocks)),
        sites: sanitizeBucketMap(rawDay.sites, true),
        categories: sanitizeBucketMap(rawDay.categories, false),
      });
    }
  }
  state.checkpoint = sanitizeCheckpoint(value.checkpoint);
  state.recentSilenced = sanitizeSilenced(value.recentSilenced);
  return state;
}

/**
 * One-way v1 -> v2 migration. v1 recorded active time and block totals but not
 * whether protection was on or why a page was blocked, so those portions are
 * attributed to explicit "unknown" fields instead of guessing.
 */
export function migrateUsageStatsV1(value: unknown): UsageStatsState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.days)) {
    return emptyUsageStatsState();
  }
  const migrated: Record<string, unknown> = {};
  for (const [day, rawDay] of Object.entries(value.days)) {
    if (!validDay(day) || !isRecord(rawDay)) continue;
    const totals = sanitizeBucket(rawDay.totals);
    put(migrated, day, {
      totals,
      protection: {
        protectedMs: 0,
        unprotectedMs: 0,
        lockedMs: 0,
        breakMs: 0,
        unknownMs: totals.activeMs,
      },
      blocks: { ...emptyUsageBlockCounts(), unknown: totals.pagesSilenced },
      sites: rawDay.sites,
      categories: rawDay.categories,
    });
  }
  return sanitizeUsageStatsState({
    version: USAGE_STATS_VERSION,
    days: migrated,
    checkpoint: value.checkpoint,
    recentSilenced: value.recentSilenced,
  });
}

/** Read either current v2 or legacy v1 input; anything else starts empty. */
export function migrateUsageStatsState(value: unknown): UsageStatsState {
  if (isRecord(value) && value.version === USAGE_STATS_VERSION) {
    return sanitizeUsageStatsState(value);
  }
  if (isRecord(value) && value.version === 1) return migrateUsageStatsV1(value);
  return emptyUsageStatsState();
}

function cloneBucketMap(map: Record<string, UsageBucket>): Record<string, UsageBucket> {
  const result: Record<string, UsageBucket> = {};
  for (const [key, bucket] of Object.entries(map)) put(result, key, { ...bucket });
  return result;
}

function cloneState(state: UsageStatsState): UsageStatsState {
  const days: Record<string, UsageDay> = {};
  for (const [day, value] of Object.entries(state.days)) {
    put(days, day, {
      totals: { ...value.totals },
      protection: { ...value.protection },
      blocks: { ...value.blocks },
      sites: cloneBucketMap(value.sites),
      categories: cloneBucketMap(value.categories),
    });
  }
  return {
    version: USAGE_STATS_VERSION,
    days,
    checkpoint: state.checkpoint
      ? {
          at: state.checkpoint.at,
          target: state.checkpoint.target ? { ...state.checkpoint.target } : null,
          context: state.checkpoint.context ? { ...state.checkpoint.context } : null,
        }
      : null,
    recentSilenced: state.recentSilenced.map((entry) => ({ ...entry })),
  };
}

function dayForMutation(state: UsageStatsState, day: string): UsageDay {
  const existing = own(state.days, day);
  if (existing) return existing;
  const created: UsageDay = {
    totals: emptyUsageBucket(),
    protection: emptyUsageProtectionTime(),
    blocks: emptyUsageBlockCounts(),
    sites: {},
    categories: {},
  };
  put(state.days, day, created);
  return created;
}

function bucketForMutation(
  map: Record<string, UsageBucket>,
  key: string,
  limit: number,
  overflowKey: string,
): UsageBucket {
  const existing = own(map, key);
  if (existing) return existing;
  // Bound daily maps even for unusually broad browsing. Totals still include
  // every event; only the per-bucket detail folds into an explicit overflow.
  const storedKey = Object.keys(map).length >= limit - 1 ? overflowKey : key;
  const existingOverflow = own(map, storedKey);
  if (existingOverflow) return existingOverflow;
  const created = emptyUsageBucket();
  put(map, storedKey, created);
  return created;
}

function increment(
  day: UsageDay,
  target: UsageTarget,
  field: keyof UsageBucket,
  amount: number,
): void {
  if (amount <= 0) return;
  day.totals[field] += amount;
  bucketForMutation(
    day.sites,
    target.hostname,
    USAGE_STATS_MAX_SITES_PER_DAY,
    USAGE_STATS_OTHER_SITES_BUCKET,
  )[field] += amount;
  bucketForMutation(
    day.categories,
    target.category,
    USAGE_STATS_MAX_CATEGORIES_PER_DAY,
    USAGE_STATS_OTHER_CATEGORIES_BUCKET,
  )[field] += amount;
}

function addActiveMs(
  state: UsageStatsState,
  target: UsageTarget,
  context: UsageContext | null,
  start: number,
  end: number,
): void {
  for (const chunk of splitUsageIntervalAtLocalMidnight(start, end)) {
    const ms = Math.round(chunk.end - chunk.start);
    if (ms <= 0) continue;
    const day = dayForMutation(state, chunk.date);
    increment(day, target, 'activeMs', ms);
    if (context === null) {
      day.protection.unknownMs += ms;
    } else if (context.protected) {
      day.protection.protectedMs += ms;
    } else {
      day.protection.unprotectedMs += ms;
    }
    // Subsets: these never increase the active-time total.
    if (context?.locked) day.protection.lockedMs += ms;
    if (context?.break) day.protection.breakMs += ms;
  }
}

function oldestRetainedDay(now: number): string | null {
  if (!Number.isFinite(now)) return null;
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) return null;
  const oldest = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() - (USAGE_STATS_RETENTION_DAYS - 1),
  );
  return localUsageDate(oldest.getTime());
}

export function pruneUsageStats(state: UsageStatsState, now: number): UsageStatsState {
  const oldest = oldestRetainedDay(now);
  if (oldest === null) return state;
  let changed = false;
  const next = cloneState(state);
  for (const day of Object.keys(next.days)) {
    if (day < oldest) {
      delete next.days[day];
      changed = true;
    }
  }
  const recent = next.recentSilenced.filter((entry) => entry.day >= oldest);
  if (recent.length !== next.recentSilenced.length) changed = true;
  next.recentSilenced = recent;
  return changed ? next : state;
}

/** Set a boundary without charging anything before it (startup/idle recovery). */
export function resetUsageCheckpoint(
  state: UsageStatsState,
  at: number,
  target: UsageTarget | null,
  context: UsageContext | null = null,
): UsageStatsState {
  if (!Number.isFinite(at) || at < 0) return state;
  const next = cloneState(state);
  next.checkpoint = {
    at,
    target: target ? sanitizeTarget(target) : null,
    context: context ? sanitizeContext(context) : null,
  };
  return next;
}

/**
 * Close the previous segment before installing the next target. A gap beyond
 * the bounded checkpoint window is discarded in full: a late alarm must not
 * manufacture a capped tail of active time. Backwards/invalid clocks charge 0.
 */
export function transitionUsageCheckpoint(
  state: UsageStatsState,
  at: number,
  target: UsageTarget | null,
  discardPrevious = false,
  context: UsageContext | null = null,
): UsageStatsState {
  if (!Number.isFinite(at) || at < 0) return state;
  let next = cloneState(state);
  const previous = state.checkpoint;
  if (
    !discardPrevious &&
    previous?.target &&
    Number.isFinite(previous.at) &&
    previous.at >= 0 &&
    at > previous.at &&
    at - previous.at <= USAGE_STATS_MAX_CHECKPOINT_GAP_MS
  ) {
    const oldTarget = sanitizeTarget(previous.target);
    if (oldTarget) addActiveMs(next, oldTarget, sanitizeContext(previous.context), previous.at, at);
  }
  next.checkpoint = {
    at,
    target: target ? sanitizeTarget(target) : null,
    context: context ? sanitizeContext(context) : null,
  };
  next = pruneUsageStats(next, at);
  return next;
}

/** Count one qualified blocked decision. Reused IDs are a write-free no-op. */
export function recordUsagePageSilenced(
  state: UsageStatsState,
  input: {
    at: number;
    hostname: string;
    category: string;
    reason: UsageBlockReason;
    decisionId: string;
  },
): UsageStatsState {
  const day = localUsageDate(input.at);
  const hostname = cleanHostname(input.hostname);
  const decisionId = input.decisionId.trim().slice(0, 160);
  if (!day || !hostname || !decisionId || input.at < 0) return state;
  if (state.recentSilenced.some((entry) => entry.id === decisionId)) return state;
  let next = cloneState(state);
  const target = { hostname, category: normalizeUsageCategory(input.category) };
  const usageDay = dayForMutation(next, day);
  increment(usageDay, target, 'pagesSilenced', 1);
  const reason = normalizeUsageBlockReason(input.reason);
  if (reason === 'unknown') usageDay.blocks.unknown += 1;
  else if (reason === 'fail-closed') usageDay.blocks.failClosed += 1;
  else usageDay.blocks[reason] += 1;
  next.recentSilenced.push({ id: decisionId, day });
  next.recentSilenced = next.recentSilenced.slice(-USAGE_STATS_MAX_DECISION_IDS);
  next = pruneUsageStats(next, input.at);
  return next;
}

export function recordUsageOverride(
  state: UsageStatsState,
  input: { at: number; hostname: string; category: string },
): UsageStatsState {
  const day = localUsageDate(input.at);
  const hostname = cleanHostname(input.hostname);
  if (!day || !hostname || input.at < 0) return state;
  let next = cloneState(state);
  increment(
    dayForMutation(next, day),
    { hostname, category: normalizeUsageCategory(input.category) },
    'overrides',
    1,
  );
  next = pruneUsageStats(next, input.at);
  return next;
}

export function buildUsageStatsExport(state: UsageStatsState, generatedAt: number): UsageStatsExport {
  return {
    version: USAGE_STATS_VERSION,
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : 0,
    retentionDays: USAGE_STATS_RETENTION_DAYS,
    metricDefinitions: {
      activeMs:
        'Approximate milliseconds on the focused window active http/https tab while the system idle state is active; checkpointed and conservatively undercounted across interruptions.',
      protectedMs:
        'Active milliseconds while blocking was enabled, or while a lock forced blocking on. Subset of activeMs.',
      unprotectedMs:
        'Active milliseconds while blocking was off and no lock forced it on. Subset of activeMs.',
      lockedMs:
        'Active milliseconds inside an active lock. Subset of activeMs; overlapping break time is not double-counted here.',
      breakMs:
        'Active milliseconds inside a classifier-break relief window. Subset of activeMs; breaks relax classifier verdicts only.',
      pagesSilenced:
        'Distinct page/navigation transitions into blocked or blocked-rule status, not heartbeats or overlay paints.',
      blockReasons:
        'Disjoint reason classes for pagesSilenced: classifier, deterministic rule, channel rule, adult rule, fail-closed locked classifier, or unknown (pre-v2 migration only). Their sum equals pagesSilenced.',
      overrides: 'Completed block-screen override actions accepted by the one-time override token guard.',
      overrideRate:
        'Completed overrides divided by pagesSilenced over the selected period; null when pagesSilenced is zero.',
    },
    days: Object.entries(state.days)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, day]) => ({
        date,
        totals: { ...day.totals },
        protection: { ...day.protection },
        blocks: { ...day.blocks },
        sites: cloneBucketMap(day.sites),
        categories: cloneBucketMap(day.categories),
      })),
  };
}

export function summarizeUsageStats(
  data: UsageStatsExport,
  now: number,
  dayCount = 7,
): UsageSummary {
  const count = Number.isInteger(dayCount)
    ? Math.max(1, Math.min(dayCount, USAGE_STATS_RETENTION_DAYS))
    : 7;
  const today = new Date(now);
  const validNow = Number.isFinite(now) && Number.isFinite(today.getTime());
  const oldest = validNow
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1)).getTime()
    : Number.NaN;
  const oldestDay = localUsageDate(oldest);
  const todayDay = localUsageDate(now);
  const totals = emptyUsageBucket();
  const protection = emptyUsageProtectionTime();
  const blocks = emptyUsageBlockCounts();
  let days = 0;
  for (const day of data.days) {
    if (!oldestDay || day.date < oldestDay || day.date > todayDay) continue;
    days += 1;
    totals.activeMs += day.totals.activeMs;
    totals.pagesSilenced += day.totals.pagesSilenced;
    totals.overrides += day.totals.overrides;
    protection.protectedMs += day.protection.protectedMs;
    protection.unprotectedMs += day.protection.unprotectedMs;
    protection.lockedMs += day.protection.lockedMs;
    protection.breakMs += day.protection.breakMs;
    protection.unknownMs += day.protection.unknownMs;
    blocks.classifier += day.blocks.classifier;
    blocks.deterministic += day.blocks.deterministic;
    blocks.channel += day.blocks.channel;
    blocks.adult += day.blocks.adult;
    blocks.failClosed += day.blocks.failClosed;
    blocks.unknown += day.blocks.unknown;
  }
  return {
    days,
    totals,
    protection,
    blocks,
    overrideRate: totals.pagesSilenced > 0 ? totals.overrides / totals.pagesSilenced : null,
  };
}
