// Shared evaluation harness for scripts/eval.mjs (regression gate) and
// scripts/benchmark.mjs (model bake-off).
//
// DESIGN RULE: this file imports the REAL production modules from src/shared/
// and never re-implements them. Before this existed, benchmark.mjs carried its
// own copies of LABELS, BLOCKED_LABELS, BLOCK_THRESHOLD, the softmax
// temperature, buildClassifierText and the centroid math — so a config change
// could silently leave the benchmark scoring something the extension no longer
// does. If you find yourself pasting a constant in here, import it instead.
//
// Node >= 22.6 type-stripping loads the .ts modules directly; that is also why
// src/shared/prototypes.ts carries an import attribute on its JSON import.
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';

import {
  BLOCKED_LABELS,
  BLOCK_THRESHOLD,
  DEFAULT_WHITELIST,
  EMBED_MODEL_ID,
  HYPOTHESIS_TEMPLATE,
  LABELS,
  SOFTMAX_TEMPERATURE,
} from '../../src/shared/config.ts';
import { buildClassifierText } from '../../src/shared/build-input.ts';
import {
  centroidSpecs,
  classifyBySimilarity,
  effectiveBlockScore,
  isNeutralLabel,
  meanNormalize,
} from '../../src/shared/prototypes.ts';
import { cleanTitle, isWhitelisted, matchedBlocklistEntry } from '../../src/shared/titles.ts';
import { isAdultHost, matchChannel, matchTitleRule } from '../../src/shared/rules.ts';
import { applyUrlSignals, hostnameOf, urlFallbackTitle } from '../../src/shared/url-signals.ts';

export { BLOCKED_LABELS, BLOCK_THRESHOLD, EMBED_MODEL_ID, LABELS, SOFTMAX_TEMPERATURE };

/**
 * Equivalent of settings.ts DEFAULTS. Not imported directly because settings.ts
 * pulls in api.ts (browser globals) and uses bundler-style extensionless
 * imports that Node can't resolve. Every value below is composed from the same
 * config.ts constants settings.ts composes, so the two cannot disagree.
 */
export const EVAL_SETTINGS = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  whitelist: [...DEFAULT_WHITELIST],
  blocklist: [],
  // Matches settings.ts DEFAULTS (opt-in, OFF). Kept false here so the adult
  // gates inside decideBlock are a no-op for the committed dataset.
  blockAdult: false,
  titleRules: [],
  channelBlocklist: [],
  channelAllowlist: [],
};

// ── Dataset ─────────────────────────────────────────────────────────────────

export function loadDataset(url = new URL('../eval-dataset.json', import.meta.url)) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * The page signals a case classifies with. `captured` (written by
 * `eval.mjs --capture`, scraped from the live page by the real extractMeta)
 * wins over the hand-authored `input`, so upgrading a case from guessed to
 * real signals is a reviewable diff rather than a silent rewrite.
 */
export function signalsFor(c) {
  if (c.captured) {
    return {
      title: c.captured.title ?? (typeof c.input === 'string' ? c.input : c.input?.title ?? ''),
      channel: c.captured.channel ?? c.channel,
      context: c.captured.context,
      adultContent: c.captured.adultContent,
      source: 'captured',
    };
  }
  if (typeof c.input === 'string') return { title: c.input, channel: c.channel, source: 'title-only' };
  return { ...c.input, channel: c.input?.channel ?? c.channel, source: 'authored' };
}

/**
 * Build the exact string the classifier sees, through the same path as
 * blocker.ts onTitle: cleanTitle (with URL fallback when empty/placeholder) ->
 * DOM/captured meta -> applyUrlSignals (hostname fallback + path hint) ->
 * buildClassifierText.
 */
export function classifierInputFor(c) {
  const { title: rawTitle, channel, context } = signalsFor(c);
  const title = cleanTitle(rawTitle) ?? (c.url ? (urlFallbackTitle(c.url) ?? '') : '');
  const withUrl = c.url ? applyUrlSignals(c.url, { channel, context }) : { channel, context };
  return buildClassifierText({ title, channel: withUrl.channel, context: withUrl.context });
}

