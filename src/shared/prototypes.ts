// Embedding-prototype classifier: category centroids + similarity math.
// Pure functions only — no storage, no inference. The classifier (SW-side)
// supplies an embed function and caches the resulting centroid vectors;
// scripts/benchmark.mjs mirrors the same math for offline evaluation.
//
// Each centroid = normalized mean embedding of its seed texts (a description
// sentence + example titles from prototype-seeds.json). Neutral centroids
// catch productive/utility pages: a neutral top-1 NEVER blocks, because its
// label carries the NEUTRAL_PREFIX and can't collide with settings.labels.
// Import attribute is load-bearing: it lets Node's type-stripping loader import
// this module directly, which is how scripts/lib/eval-harness.mjs classifies
// with the REAL centroid pipeline instead of a mirror that can drift.
import seeds from './prototype-seeds.json' with { type: 'json' };

export const NEUTRAL_PREFIX = 'neutral: ';

/**
 * Blend weight for Top-K individual seed similarity vs the category mean
 * centroid. 0 = pure mean centroid; 0.25 blends 75% mean centroid with 25%
 * top-2 seed similarity (Multi-Prototype / Sub-Center head) so multi-modal
 * categories don't lose sharpness when diverse examples are averaged together.
 */
export const TOP_K_SEED_BLEND = 0.25;
export const TOP_K_SEED_COUNT = 2;

/** Minimum cosine similarity with the active focus/tab context before the
 *  focus anchor can rescue a borderline page. Prevents an active focus goal
 *  from inflating the softmax denominator on unrelated distraction pages. */
export const FOCUS_RESCUE_MIN_SIM = 0.58;
export const FOCUS_OFF_TASK_MAX_SIM = 0.46;
export const FOCUS_OFF_TASK_PENALTY = 0.05;

export interface CentroidSpec {
  /** Category label (matches settings.labels) or NEUTRAL_PREFIX + name. */
  name: string;
  /** Seed texts whose mean embedding forms the centroid. */
  texts: string[];
}

export interface CentroidEntry {
  name: string;
  vec: number[];
  /** Optional individual normalized seed embeddings for Top-K multi-prototype scoring. */
  seedVecs?: number[][];
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

/** Dot product of two equal-length normalized vectors (= cosine similarity). */
export function dotProduct(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Score a page embedding against a category's prototype(s).
 * Combines the category mean centroid with the mean of the Top-K closest
 * individual seed embeddings when `seedVecs` are available (Multi-Prototype
 * Sub-Center pooling).
 */
export function categorySimilarity(
  vec: number[],
  centroid: CentroidEntry,
  topKBlend: number = TOP_K_SEED_BLEND,
): number {
  const meanSim = dotProduct(vec, centroid.vec);
  const seeds = centroid.seedVecs;
  if (!seeds || seeds.length === 0 || topKBlend <= 0) return meanSim;

  let best1 = -Infinity;
  let best2 = -Infinity;
  for (let i = 0; i < seeds.length; i++) {
    const s = dotProduct(vec, seeds[i]);
    if (s > best1) {
      best2 = best1;
      best1 = s;
    } else if (s > best2) {
      best2 = s;
    }
  }
  const topKMean =
    TOP_K_SEED_COUNT >= 2 && best2 > -Infinity ? 0.7 * best1 + 0.3 * best2 : best1;
  return (1 - topKBlend) * meanSim + topKBlend * topKMean;
}

/**
 * Classify an embedded text against centroid vectors: multi-prototype cosine
 * similarity, then softmax at `temperature` so the score is threshold-comparable
 * to the old NLI backend's output.
 *
 * When `focusVec` (derived from the user's explicit focus goal and/or open
 * productive tabs) is supplied:
 *  - If the page strongly aligns with `focusVec` (sim >= FOCUS_RESCUE_MIN_SIM),
 *    a dynamic `neutral: active focus context` prototype enters the competition
 *    and can rescue on-task tutorials/threads on mixed sites (YouTube/Reddit).
 *  - If an explicit focus goal is set (`hasExplicitGoal`) and the page is
 *    clearly off-task (sim <= FOCUS_OFF_TASK_MAX_SIM) while landing on a
 *    non-neutral top-1, its effective distraction score receives a small boost
 *    so borderline off-task procrastination is caught.
 */
export function classifyBySimilarity(
  vec: number[],
  centroids: CentroidEntry[],
  temperature: number,
  options?: {
    topKBlend?: number;
    focusVec?: number[] | null;
    focusSeedVecs?: number[][];
    hasExplicitGoal?: boolean;
  },
): { label: string; score: number; all: { labels: string[]; scores: number[] } } {
  const topKBlend = options?.topKBlend ?? TOP_K_SEED_BLEND;
  const activeCentroids: CentroidEntry[] = [...centroids];

  let focusSim = -Infinity;
  if (options?.focusVec && options.focusVec.length === vec.length) {
    const focusCentroid: CentroidEntry = {
      name: NEUTRAL_PREFIX + 'active focus context',
      vec: options.focusVec,
      seedVecs:
        options.focusSeedVecs && options.focusSeedVecs.length > 0
          ? options.focusSeedVecs
          : [options.focusVec],
    };
    focusSim = categorySimilarity(vec, focusCentroid, topKBlend);
    if (focusSim >= FOCUS_RESCUE_MIN_SIM) {
      activeCentroids.push(focusCentroid);
    }
  }

  const logits = activeCentroids.map((c) => categorySimilarity(vec, c, topKBlend) / temperature);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const ranked = activeCentroids
    .map((c, i) => ({ label: c.name, score: exps[i] / sum }))
    .sort((a, b) => b.score - a.score);

  let topScore = ranked[0].score;
  if (
    options?.hasExplicitGoal &&
    focusSim > -Infinity &&
    focusSim <= FOCUS_OFF_TASK_MAX_SIM &&
    !isNeutralLabel(ranked[0].label)
  ) {
    topScore = Math.min(1, topScore + FOCUS_OFF_TASK_PENALTY);
    ranked[0] = { label: ranked[0].label, score: topScore };
  }

  return {
    label: ranked[0].label,
    score: topScore,
    all: { labels: ranked.map((r) => r.label), scores: ranked.map((r) => r.score) },
  };
}

/**
 * Effective blocking confidence for a classifier verdict (Option C: Top-2
 * Blocked-Category Mass).
 *
 * When a page straddles two blocked categories at once (e.g. Steam Store =
 * video games + online shopping, Imgur = social media + memes), both blocked
 * categories split the softmax probability mass. If BOTH top-1 and top-2 are
 * in `blockedLabels`, their probabilities are summed (capped at 1). If top-2
 * is neutral or unblocked, only top-1's score is returned.
 */
export function effectiveBlockScore(
  verdict: { label: string; score: number; all?: { labels: string[]; scores: number[] } },
  blockedLabels: Iterable<string>,
): number {
  if (isNeutralLabel(verdict.label)) return 0;
  const blocked = blockedLabels instanceof Set ? blockedLabels : new Set(blockedLabels);
  if (!blocked.has(verdict.label)) return verdict.score;
  const labels = verdict.all?.labels;
  const scores = verdict.all?.scores;
  if (labels && scores && labels.length >= 2 && blocked.has(labels[1])) {
    return Math.min(1, scores[0] + scores[1]);
  }
  return verdict.score;
}
