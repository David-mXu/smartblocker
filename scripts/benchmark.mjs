// Model bake-off benchmark (Track B decision gate). Runs a CANDIDATE model
// against scripts/eval-dataset.json and reports the metrics that matter for a
// blocker:
//   - top-1 accuracy (overall + per category) on labeled cases
//   - FALSE-POSITIVE RATE on productive negatives (the headline metric)
//   - must-block recall + collateral FP rate, with a threshold sweep table
//   - end-to-end block/allow accuracy (whitelist + blocklist + threshold)
//   - warm latency p50/p95
//
// This is the tool for COMPARING candidates (models, temperatures, hypothesis
// templates). To check whether a change regressed the SHIPPED config, use
// `npm run eval` (scripts/eval.mjs), which diffs per-case against a committed
// baseline and exits non-zero on regressions.
//
// All scoring logic and the classifier construction live in
// ./lib/eval-harness.mjs, which imports the real src/shared modules. This file
// used to carry its own copies of LABELS, BLOCKED_LABELS, BLOCK_THRESHOLD, the
// softmax temperature, buildClassifierText and the centroid math; they drifted
// out of scope the moment config.ts changed. Don't reintroduce them.
//
// Usage:
//   node scripts/benchmark.mjs nli:Xenova/nli-deberta-v3-xsmall [--template=0]
//   node scripts/benchmark.mjs embed:Xenova/all-MiniLM-L6-v2 [--temp=0.05]
//   [--verbose]  print every case, not just failures
//
// First run downloads the model from the HF Hub (cached in ~/.cache).
import {
  EVAL_SETTINGS,
  SOFTMAX_TEMPERATURE,
  buildEmbedClassifier,
  buildNliClassifier,
  decideBlock,
  fmtPct,
  loadDataset,
  runCases,
  scoreRecords,
} from './lib/eval-harness.mjs';

// Hypothesis phrasings for the legacy NLI backend. Index 0 is what the
// extension ships (config.ts HYPOTHESIS_TEMPLATE, used when --template is
// omitted); the rest exist to A/B the wording.
const HYPOTHESIS_TEMPLATES = [
  null, // = config.ts HYPOTHESIS_TEMPLATE
  'This video or post is about {}.', // smoke-test legacy phrasing
  'The topic of this page is {}.',
  'This page is primarily about {}.',
];

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
// Defaults to config.ts SOFTMAX_TEMPERATURE — imported, not mirrored. Running
// at any other temperature silently deflates/inflates every threshold metric.
const temperature = Number(flag('temp', String(SOFTMAX_TEMPERATURE)));

const dataset = loadDataset();

console.log(`Candidate: ${candidate}`);
const tLoad = performance.now();
let classify;
if (kind === 'nli') {
  const template = HYPOTHESIS_TEMPLATES[templateIdx] ?? undefined;
  classify = await buildNliClassifier({ modelId, ...(template ? { template } : {}) });
  console.log(`hypothesis_template: "${template ?? '(config.ts default)'}"`);
} else {
  classify = await buildEmbedClassifier({
    modelId,
    temperature,
    log: (m) => console.log(m),
  });
}
console.log(`ready in ${((performance.now() - tLoad) / 1000).toFixed(1)}s\n`);

const records = await runCases(dataset.cases, classify);

// ── Per-case output ─────────────────────────────────────────────────────────
for (const r of records) {
  if (Array.isArray(r.expected)) {
    const pass = r.expected.includes(r.label);
    if (VERBOSE || !pass) {
      console.log(
        `${pass ? 'PASS' : 'FAIL'} "${r.text}"\n     -> ${r.label} (${r.score.toFixed(2)}), expected [${r.expected.join(' | ')}]`,
      );
    }
  } else if (r.expected === 'productive') {
    const fp = r.decision === 'block';
    if (VERBOSE || fp) {
      console.log(
        `${fp ? 'FALSE-POSITIVE' : 'ok   '} "${r.text}"\n     -> ${r.label} (${r.score.toFixed(2)}) [productive]`,
      );
    }
  }
}

const s = scoreRecords(records);

console.log('\n── Per-category top-1 accuracy ──');
for (const [cat, { pass, total }] of [...s.byCategory.entries()].sort()) {
  console.log(`  ${fmtPct((100 * pass) / total).padStart(6)}  (${pass}/${total})  ${cat}`);
}

const threshold = EVAL_SETTINGS.blockThreshold;
console.log('\n── Summary ──');
console.log(`  top-1 accuracy (labeled):        ${fmtPct(s.top1)}  (${s.top1Counts[0]}/${s.top1Counts[1]})`);
console.log(
  `  productive FP rate @${threshold}:         ${fmtPct(s.productiveFP)}  (${s.productiveFPCounts[0]}/${s.productiveFPCounts[1]})  << headline`,
);
console.log(
  `  must-block recall @${threshold}:          ${fmtPct(s.mustBlockRecall)}  (${s.mustBlockCounts[0]}/${s.mustBlockCounts[1]})`,
);
console.log(
  `  collateral FP rate @${threshold}:         ${fmtPct(s.collateralFP)}  (${s.collateralFPCounts[0]}/${s.collateralFPCounts[1]})  (music/sports/etc misread as blocked)`,
);
console.log(
  `  e2e decision accuracy @${threshold}:      ${fmtPct(s.e2eAccuracy)}  (${s.e2eCounts[0]}/${s.e2eCounts[1]})  (after whitelist/blocklist)`,
);
console.log(`  latency p50/p95 (warm):          ${s.latencyP50.toFixed(0)}ms / ${s.latencyP95.toFixed(0)}ms`);

console.log('\n── Threshold sweep (block decision) ──');
console.log('  thresh | productive FP | must-block recall | collateral FP');
for (let t = 0.3; t <= 0.91; t += 0.1) {
  const th = Math.round(t * 100) / 100;
  const sw = scoreRecords(records, EVAL_SETTINGS, th);
  console.log(
    `   ${th.toFixed(2)}  |    ${fmtPct(sw.productiveFP).padStart(6)}     |      ${fmtPct(sw.mustBlockRecall).padStart(6)}       |   ${fmtPct(sw.collateralFP).padStart(6)}`,
  );
}
