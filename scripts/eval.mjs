// FlowGuard evaluation regression gate.
//
// Answers the question benchmark.mjs could not: "did that change make the model
// better?" Runs the SHIPPED config end-to-end over scripts/eval-dataset.json,
// scores the actual block/allow decision (whitelist + blocklist + threshold,
// not just classifier top-1), and diffs every case against the committed
// baseline in scripts/eval-baseline.json. Exits non-zero on any regression.
//
// Usage:
//   node scripts/eval.mjs                    offline replay, diff vs baseline
//   node scripts/eval.mjs --update-baseline  accept current results as the new baseline
//   node scripts/eval.mjs --capture          re-scrape live pages for cases with a `url`
//   node scripts/eval.mjs --capture --limit=5 --only=chase.com
//   node scripts/eval.mjs --verbose          also list every failing case
//
// The git history of eval-baseline.json IS the score history.
import { readFileSync, writeFileSync } from 'node:fs';

import {
  EVAL_SETTINGS,
  EMBED_MODEL_ID,
  SOFTMAX_TEMPERATURE,
  buildEmbedClassifier,
  classifierInputFor,
  fmtPct,
  loadDataset,
  runCases,
  scoreBySlice,
  scoreRecords,
  signalsFor,
} from './lib/eval-harness.mjs';

const DATASET_URL = new URL('./eval-dataset.json', import.meta.url);
const BASELINE_URL = new URL('./eval-baseline.json', import.meta.url);

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const VERBOSE = has('verbose');
const UPDATE = has('update-baseline');
const CAPTURE = has('capture');

