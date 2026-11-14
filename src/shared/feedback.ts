// Feedback store: rich misclassification records, the raw material for both
// on-device learning and (opt-in) aggregate model improvement.
//
//   - false_positive: the user hit "this is actually productive" on the block
//     screen (richer sibling of the title-only overrides.ts entry).
//   - false_negative: the user reported a page that SHOULD have been blocked
//     (popup), with the category they assign it to.
//
// Records stay in storage.local. They leave the machine only via the options
// page's manual "Export JSON" or the off-by-default shareFeedback setting.
// Mirrors the settings.ts/overrides.ts pattern: one in-memory cache
// invalidated via storage.onChanged so long-lived contexts stay coherent.
import { api } from './api';
import { buildClassifierText } from './build-input';
import { NEUTRAL_PREFIX } from './prototypes';

export interface FeedbackRecord {
  kind: 'false_positive' | 'false_negative';
  title: string;
  channel?: string;
  context?: string;
  /** Hostname only — the full URL is never stored or shared. */
  domain: string;
  /** What the model said (label + score at decision time). */
  modelLabel: string;
  score: number;
  /** For false negatives: the category the user says this page belongs to. */
  correctedLabel?: string;
  /** Model identity so aggregated feedback can be bucketed per model. */
  modelId: string;
  extVersion: string;
  ts: number;
  /** Set once the opt-in uploader has shared this record. */
  uploaded?: boolean;
  /** Set when the opt-in uploader permanently gave up on this record (it can
   *  never satisfy the worker's wire contract). Local-only, like `uploaded`. */
  skipped?: boolean;
}

const STORAGE_KEY = 'feedback';
const MAX_RECORDS = 500;
/** Cap corrections folded into any single centroid (newest win). */
const MAX_EXAMPLES_PER_CENTROID = 24;
/** Stored-title bound — mirrors overrides.ts MAX_TITLE_LEN, the 300-char
 *  classifier-input ceiling the verdict was actually based on. A page can set
 *  a multi-megabyte title; without a cap it lands in storage.local verbatim
 *  (and would flow unbounded into centroid examples via buildClassifierText). */
const MAX_TITLE_LEN = 300;
/** Hostnames max out at 253 chars; the ingestion worker rejects beyond that. */
const MAX_DOMAIN_LEN = 253;
/** Channel/context bound = the ingestion worker's MAX_TEXT (feedback-worker
 *  src/index.js). Centroid examples only ever read the first 200 chars of
 *  context (build-input.ts MAX_CONTEXT), so this never changes classifier
 *  input — it only bounds storage and the wire format. */
const MAX_FIELD_LEN = 500;

let cache: FeedbackRecord[] | null = null;

// Serialize read-modify-write operations at write granularity: two concurrent
// appends both load() the same snapshot and the later save() silently drops
// the earlier one (last-write-wins). Mirrors the in-context promise chain of
// allowance-store.ts enqueueLocal / usage-stats-tracker.ts enqueue. Cross-
// context coherence still relies on the storage.onChanged invalidation below.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const attempt = writeQueue.then(work);
  writeQueue = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

async function load(): Promise<FeedbackRecord[]> {
  if (cache !== null) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = (stored[STORAGE_KEY] as FeedbackRecord[] | undefined) ?? [];
  return cache;
}

/**
 * Commit the cache only after the storage write succeeds. A rejected set()
 * (quota, transient Firefox failures) must not leave this context serving
 * state that never persisted — and a failed write fires no storage.onChanged,
 * so nothing else would rescue the phantom cache. On failure the cache is
 * invalidated (not reverted): storage is the source of truth, and a re-read
 * is correct whether the write partially landed or not. The caller gets the
 * rejection, so a dropped write surfaces instead of silently vanishing.
 */
async function save(records: FeedbackRecord[]): Promise<void> {
  try {
    await api.storage.local.set({ [STORAGE_KEY]: records });
    cache = records;
  } catch (e) {
    cache = null;
    throw e;
  }
}

/**
 * Length-cap the storable text fields of a record. Length-capping only — no
 * NFKC/zero-width normalization like overrides.ts: these records feed centroid
 * examples verbatim via buildClassifierText, and normalizing would rewrite
 * the learning signal of legitimate non-ASCII titles. Context is capped above
 * its 200-char classifier slice, so classifier input is unchanged.
 */
function capFeedbackRecord(record: FeedbackRecord): FeedbackRecord {
  return {
    ...record,
    title: record.title.slice(0, MAX_TITLE_LEN),
    channel: record.channel?.slice(0, MAX_FIELD_LEN),
    context: record.context?.slice(0, MAX_FIELD_LEN),
    domain: record.domain.slice(0, MAX_DOMAIN_LEN),
  };
}

/** Append a feedback record, bounded to MAX_RECORDS (oldest dropped first).
 *  Serialized so two racing appends cannot lose one another. */
export async function addFeedback(record: FeedbackRecord): Promise<void> {
  const capped = capFeedbackRecord(record);
  return enqueueWrite(async () => {
    const records = [...(await load()), capped];
    await save(records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records);
  });
}

export async function getFeedback(): Promise<FeedbackRecord[]> {
  return load();
}

export async function clearFeedback(): Promise<void> {
  return enqueueWrite(() => save([]));
}

/** Mark the given records (by ts identity) as uploaded. */
export async function markUploaded(tss: number[]): Promise<void> {
  const set = new Set(tss);
  return enqueueWrite(async () => {
    await save((await load()).map((r) => (set.has(r.ts) ? { ...r, uploaded: true } : r)));
  });
}

/**
 * Mark the given records (by ts identity) as permanently skipped by the
 * uploader: they fall outside the ingestion worker's wire contract (e.g.
 * oversized fields on records stored before addFeedback capped them), so the
 * worker would 400 the whole batch — without this the daily alarm re-sends
 * the same never-acceptable batch forever. The record still counts for local
 * on-device learning; only the opt-in upload gives up on it.
 */
export async function markSkipped(tss: number[]): Promise<void> {
  const set = new Set(tss);
  return enqueueWrite(async () => {
    await save((await load()).map((r) => (set.has(r.ts) ? { ...r, skipped: true } : r)));
  });
}

/**
 * Fold corrections into centroid seed examples for the embed backend — this
 * is the on-device learning loop:
 *   - false negatives extend the corrected category's centroid, so similar
 *     pages start blocking;
 *   - false positives feed a dedicated "user approved" neutral centroid, so
 *     similar pages stop blocking.
 * Keyed by centroid name (see prototypes.ts centroidSpecs).
 */
export async function getPrototypeExamples(): Promise<Record<string, string[]>> {
  const examples: Record<string, string[]> = {};
  for (const r of await load()) {
    const key =
      r.kind === 'false_negative' && r.correctedLabel
        ? r.correctedLabel
        : r.kind === 'false_positive'
          ? NEUTRAL_PREFIX + 'user approved'
          : null;
    if (!key) continue;
    const text = buildClassifierText({ title: r.title, channel: r.channel, context: r.context });
    if (!text) continue;
    (examples[key] ??= []).push(text);
  }
  for (const key of Object.keys(examples)) {
    examples[key] = examples[key].slice(-MAX_EXAMPLES_PER_CENTROID);
  }
  return examples;
}
