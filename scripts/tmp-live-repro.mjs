// TEMP repro: classify the exact inputs from the user's live screenshot
// against the CURRENT tuned seeds. Not committed.
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/bge-small-en-v1.5';
const TEMP = 0.03;
const MAX_TOTAL = 300;
const MAX_CONTEXT = 200;

function buildClassifierText(input) {
  const title = (input.title ?? '').trim();
  const channel = (input.channel ?? '').trim();
  let context = (input.context ?? '').trim();
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT).trimEnd();
  const parts = [];
  let budget = MAX_TOTAL;
  if (title) { parts.push(title); budget -= title.length; }
  if (channel && budget > channel.length + 2) { parts.push(channel); budget -= channel.length + 2; }
  if (context) {
    const available = budget - 2;
    if (available > 10) parts.push(available < context.length ? context.slice(0, available).trimEnd() : context);
  }
  return parts.join('. ');
}

const seeds = JSON.parse(readFileSync(new URL('../src/shared/prototype-seeds.json', import.meta.url), 'utf8'));
const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const embed = async (t) => Array.from((await extractor(t, { pooling: 'mean', normalize: true })).data);
const meanNormalize = (vecs) => {
  const dim = vecs[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] / vecs.length;
  const norm = Math.hypot(...mean);
  return mean.map((x) => x / norm);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

const centroids = [];
for (const [group, neutral] of [[seeds.categories, false], [seeds.neutral, true]]) {
  for (const [name, { description, examples }] of Object.entries(group)) {
    const vecs = [];
    for (const text of [description, ...examples]) vecs.push(await embed(text));
    centroids.push({ name, neutral, vec: meanNormalize(vecs) });
  }
}

async function classify(text) {
  const v = await embed(text);
  const sims = centroids.map((c) => dot(v, c.vec));
  const logits = sims.map((s) => s / TEMP);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const ranked = centroids
    .map((c, i) => ({ name: (c.neutral ? 'neutral:' : '') + c.name, p: exps[i] / sum }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  return ranked;
}

const HOMEPAGE_CTX = 'Discover the innovative world of Apple and shop everything iPhone, iPad, Apple Watch, Mac, and Apple TV, plus explore accessories, entertainment, and expert device support.';
const BUY_CTX = 'Get a new MacBook Air laptop with the M5 chip from only $108.25 per month. Built for AI. Lightweight, with all-day battery life. Buy now at apple.com.';

const cases = [
  { name: 'homepage bare', input: { title: 'Apple' } },
  { name: 'homepage + og', input: { title: 'Apple', context: HOMEPAGE_CTX } },
  { name: 'buy page bare', input: { title: 'Buy MacBook Air - Apple' } },
  { name: 'buy page + og', input: { title: 'Buy MacBook Air - Apple', context: BUY_CTX } },
  { name: 'configurator bare', input: { title: 'Buy MacBook Air, 15-inch, M5 Chip, 10-core CPU, 10-core GPU, Midnight, 16GB memory, 512GB storage - Apple' } },
  { name: 'configurator + og', input: { title: 'Buy MacBook Air, 15-inch, M5 Chip, 10-core CPU, 10-core GPU, Midnight, 16GB memory, 512GB storage - Apple', context: BUY_CTX } },
];

for (const { name, input } of cases) {
  const text = buildClassifierText(input);
  const top = await classify(text);
  console.log(`\n== ${name}`);
  console.log(`   text: ${text}`);
  for (const { name: l, p } of top) console.log(`   ${(p * 100).toFixed(1).padStart(5)}%  ${l}`);
}
