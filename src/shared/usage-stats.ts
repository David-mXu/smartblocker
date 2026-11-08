// Pure, browser-independent usage aggregation. Keep this module
// erasable-syntax-only: scripts/usage-stats-test.mjs imports it with Node's
// native TypeScript stripping.
//
// Privacy boundary: durable state contains local-day hostname/category totals
// and bounded opaque navigation IDs used only to suppress duplicate blocked
// decisions. It never contains a URL, path, query, title, score, or rule text.

export const USAGE_STATS_VERSION = 1;
export const USAGE_STATS_STORAGE_KEY = 'usageStats:v1';
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
}

export interface UsageDay {
  totals: UsageBucket;
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
    pagesSilenced: string;
    overrides: string;
    overrideRate: string;
  };
  days: UsageDayExport[];
}

export interface UsageSummary {
  days: number;
  totals: UsageBucket;
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

export function emptyUsageStatsState(): UsageStatsState {
  return { version: USAGE_STATS_VERSION, days: {}, checkpoint: null, recentSilenced: [] };
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

function sanitizeTarget(value: unknown): UsageTarget | null {
  if (!isRecord(value)) return null;
  const hostname = cleanHostname(value.hostname);
  return hostname
    ? { hostname, category: normalizeUsageCategory(value.category) }
    : null;
}

export function sanitizeUsageStatsState(value: unknown): UsageStatsState {
  if (!isRecord(value) || value.version !== USAGE_STATS_VERSION) return emptyUsageStatsState();
  const state = emptyUsageStatsState();
  if (isRecord(value.days)) {
    for (const [day, rawDay] of Object.entries(value.days)) {
      if (!validDay(day) || !isRecord(rawDay)) continue;
      put(state.days, day, {
        totals: sanitizeBucket(rawDay.totals),
        sites: sanitizeBucketMap(rawDay.sites, true),
        categories: sanitizeBucketMap(rawDay.categories, false),
      });
    }
  }
  if (isRecord(value.checkpoint)) {
    const at = value.checkpoint.at;
    if (typeof at === 'number' && Number.isFinite(at) && at >= 0) {
      state.checkpoint = { at, target: sanitizeTarget(value.checkpoint.target) };
    }
  }
  if (Array.isArray(value.recentSilenced)) {
    state.recentSilenced = value.recentSilenced
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
  return state;
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

function addActiveMs(state: UsageStatsState, target: UsageTarget, start: number, end: number): void {
  for (const chunk of splitUsageIntervalAtLocalMidnight(start, end)) {
    increment(
      dayForMutation(state, chunk.date),
      target,
      'activeMs',
      Math.round(chunk.end - chunk.start),
    );
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
): UsageStatsState {
  if (!Number.isFinite(at) || at < 0) return state;
  const next = cloneState(state);
  next.checkpoint = { at, target: target ? sanitizeTarget(target) : null };
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
    if (oldTarget) addActiveMs(next, oldTarget, previous.at, at);
  }
  next.checkpoint = { at, target: target ? sanitizeTarget(target) : null };
  next = pruneUsageStats(next, at);
  return next;
}

/** Count one qualified blocked decision. Reused IDs are a write-free no-op. */
export function recordUsagePageSilenced(
  state: UsageStatsState,
  input: { at: number; hostname: string; category: string; decisionId: string },
): UsageStatsState {
  const day = localUsageDate(input.at);
  const hostname = cleanHostname(input.hostname);
  const decisionId = input.decisionId.trim().slice(0, 160);
  if (!day || !hostname || !decisionId || input.at < 0) return state;
  if (state.recentSilenced.some((entry) => entry.id === decisionId)) return state;
  let next = cloneState(state);
  const target = { hostname, category: normalizeUsageCategory(input.category) };
  increment(dayForMutation(next, day), target, 'pagesSilenced', 1);
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
      pagesSilenced:
        'Distinct page/navigation transitions into blocked or blocked-rule status, not heartbeats or overlay paints.',
      overrides: 'Completed block-screen override actions accepted by the one-time override token guard.',
      overrideRate:
        'Completed overrides divided by pagesSilenced over the selected period; null when pagesSilenced is zero.',
    },
    days: Object.entries(state.days)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, day]) => ({
        date,
        totals: { ...day.totals },
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
  const count = Number.isInteger(dayCount) ? Math.max(1, Math.min(dayCount, USAGE_STATS_RETENTION_DAYS)) : 7;
  const today = new Date(now);
  const validNow = Number.isFinite(now) && Number.isFinite(today.getTime());
  const oldest = validNow
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1)).getTime()
    : Number.NaN;
  const oldestDay = localUsageDate(oldest);
  const todayDay = localUsageDate(now);
  const totals = emptyUsageBucket();
  let days = 0;
  for (const day of data.days) {
    if (!oldestDay || day.date < oldestDay || day.date > todayDay) continue;
    days += 1;
    totals.activeMs += day.totals.activeMs;
    totals.pagesSilenced += day.totals.pagesSilenced;
    totals.overrides += day.totals.overrides;
  }
  return {
    days,
    totals,
    overrideRate: totals.pagesSilenced > 0 ? totals.overrides / totals.pagesSilenced : null,
  };
}