// ── Expected outcome ────────────────────────────────────────────────────────
// Mirrors the original benchmark's slicing so historical numbers stay
// comparable: a case is "must block" only when EVERY acceptable label is
// blocked, and "never block" only when NONE is. Mixed cases (e.g.
// ['sports','gambling and betting']) are genuinely ambiguous and are excluded
// from block-decision scoring rather than guessed at.

export function expectedDecision(c) {
  if (c.expected === 'productive') return 'allow';
  if (!Array.isArray(c.expected)) return null;
  if (c.expected.every((l) => BLOCKED_LABELS.has(l))) return 'block';
  if (!c.expected.some((l) => BLOCKED_LABELS.has(l))) return 'allow';
  return null; // ambiguous — not scored end-to-end
}

/**
 * The shipped block decision, mirroring blocker.ts onTitle's ladder:
 * whitelist exemption -> deterministic checks (URL blocklist, title rules,
 * opt-in adult signals) -> channel rules -> classifier verdict. Cases without
 * a `url` skip the URL-dependent gates, exactly as a case with no URL context
 * would. Returns { decision, reason }.
 */
export function decideBlock(c, verdict, settings = EVAL_SETTINGS, threshold = settings.blockThreshold) {
  if (c.url && isWhitelisted(c.url, settings.whitelist)) {
    return { decision: 'allow', reason: 'whitelist' };
  }
  const { title, channel, context } = signalsFor(c);
  // Channel rules see the same channel the classifier saw: with a URL, the
  // applyUrlSignals hostname fallback fills a missing channel exactly as in
  // blocker.ts.
  const rulesChannel = c.url ? applyUrlSignals(c.url, { channel, context }).channel : channel;
  if (c.url) {
    const hit = matchedBlocklistEntry(c.url, title, settings.blocklist);
    if (hit) return { decision: 'block', reason: `blocklist:${hit}` };
    // Title rules match the CLEANED title with the URL-fallback path — the
    // same string the classifier-side of the ladder sees.
    const titleHit = matchTitleRule(
      cleanTitle(title) ?? (urlFallbackTitle(c.url) ?? ''),
      settings.titleRules,
    );
    if (titleHit) return { decision: 'block', reason: `title-rule:${titleHit}` };
    // Opt-in adult blocking (settings.blockAdult, default OFF) — signal #2:
    // any host inside the .xxx TLD blocks deterministically. Positioned with
    // the URL blocklist: after the whitelist (a deliberate whitelist entry
    // for a .xxx domain still wins) and before the classifier — with the
    // user-authored rules taking reason precedence on a double match,
    // exactly as blocker.ts's label chain does.
    // No-op whenever blockAdult is off — including every committed case.
    if (settings.blockAdult && isAdultHost(hostnameOf(c.url))) {
      return { decision: 'block', reason: 'adult' };
    }
  }
  // Opt-in adult blocking — signal #1: the page self-declared an adult
  // rating via <meta name="rating">, surfaced by the real extractMeta into
  // captured/authored inputs.
  if (settings.blockAdult && signalsFor(c).adultContent === true) {
    return { decision: 'block', reason: 'adult' };
  }
  // Channel rules (Phase 5): channelBlocklist blocks deterministically
  // between the deterministic URL/title/adult gates and the classifier.
  const channelBlockHit = matchChannel(rulesChannel ?? null, settings.channelBlocklist ?? []);
  if (channelBlockHit) return { decision: 'block', reason: `channel-block:${channelBlockHit}` };
  // Neutral centroids carry NEUTRAL_PREFIX and can never appear in
  // blockedLabels; the explicit guard documents that invariant.
  if (isNeutralLabel(verdict.label)) return { decision: 'allow', reason: 'neutral' };
  const effScore = effectiveBlockScore(verdict, settings.blockedLabels);
  const blocked =
    settings.blockedLabels.includes(verdict.label) && effScore >= threshold;
  // channelAllowlist rescues ONLY a classifier verdict, never a rule hit.
  if (blocked && matchChannel(rulesChannel ?? null, settings.channelAllowlist ?? [])) {
    return { decision: 'allow', reason: 'channel-allow' };
  }
  return { decision: blocked ? 'block' : 'allow', reason: 'classifier' };
}

