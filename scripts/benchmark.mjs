// Model bake-off benchmark (Track B decision gate). Runs a candidate against
// scripts/eval-dataset.json and reports the metrics that matter for a blocker:
//   - top-1 accuracy (overall + per category) on labeled cases
//   - FALSE-POSITIVE RATE on productive negatives (the headline metric)
//   - must-block recall + collateral FP rate, with a threshold sweep table
//   - warm latency p50/p95
//
// Usage:
//   node scripts/benchmark.mjs nli:Xenova/nli-deberta-v3-xsmall [--template=0]
//   node scripts/benchmark.mjs embed:Xenova/all-MiniLM-L6-v2 [--temp=0.05]
//   [--verbose]  print every case, not just failures
//
// First run downloads the model from the HF Hub (cached in ~/.cache).
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';

// ── Keep in sync with src/shared/config.ts ──────────────────────────────────
const LABELS = [
  'programming and software development',
  'video games',
  'finance and investing',
  'memes and entertainment',
  'news and politics',
  'science and education',
  'music',
  'sports',
  'online shopping',
  'social media and networking',
  'gambling and betting',
  'movies and tv shows',
  'adult content',
];
const BLOCKED_LABELS = new Set([
  'video games',
  'memes and entertainment',
  'online shopping',
  'social media and networking',
  'gambling and betting',
  'adult content',
]);
const BLOCK_THRESHOLD = 0.5;

const HYPOTHESIS_TEMPLATES = [
  'This web page is about {}.', // 0 = what the extension ships (config.ts)
  'This video or post is about {}.', // 1 = smoke-test legacy phrasing
  'The topic of this page is {}.',
  'This page is primarily about {}.',
];

// ── Mirror of src/shared/build-input.ts buildClassifierText ─────────────────
const MAX_TOTAL = 300;
const MAX_CONTEXT = 200;
function buildClassifierText(input) {
  const title = (input.title ?? '').trim();
  const channel = (input.channel ?? '').trim();
  let context = (input.context ?? '').trim();
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT).trimEnd();
  const parts = [];
  let budget = MAX_TOTAL;
  if (title) {
    parts.push(title);
    budget -= title.length;
  }
  if (channel && budget > channel.length + 2) {
    parts.push(channel);
    budget -= channel.length + 2;
  }
  if (context) {
    const available = budget - 2;
    if (available > 10) {
      parts.push(available < context.length ? context.slice(0, available).trimEnd() : context);
    }
  }
  return parts.join('. ');
}

// ── CLI parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const candidate = args.find((a) => !a.startsWith('--'));
if (!candidate || !/^(nli|embed):/.test(candidate)) {
  console.error(
    'Usage: node scripts/benchmark.mjs <nli:modelId | embed:modelId> [--template=N] [--temp=T] [--verbose]',
  );
  process.exit(1);
}
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const VERBOSE = args.includes('--verbose');
const [kind, ...idParts] = candidate.split(':');
const modelId = idParts.join(':');
const templateIdx = Number(flag('template', '0'));
const temperature = Number(flag('temp', '0.05'));

const dataset = JSON.parse(
  readFileSync(new URL('./eval-dataset.json', import.meta.url), 'utf8'),
).cases;

// ── Candidate constructors: both return classify(text) -> {label, score} ────
// label may be 'neutral:<name>' for the embed candidate (never blocks).

async function makeNli() {
  const clf = await pipeline('zero-shot-classification', modelId, { dtype: 'q8' });
  const template = HYPOTHESIS_TEMPLATES[templateIdx];
  console.log(`hypothesis_template: "${template}"`);
  return async (text) => {
    const out = await clf(text, LABELS, { hypothesis_template: template, multi_label: false });
    return { label: out.labels[0], score: out.scores[0] };
  };
}

