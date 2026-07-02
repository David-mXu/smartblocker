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
}

const STORAGE_KEY = 'feedback';
const MAX_RECORDS = 500;
/** Cap corrections folded into any single centroid (newest win). */
const MAX_EXAMPLES_PER_CENTROID = 24;

let cache: FeedbackRecord[] | null = null;

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

async function load(): Promise<FeedbackRecord[]> {
  if (cache !== null) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = (stored[STORAGE_KEY] as FeedbackRecord[] | undefined) ?? [];
  return cache;
}

async function save(records: FeedbackRecord[]): Promise<void> {
  cache = records;
  await api.storage.local.set({ [STORAGE_KEY]: records });
}

/** Append a feedback record, bounded to MAX_RECORDS (oldest dropped first). */
export async function addFeedback(record: FeedbackRecord): Promise<void> {
  const records = [...(await load()), record];
  await save(records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records);
}

export async function getFeedback(): Promise<FeedbackRecord[]> {
  return load();
}

export async function clearFeedback(): Promise<void> {
  await save([]);
}

/** Mark the given records (by ts identity) as uploaded. */
export async function markUploaded(tss: number[]): Promise<void> {
  const set = new Set(tss);
  await save((await load()).map((r) => (set.has(r.ts) ? { ...r, uploaded: true } : r)));
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
