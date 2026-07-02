// Embedding-prototype classifier: category centroids + similarity math.
// Pure functions only — no storage, no inference. The classifier (SW-side)
// supplies an embed function and caches the resulting centroid vectors;
// scripts/benchmark.mjs mirrors the same math for offline evaluation.
//
// Each centroid = normalized mean embedding of its seed texts (a description
// sentence + example titles from prototype-seeds.json). Neutral centroids
// catch productive/utility pages: a neutral top-1 NEVER blocks, because its
// label carries the NEUTRAL_PREFIX and can't collide with settings.labels.
import seeds from './prototype-seeds.json';

export const NEUTRAL_PREFIX = 'neutral: ';

export interface CentroidSpec {
  /** Category label (matches settings.labels) or NEUTRAL_PREFIX + name. */
  name: string;
  /** Seed texts whose mean embedding forms the centroid. */
  texts: string[];
}

interface SeedGroup {
  description: string;
  examples: string[];
}

const CATEGORY_SEEDS = seeds.categories as Record<string, SeedGroup>;
const NEUTRAL_SEEDS = seeds.neutral as Record<string, SeedGroup>;

/**
 * Build the centroid specs for the active label set plus all neutral
 * centroids. Labels without curated seeds (user-customized categories) fall
 * back to a two-text centroid derived from the label itself.
 * `userExamples` (from the feedback store) extends matching centroids —
 * corrections nudge future classifications, i.e. on-device learning.
 */
export function centroidSpecs(
  labels: string[],
  userExamples: Record<string, string[]> = {},
): CentroidSpec[] {
  const specs: CentroidSpec[] = [];
  for (const label of labels) {
    const seed = CATEGORY_SEEDS[label];
    const texts = seed
      ? [seed.description, ...seed.examples]
      : [`Web pages about ${label}.`, label];
    specs.push({ name: label, texts: [...texts, ...(userExamples[label] ?? [])] });
  }
  for (const [name, seed] of Object.entries(NEUTRAL_SEEDS)) {
    const key = NEUTRAL_PREFIX + name;
    specs.push({
      name: key,
      texts: [seed.description, ...seed.examples, ...(userExamples[key] ?? [])],
    });
  }
  // "This is actually productive" corrections form their own neutral centroid
  // once any exist — the strongest personalization signal.
  const approved = userExamples[NEUTRAL_PREFIX + 'user approved'];
  if (approved?.length) {
    specs.push({ name: NEUTRAL_PREFIX + 'user approved', texts: approved });
  }
  return specs;
}

/** True for centroid names that must never trigger a block. */
export function isNeutralLabel(label: string): boolean {
  return label.startsWith(NEUTRAL_PREFIX);
}

/** Stable cache version for a set of specs: any text change busts the cache. */
export function prototypesVersion(modelId: string, specs: CentroidSpec[]): string {
  const payload = modelId + '\x00' + specs.map((s) => `${s.name}\x1f${s.texts.join('\x1e')}`).join('\x00');
  // djb2 — collision-resistant enough for a cache-bust key.
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0;
  }
  return `${specs.length}:${(hash >>> 0).toString(36)}`;
}

/** Normalized mean of a set of (normalized) embedding vectors. */
export function meanNormalize(vecs: number[][]): number[] {
  const dim = vecs[0].length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) mean[i] += v[i] / vecs.length;
  }
  let norm = 0;
  for (const x of mean) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return mean.map((x) => x / norm);
}

/**
 * Classify an embedded text against centroid vectors: cosine similarity
 * (vectors are normalized, so a dot product), then softmax at `temperature`
 * so the score is threshold-comparable to the old NLI backend's output.
 */
export function classifyBySimilarity(
  vec: number[],
  centroids: { name: string; vec: number[] }[],
  temperature: number,
): { label: string; score: number; all: { labels: string[]; scores: number[] } } {
  const logits = centroids.map((c) => {
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i] * c.vec[i];
    return dot / temperature;
  });
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const ranked = centroids
    .map((c, i) => ({ label: c.name, score: exps[i] / sum }))
    .sort((a, b) => b.score - a.score);
  return {
    label: ranked[0].label,
    score: ranked[0].score,
    all: { labels: ranked.map((r) => r.label), scores: ranked.map((r) => r.score) },
  };
}