// ── Classifier backends ─────────────────────────────────────────────────────

async function embedder(modelId) {
  const extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
  return async (text) => {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  };
}

/**
 * The shipped 'embed' backend, offline. Uses the real centroidSpecs (so seed
 * edits and user corrections flow through) and the real classifyBySimilarity.
 */
export async function buildEmbedClassifier({
  modelId = EMBED_MODEL_ID,
  temperature = SOFTMAX_TEMPERATURE,
  labels = EVAL_SETTINGS.labels,
  userExamples = {},
  log = () => {},
} = {}) {
  const embed = await embedder(modelId);
  const specs = centroidSpecs(labels, userExamples);
  log(`building ${specs.length} centroids (temp=${temperature})...`);
  const t0 = performance.now();
  const centroids = [];
  for (const spec of specs) {
    const vecs = [];
    for (const text of spec.texts) vecs.push(await embed(text));
    centroids.push({ name: spec.name, vec: meanNormalize(vecs), seedVecs: vecs });
  }
  log(`centroids built in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const focusCache = new Map();
  async function resolveFocus(fc) {
    if (!fc) return { vec: null, seedVecs: [], hasExplicitGoal: false };
    const goal = (fc.focusGoal ?? '').trim();
    const tabs = (fc.openTabTitles ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 6);
    if (!goal && tabs.length === 0) return { vec: null, seedVecs: [], hasExplicitGoal: false };
    const key = `${goal.toLowerCase()}\x1f${tabs.map((t) => t.toLowerCase()).join('\x1e')}`;
    if (focusCache.has(key)) return focusCache.get(key);
    const vecs = [];
    if (goal) vecs.push(await embed(goal));
    for (const t of tabs) vecs.push(await embed(t));
    let combined;
    let seedVecs;
    if (goal && tabs.length > 0) {
      const goalVec = vecs[0];
      const tabsMean = meanNormalize(vecs.slice(1));
      combined = meanNormalize([goalVec, goalVec, tabsMean]);
      seedVecs = [goalVec, goalVec, ...vecs.slice(1)];
    } else {
      combined = meanNormalize(vecs);
      seedVecs = vecs;
    }
    const res = { vec: combined, seedVecs, hasExplicitGoal: Boolean(goal) };
    focusCache.set(key, res);
    return res;
  }
  return async (text, focusContext) => {
    const [textVec, focus] = await Promise.all([embed(text), resolveFocus(focusContext)]);
    const { label, score, all } = classifyBySimilarity(textVec, centroids, temperature, {
      focusVec: focus.vec,
      focusSeedVecs: focus.seedVecs,
      hasExplicitGoal: focus.hasExplicitGoal,
    });
    return { label, score, all };
  };
}

/** The legacy 'nli' backend — kept so the bake-off comparison still runs. */
export async function buildNliClassifier({
  modelId,
  template = HYPOTHESIS_TEMPLATE,
  labels = EVAL_SETTINGS.labels,
} = {}) {
  const clf = await pipeline('zero-shot-classification', modelId, { dtype: 'q8' });
  return async (text) => {
    const out = await clf(text, labels, { hypothesis_template: template, multi_label: false });
    return { label: out.labels[0], score: out.scores[0] };
  };
}

// ── Run + score ─────────────────────────────────────────────────────────────

export async function runCases(cases, classify, settings = EVAL_SETTINGS) {
  // Warmup passes are excluded from latency stats.
  await classify('warmup title one');
  await classify('warmup title two');

  const records = [];
  for (const c of cases) {
    const text = classifierInputFor(c);
    const fc =
      c.focusContext ??
      (c.focusGoal || c.openTabTitles
        ? { focusGoal: c.focusGoal, openTabTitles: c.openTabTitles }
        : undefined);
    const t = performance.now();
    const verdict = await classify(text, fc);
    const ms = performance.now() - t;
    const { decision, reason } = decideBlock(c, verdict, settings);
    records.push({
      case: c,
      set: c.set ?? 'v1',
      text,
      expected: c.expected,
      label: verdict.label,
      score: verdict.score,
      all: verdict.all,
      decision,
      reason,
      expectedDecision: expectedDecision(c),
      ms,
    });
  }
  return records;
}

const pctNum = (n, d) => (d === 0 ? null : (100 * n) / d);

/**
 * Score a set of records. `threshold` re-derives block decisions so the
 * benchmark's sweep can reuse this without re-running inference.
 */
export function scoreRecords(records, settings = EVAL_SETTINGS, threshold = settings.blockThreshold) {
  const at = (r) =>
    decideBlock(r.case, { label: r.label, score: r.score, all: r.all }, settings, threshold).decision;

  const labeled = records.filter((r) => Array.isArray(r.expected));
  const productive = records.filter((r) => r.expected === 'productive');
  const mustBlock = labeled.filter((r) => r.expected.every((l) => BLOCKED_LABELS.has(l)));
  const neverBlock = labeled.filter((r) => !r.expected.some((l) => BLOCKED_LABELS.has(l)));

  const top1 = labeled.filter((r) => r.expected.includes(r.label)).length;
  const productiveFP = productive.filter((r) => at(r) === 'block').length;
  const mustBlockHit = mustBlock.filter((r) => at(r) === 'block').length;
  const collateralFP = neverBlock.filter((r) => at(r) === 'block').length;

  // End-to-end: did the product make the right call? This is the number a user
  // actually experiences, and the only one that accounts for whitelist,
  // blocklist and neutral centroids.
  const scorable = records.filter((r) => r.expectedDecision !== null);
  const e2eCorrect = scorable.filter((r) => at(r) === r.expectedDecision).length;

  const byCategory = new Map();
  for (const r of labeled) {
    const cat = r.expected[0];
    const agg = byCategory.get(cat) ?? { pass: 0, total: 0 };
    agg.total++;
    if (r.expected.includes(r.label)) agg.pass++;
    byCategory.set(cat, agg);
  }

  const lat = records.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0);

  return {
    n: records.length,
    top1: pctNum(top1, labeled.length),
    top1Counts: [top1, labeled.length],
    productiveFP: pctNum(productiveFP, productive.length),
    productiveFPCounts: [productiveFP, productive.length],
    mustBlockRecall: pctNum(mustBlockHit, mustBlock.length),
    mustBlockCounts: [mustBlockHit, mustBlock.length],
    collateralFP: pctNum(collateralFP, neverBlock.length),
    collateralFPCounts: [collateralFP, neverBlock.length],
    e2eAccuracy: pctNum(e2eCorrect, scorable.length),
    e2eCounts: [e2eCorrect, scorable.length],
    byCategory,
    latencyP50: q(0.5),
    latencyP95: q(0.95),
  };
}

/** Group records by their `set` tag so a harder v2 batch never silently
 *  invalidates comparisons against historical v1 numbers. */
export function scoreBySlice(records, settings = EVAL_SETTINGS) {
  const slices = new Map();
  for (const r of records) {
    if (!slices.has(r.set)) slices.set(r.set, []);
    slices.get(r.set).push(r);
  }
  const out = new Map();
  for (const [name, rs] of [...slices.entries()].sort()) out.set(name, scoreRecords(rs, settings));
  return out;
}

export const fmtPct = (v) => (v === null ? '  n/a' : `${v.toFixed(1)}%`);
