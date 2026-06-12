// Node-side model quality/speed smoke test (no browser needed).
// Usage: node scripts/smoke-test.mjs [modelId]
import { pipeline } from '@huggingface/transformers';

const MODEL_ID = process.argv[2] ?? 'Xenova/mobilebert-uncased-mnli';

const LABELS = [
  'programming and software development',
  'video games',
  'finance and investing',
  'memes and entertainment',
  'news and politics',
  'science and education',
  'music',
  'sports',
];
const HYPOTHESIS_TEMPLATE = 'This video or post is about {}.';

// [title, acceptable top-1 labels]
const CASES = [
  ['Elden Ring Boss Fight', ['video games']],
  ['React Router Tutorial', ['programming and software development']],
  ['I spent 100 days in Hardcore Minecraft', ['video games']],
  ["How the Fed's rate decision affects your portfolio", ['finance and investing']],
  ['Top 10 memes of the week', ['memes and entertainment']],
  [
    'MIT 6.006 Introduction to Algorithms, Lecture 1',
    ['science and education', 'programming and software development'],
  ],
  ['lofi hip hop radio - beats to relax/study to', ['music']],
  ['Why TypeScript generics confuse everyone', ['programming and software development']],
  ['NBA Finals Game 7 highlights', ['sports']],
  ['Trump announces new tariff policy', ['news and politics']],
];

console.log(`Model: ${MODEL_ID}`);
const t0 = performance.now();
const clf = await pipeline('zero-shot-classification', MODEL_ID, { dtype: 'q8' });
console.log(`Pipeline loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

let passes = 0;
let totalMs = 0;
for (const [title, expected] of CASES) {
  const t = performance.now();
  const out = await clf(title, LABELS, {
    hypothesis_template: HYPOTHESIS_TEMPLATE,
    multi_label: false,
  });
  const ms = performance.now() - t;
  totalMs += ms;
  const pass = expected.includes(out.labels[0]);
  if (pass) passes++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} "${title}"\n` +
      `     -> ${out.labels[0]} (${out.scores[0].toFixed(2)}), ` +
      `runner-up: ${out.labels[1]} (${out.scores[1].toFixed(2)}) [${ms.toFixed(0)}ms]`,
  );
}
console.log(`\n${passes}/${CASES.length} passed, avg inference ${(totalMs / CASES.length).toFixed(0)}ms`);