// ── Case identity ───────────────────────────────────────────────────────────
// Stable across signal changes (so --capture doesn't orphan every baseline
// entry) but distinct for the deliberate title-only/enriched pairs, which share
// a title. The ordinal disambiguates those four; it only shifts if same-titled
// cases are reordered, which shows up as one fixed + one regressed, not silent
// drift.
function keyer() {
  const seen = new Map();
  return (c) => {
    const title = typeof c.input === 'string' ? c.input : c.input?.title ?? '';
    const base = `${c.url ?? ''}|${title}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  };
}

// ── Correctness bits ────────────────────────────────────────────────────────
// Tracked separately because they fail for different reasons: a wrong DECISION
// is what a user actually feels, while a wrong TOP-1 can be a harmless wobble
// between two neutral centroids (documented in CLAUDE.md). Both gate the exit
// code, but they are reported apart so you can tell which kind you caused.
const decisionOk = (r) => r.expectedDecision === null || r.decision === r.expectedDecision;
const top1Ok = (r) => !Array.isArray(r.expected) || r.expected.includes(r.label);

// ── Capture: scrape live pages with the REAL extractMeta ────────────────────

async function capture(dataset) {
  const { chromium } = await import('playwright');
  const { extractMeta } = await import('../src/content/extract-meta.ts');

  const only = flag('only', '');
  const limit = Number(flag('limit', '0'));
  // `noCapture` marks cases whose live page can't be scraped honestly: the URL
  // 404s, or the site bot-walls headless Chromium ("Access Denied", "Just a
  // moment...") where a real user's browser sails through. Capturing those
  // would swap a representative title for an error page and quietly corrupt
  // the case, so they stay on their hand-authored input until someone supplies
  // a working URL and clears the flag.
  const skipped = dataset.cases.filter((c) => c.url && c.noCapture).length;
  let targets = dataset.cases.filter((c) => c.url && !c.noCapture && (!only || c.url.includes(only)));
  if (limit > 0) targets = targets.slice(0, limit);
  if (skipped) console.log(`Skipping ${skipped} case(s) flagged noCapture.\n`);

  if (targets.length === 0) {
    console.log('No cases with a `url` to capture.');
    if (!only && !limit) {
      console.log('(The original 274 cases carry no URLs — capture applies to url-bearing cases.)');
    }
    return { ok: 0, failed: [] };
  }

  console.log(`Capturing ${targets.length} page(s) with a real browser...\n`);
  const browser = await chromium.launch();
  const CONCURRENCY = 4;
  let ok = 0;
  const failed = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const c = targets[i];
      const page = await browser.newPage({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      try {
        await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Give SPA shells a moment to paint a real title/description.
        await page.waitForTimeout(1200);
        // The exact function the extension injects — imported, not reimplemented.
        const meta = await page.evaluate(extractMeta);
        const title = await page.title();
        if (!title && !meta.channel && !meta.context) throw new Error('page yielded no signals');
        c.captured = { title, ...meta, at: Date.now() };
        ok++;
        console.log(`  ok   ${c.url}\n       title: ${title}`);
        if (meta.context) console.log(`       ctx:   ${meta.context.slice(0, 110)}`);
      } catch (e) {
        // A failed page keeps whatever capture it already had — never clobber
        // good ground truth with a transient network error.
        failed.push({ url: c.url, error: String(e.message).split('\n')[0] });
        console.log(`  FAIL ${c.url}\n       ${String(e.message).split('\n')[0]}`);
      } finally {
        await page.close();
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  writeFileSync(DATASET_URL, JSON.stringify(dataset, null, 2) + '\n');
  console.log(`\nCaptured ${ok}/${targets.length}; dataset updated.`);
  if (failed.length) {
    console.log(`${failed.length} failed (prior captures left intact):`);
    for (const f of failed) console.log(`  ${f.url} — ${f.error}`);
  }
  return { ok, failed };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function summaryLines(s) {
  return [
    ['top-1 accuracy', s.top1, s.top1Counts, false],
    ['productive FP rate', s.productiveFP, s.productiveFPCounts, true],
    ['must-block recall', s.mustBlockRecall, s.mustBlockCounts, false],
    ['collateral FP rate', s.collateralFP, s.collateralFPCounts, true],
    ['e2e decision accuracy', s.e2eAccuracy, s.e2eCounts, false],
  ];
}

function printSummary(label, s) {
  console.log(`\n── ${label} (${s.n} cases) ──`);
  for (const [name, val, counts] of summaryLines(s)) {
    console.log(`  ${name.padEnd(24)} ${fmtPct(val).padStart(6)}  (${counts[0]}/${counts[1]})`);
  }
  console.log(`  ${'latency p50/p95'.padEnd(24)} ${s.latencyP50.toFixed(0)}ms / ${s.latencyP95.toFixed(0)}ms`);
}

function delta(now, before) {
  if (now === null || before === null || before === undefined) return '';
  const d = now - before;
  if (Math.abs(d) < 0.05) return '   (=)';
  return `  (${d > 0 ? '+' : ''}${d.toFixed(1)})`;
}

// ── Main ────────────────────────────────────────────────────────────────────

const dataset = loadDataset(DATASET_URL);

if (CAPTURE) {
  await capture(dataset);
  console.log('\nRe-run without --capture to score against the baseline.');
  process.exit(0);
}

console.log(`Model: ${EMBED_MODEL_ID}  temp=${SOFTMAX_TEMPERATURE}  threshold=${EVAL_SETTINGS.blockThreshold}`);
const classify = await buildEmbedClassifier({ log: (m) => console.log(m) });

const records = await runCases(dataset.cases, classify);
const key = keyer();
for (const r of records) r.key = key(r.case);

const overall = scoreRecords(records);
const slices = scoreBySlice(records);

// Per-slice first: a harder v2 batch must not silently invalidate the v1
// numbers quoted throughout CLAUDE.md.
if (slices.size > 1) for (const [name, s] of slices) printSummary(`slice ${name}`, s);
printSummary('combined', overall);

if (VERBOSE) {
  console.log('\n── Failing cases ──');
  for (const r of records) {
    if (decisionOk(r) && top1Ok(r)) continue;
    const why = [!decisionOk(r) ? `DECISION ${r.decision}!=${r.expectedDecision}` : '', !top1Ok(r) ? 'TOP-1' : '']
      .filter(Boolean)
      .join(' + ');
    const exp = Array.isArray(r.expected) ? r.expected.join(' | ') : r.expected;
    console.log(`  [${why}] "${r.text}"\n      -> ${r.label} (${r.score.toFixed(2)}) via ${r.reason}, expected [${exp}]`);
  }
}

// ── Baseline diff ───────────────────────────────────────────────────────────

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
} catch {
  /* first run */
}

const current = {
  generatedAt: new Date().toISOString(),
  config: {
    modelId: EMBED_MODEL_ID,
    temperature: SOFTMAX_TEMPERATURE,
    threshold: EVAL_SETTINGS.blockThreshold,
    centroidCount: EVAL_SETTINGS.labels.length,
  },
  summary: Object.fromEntries(summaryLines(overall).map(([n, v]) => [n, v === null ? null : Number(v.toFixed(2))])),
  slices: Object.fromEntries(
    [...slices].map(([n, s]) => [n, Object.fromEntries(summaryLines(s).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(2))]))]),
  ),
  cases: Object.fromEntries(
    records.map((r) => [r.key, { label: r.label, score: Number(r.score.toFixed(4)), decision: r.decision }]),
  ),
};

let exitCode = 0;

if (!baseline) {
  console.log('\nNo baseline found — write one with:  node scripts/eval.mjs --update-baseline');
} else {
  const fixed = [];
  const regressed = [];
  const added = [];
  const removed = [];

  for (const r of records) {
    const b = baseline.cases[r.key];
    if (!b) {
      added.push(r);
      continue;
    }
    const nowOk = decisionOk(r) && top1Ok(r);
    const wasOk =
      (r.expectedDecision === null || b.decision === r.expectedDecision) &&
      (!Array.isArray(r.expected) || r.expected.includes(b.label));
    if (nowOk && !wasOk) fixed.push([r, b]);
    else if (!nowOk && wasOk) regressed.push([r, b]);
  }
  const liveKeys = new Set(records.map((r) => r.key));
  for (const k of Object.keys(baseline.cases)) if (!liveKeys.has(k)) removed.push(k);

  console.log(`\n── vs baseline (${baseline.generatedAt?.slice(0, 10) ?? 'unknown'}) ──`);
  const show = ([r, b]) => {
    const title = r.text.length > 62 ? r.text.slice(0, 59) + '...' : r.text;
    console.log(`      "${title}"\n        ${b.label} (${b.decision}) -> ${r.label} (${r.decision})`);
  };
  if (fixed.length) {
    console.log(`  FIXED      +${fixed.length}`);
    for (const f of fixed.slice(0, VERBOSE ? Infinity : 10)) show(f);
    if (!VERBOSE && fixed.length > 10) console.log(`      ... and ${fixed.length - 10} more (--verbose)`);
  }
  if (regressed.length) {
    console.log(`  REGRESSED  -${regressed.length}`);
    for (const f of regressed) show(f);
  }
  if (added.length) console.log(`  NEW         ${added.length} case(s) not in baseline`);
  if (removed.length) console.log(`  GONE        ${removed.length} baseline case(s) no longer present`);
  if (!fixed.length && !regressed.length && !added.length && !removed.length) {
    console.log('  no per-case changes');
  }

  console.log('');
  for (const [name, val, counts] of summaryLines(overall)) {
    const before = baseline.summary?.[name];
    console.log(
      `  ${name.padEnd(24)} ${fmtPct(before ?? null).padStart(6)} -> ${fmtPct(val).padStart(6)}${delta(val, before)}  (${counts[0]}/${counts[1]})`,
    );
  }

  if (regressed.length) {
    console.log(`\nFAIL: ${regressed.length} regression(s). Review them, or accept with --update-baseline.`);
    exitCode = 1;
  } else if (fixed.length) {
    console.log(`\nPASS: ${fixed.length} case(s) improved, none regressed.`);
  } else {
    console.log('\nPASS: no regressions.');
  }
}

if (UPDATE) {
  writeFileSync(BASELINE_URL, JSON.stringify(current, null, 2) + '\n');
  console.log(`\nBaseline written to scripts/eval-baseline.json (${records.length} cases).`);
  exitCode = 0;
}

process.exit(exitCode);