async function makeEmbed() {
  const seeds = JSON.parse(
    readFileSync(new URL('../src/shared/prototype-seeds.json', import.meta.url), 'utf8'),
  );
  const extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
  const embed = async (text) => {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  };
  const meanNormalize = (vecs) => {
    const dim = vecs[0].length;
    const mean = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] / vecs.length;
    const norm = Math.hypot(...mean);
    return mean.map((x) => x / norm);
  };
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

  console.log(`building centroids (temp=${temperature})...`);
  const t0 = performance.now();
  const centroids = [];
  for (const [group, neutral] of [
    [seeds.categories, false],
    [seeds.neutral, true],
  ]) {
    for (const [name, { description, examples }] of Object.entries(group)) {
      const vecs = [];
      for (const text of [description, ...examples]) vecs.push(await embed(text));
      centroids.push({ name, neutral, vec: meanNormalize(vecs) });
    }
  }
  console.log(
    `${centroids.length} centroids built in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  return async (text) => {
    const v = await embed(text);
    const sims = centroids.map((c) => dot(v, c.vec));
    const logits = sims.map((s) => s / temperature);
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let i = 1; i < exps.length; i++) if (exps[i] > exps[best]) best = i;
    const c = centroids[best];
    return { label: c.neutral ? `neutral:${c.name}` : c.name, score: exps[best] / sum };
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(`Candidate: ${candidate}`);
const tLoad = performance.now();
const classify = kind === 'nli' ? await makeNli() : await makeEmbed();
console.log(`ready in ${((performance.now() - tLoad) / 1000).toFixed(1)}s\n`);

// Warmup (excluded from latency stats).
await classify('warmup title one');
await classify('warmup title two');

const records = [];
for (const { input, expected } of dataset) {
  const text = typeof input === 'string' ? input : buildClassifierText(input);
  const t = performance.now();
  const { label, score } = await classify(text);
  const ms = performance.now() - t;
  records.push({ text, expected, label, score, ms, enriched: typeof input !== 'string' });
}

// ── Metrics ──────────────────────────────────────────────────────────────────
const labeled = records.filter((r) => Array.isArray(r.expected));
const productive = records.filter((r) => r.expected === 'productive');
const mustBlock = labeled.filter((r) => r.expected.every((l) => BLOCKED_LABELS.has(l)));
const neverBlock = labeled.filter((r) => !r.expected.some((l) => BLOCKED_LABELS.has(l)));

const isBlockDecision = (r, threshold) => BLOCKED_LABELS.has(r.label) && r.score >= threshold;

const pct = (n, d) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`);
const count = (rs, fn) => rs.filter(fn).length;

// Top-1 accuracy on labeled cases, grouped by expected[0].
const byCategory = new Map();
let top1 = 0;
for (const r of labeled) {
  const pass = r.expected.includes(r.label);
  if (pass) top1++;
  const cat = r.expected[0];
  const agg = byCategory.get(cat) ?? { pass: 0, total: 0 };
  agg.total++;
  if (pass) agg.pass++;
  byCategory.set(cat, agg);
  if (VERBOSE || !pass) {
    console.log(
      `${pass ? 'PASS' : 'FAIL'} "${r.text}"\n     -> ${r.label} (${r.score.toFixed(2)}), expected [${r.expected.join(' | ')}]`,
    );
  }
}
for (const r of productive) {
  const fp = isBlockDecision(r, BLOCK_THRESHOLD);
  if (VERBOSE || fp) {
    console.log(
      `${fp ? 'FALSE-POSITIVE' : 'ok   '} "${r.text}"\n     -> ${r.label} (${r.score.toFixed(2)}) [productive]`,
    );
  }
}

console.log('\n── Per-category top-1 accuracy ──');
for (const [cat, { pass, total }] of [...byCategory.entries()].sort()) {
  console.log(`  ${pct(pass, total).padStart(6)}  (${pass}/${total})  ${cat}`);
}

const lat = records.map((r) => r.ms).sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];

console.log('\n── Summary ──');
console.log(`  top-1 accuracy (labeled):        ${pct(top1, labeled.length)}  (${top1}/${labeled.length})`);
console.log(
  `  productive FP rate @${BLOCK_THRESHOLD}:         ${pct(count(productive, (r) => isBlockDecision(r, BLOCK_THRESHOLD)), productive.length)}  (${count(productive, (r) => isBlockDecision(r, BLOCK_THRESHOLD))}/${productive.length})  << headline`,
);
console.log(
  `  must-block recall @${BLOCK_THRESHOLD}:          ${pct(count(mustBlock, (r) => isBlockDecision(r, BLOCK_THRESHOLD)), mustBlock.length)}  (${count(mustBlock, (r) => isBlockDecision(r, BLOCK_THRESHOLD))}/${mustBlock.length})`,
);
console.log(
  `  collateral FP rate @${BLOCK_THRESHOLD}:         ${pct(count(neverBlock, (r) => isBlockDecision(r, BLOCK_THRESHOLD)), neverBlock.length)}  (${count(neverBlock, (r) => isBlockDecision(r, BLOCK_THRESHOLD))}/${neverBlock.length})  (music/sports/etc misread as blocked)`,
);
console.log(`  latency p50/p95 (warm):          ${p(0.5).toFixed(0)}ms / ${p(0.95).toFixed(0)}ms`);

console.log('\n── Threshold sweep (block decision) ──');
console.log('  thresh | productive FP | must-block recall | collateral FP');
for (let t = 0.3; t <= 0.91; t += 0.1) {
  const th = Math.round(t * 100) / 100;
  console.log(
    `   ${th.toFixed(2)}  |    ${pct(count(productive, (r) => isBlockDecision(r, th)), productive.length).padStart(6)}     |      ${pct(count(mustBlock, (r) => isBlockDecision(r, th)), mustBlock.length).padStart(6)}       |   ${pct(count(neverBlock, (r) => isBlockDecision(r, th)), neverBlock.length).padStart(6)}`,
  );
}
