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
  'online shopping',
  'social media and networking',
  'gambling and betting',
  'movies and tv shows',
  'adult content',
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
  // New Phase 2.6 categories — spot-check they land sensibly.
  ['Nike Air Max 90 - Buy Online', ['online shopping']],
  ['Black Friday deals: up to 70% off electronics', ['online shopping']],
  ['Home / X', ['social media and networking']],
  ['Best online casino bonuses 2026', ['gambling and betting']],
  ['Watch Dune: Part Two (2024) full movie', ['movies and tv shows']],
];

// ─── Richer-signal regression cases (mirrors buildClassifierText output) ─────
// These demonstrate that feeding channel + description context to the model
// fixes proper-noun blindness for titles the bare-title model mislabels.
//
// Format: [enrichedText, acceptableLabels, description]
// enrichedText is what buildClassifierText() would produce for the given input.
const ENRICHED_CASES = [
  // "Elden Ring Boss Fight" alone → sports (known model ceiling).
  // With channel + description context it should land on video games.
  [
    'Elden Ring Boss Fight. VaatiVidya. FromSoftware soulslike boss gameplay walkthrough',
    ['video games'],
    '"Elden Ring Boss Fight" enriched with channel + description',
  ],
  // "Hogwarts Legacy" — another recent proper noun the model may not know.
  [
    'Hogwarts Legacy 100% Walkthrough. PotterFan. Open world RPG Harry Potter game full playthrough',
    ['video games'],
    '"Hogwarts Legacy Walkthrough" enriched',
  ],
  // Subreddit context disambiguates ambiguous Reddit titles.
  [
    'Finally hit Diamond rank after 500 games. r/leagueoflegends. Ranked solo queue grind tips',
    ['video games'],
    'Reddit rank post enriched with subreddit r/leagueoflegends',
  ],
  // Finance post that looks like news without context.
  [
    'The Fed just moved. r/wallstreetbets. Interest rate hike impact on portfolio and stock market',
    ['finance and investing'],
    'Finance Reddit post enriched with subreddit + body snippet',
  ],
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

// ─── Enriched-signal regression suite ────────────────────────────────────────
console.log('\n── Richer-signal regression (buildClassifierText output) ──');
console.log('Shows how channel + description context fixes proper-noun blindness.\n');

let enrichedPasses = 0;
let enrichedTotalMs = 0;
for (const [text, expected, description] of ENRICHED_CASES) {
  const t = performance.now();
  const out = await clf(text, LABELS, {
    hypothesis_template: HYPOTHESIS_TEMPLATE,
    multi_label: false,
  });
  const ms = performance.now() - t;
  enrichedTotalMs += ms;
  const pass = expected.includes(out.labels[0]);
  if (pass) enrichedPasses++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} [${description}]\n` +
      `     input: "${text}"\n` +
      `     -> ${out.labels[0]} (${out.scores[0].toFixed(2)}), ` +
      `runner-up: ${out.labels[1]} (${out.scores[1].toFixed(2)}) [${ms.toFixed(0)}ms]`,
  );
}
console.log(
  `\n${enrichedPasses}/${ENRICHED_CASES.length} enriched passed, ` +
    `avg inference ${(enrichedTotalMs / ENRICHED_CASES.length).toFixed(0)}ms`,
);
