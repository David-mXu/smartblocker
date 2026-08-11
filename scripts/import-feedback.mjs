// Turn real user corrections into candidate evaluation cases.
//
// This is the harvest half of the feedback loop. The extension collects
// corrections (src/shared/feedback.ts), learns from them on-device
// (getPrototypeExamples), and — only if the user opted in — uploads them
// (feedback-uploader.ts) to feedback-worker/. Nothing read them back out until
// this script; PRIVACY.md promises shared records are "used solely to build
// better evaluation datasets and models", and this is what keeps that promise.
//
// Usage:
//   node scripts/import-feedback.mjs ~/Downloads/smartblocker-feedback-2026-07-29.json
//   node scripts/import-feedback.mjs --from-worker --endpoint=https://... --token=$EXPORT_TOKEN
//   [--min-agreement=2]  only keep corrections reported by N+ distinct installs
//
// OUTPUT IS A REVIEW QUEUE, NOT A COMMIT. It writes scripts/feedback-candidates.json
// and never touches eval-dataset.json or prototype-seeds.json. Two reasons,
// both real:
//   1. The ingest endpoint is unauthenticated by design, so a straight
//      D1 -> shipped-seeds path would be a data-poisoning vector.
//   2. A case is either TRAIN (prototype-seeds.json) or TEST (eval-dataset.json)
//      and never both — CLAUDE.md requires those stay disjoint. Only a human
//      can decide which side a new case belongs on.
import { readFileSync, writeFileSync } from 'node:fs';

import { loadDataset, signalsFor } from './lib/eval-harness.mjs';

const SEEDS_URL = new URL('../src/shared/prototype-seeds.json', import.meta.url);
const OUT_URL = new URL('./feedback-candidates.json', import.meta.url);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const FROM_WORKER = args.includes('--from-worker');
const MIN_AGREEMENT = Number(flag('min-agreement', '1'));
const inputPath = args.find((a) => !a.startsWith('--'));

const norm = (s) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Load records from either source, normalized to one shape ────────────────

async function fromWorker() {
  const endpoint = (flag('endpoint', '') || process.env.FEEDBACK_ENDPOINT || '').replace(/\/$/, '');
  const token = flag('token', '') || process.env.EXPORT_TOKEN || '';
  if (!endpoint) throw new Error('--from-worker needs --endpoint=<url> (or $FEEDBACK_ENDPOINT)');
  if (!token) throw new Error('--from-worker needs --token=<secret> (or $EXPORT_TOKEN)');

  const rows = [];
  let cursor = 0;
  for (;;) {
    const res = await fetch(`${endpoint}/v1/export?since=${cursor}&limit=500`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`export failed: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page.rows);
    cursor = page.nextCursor;
    console.log(`  fetched ${rows.length} row(s)...`);
    if (page.done) break;
  }
  // snake_case (D1 columns) -> the extension's camelCase shape.
  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    channel: r.channel ?? undefined,
    context: r.context ?? undefined,
    domain: r.domain,
    modelLabel: r.model_label,
    score: r.score,
    correctedLabel: r.corrected_label ?? undefined,
    modelId: r.model_id,
    ts: r.ts,
    installId: r.install_id,
  }));
}

function fromFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records)) {
    throw new Error('expected a FeedbackRecord[] (the options page "Export as JSON" file)');
  }
  // A local export is one install by definition.
  return records.map((r) => ({ ...r, installId: r.installId ?? 'local-export' }));
}

if (!FROM_WORKER && !inputPath) {
  console.error(
    'Usage:\n' +
      '  node scripts/import-feedback.mjs <exported-feedback.json>\n' +
      '  node scripts/import-feedback.mjs --from-worker --endpoint=<url> --token=<secret>\n' +
      '  [--min-agreement=N]',
  );
  process.exit(1);
}

const records = FROM_WORKER ? await fromWorker() : fromFile(inputPath);
console.log(`Loaded ${records.length} correction record(s).\n`);

// ── Dedup against what the eval set already covers ──────────────────────────

const dataset = loadDataset();
const existing = new Set();
for (const c of dataset.cases) {
  const { title } = signalsFor(c);
  existing.add(norm(title));
  if (c.url) existing.add(`${norm(title)}@${norm(new URL(c.url).hostname.replace(/^www\./, ''))}`);
}

// ── Disjointness guard: a case must never also be a training seed ───────────
// Enforced, not assumed. Contaminating the train/test split silently inflates
// every number the eval reports, and it is exactly the kind of thing that slips
// through when cases are added in bulk.
const seeds = JSON.parse(readFileSync(SEEDS_URL, 'utf8'));
const seedTexts = new Set();
for (const group of [seeds.categories, seeds.neutral]) {
  for (const { description, examples } of Object.values(group)) {
    seedTexts.add(norm(description));
    for (const e of examples) seedTexts.add(norm(e));
  }
}

// ── Group identical corrections, count distinct reporting installs ──────────

const groups = new Map();
for (const r of records) {
  if (!r.title) continue;
  const key = `${r.kind}|${norm(r.title)}|${norm(r.domain)}`;
  const g = groups.get(key) ?? {
    kind: r.kind,
    title: r.title,
    channel: r.channel,
    context: r.context,
    domain: r.domain,
    modelLabel: r.modelLabel,
    score: r.score,
    correctedLabel: r.correctedLabel,
    installs: new Set(),
    count: 0,
  };
  g.installs.add(r.installId);
  g.count++;
  // Keep the richest signals seen for this page.
  if (!g.channel && r.channel) g.channel = r.channel;
  if (!g.context && r.context) g.context = r.context;
  groups.set(key, g);
}

const skipped = { alreadyCovered: 0, seedCollision: 0, lowAgreement: 0, noLabel: 0 };
const candidates = [];

for (const g of groups.values()) {
  const t = norm(g.title);
  if (existing.has(t) || existing.has(`${t}@${norm(g.domain)}`)) {
    skipped.alreadyCovered++;
    continue;
  }
  if (seedTexts.has(t)) {
    skipped.seedCollision++;
    continue;
  }
  if (g.installs.size < MIN_AGREEMENT) {
    skipped.lowAgreement++;
    continue;
  }
  // A false negative carries the user's chosen category; a false positive means
  // "this was productive" and maps to the never-block expectation.
  const expected =
    g.kind === 'false_negative' ? (g.correctedLabel ? [g.correctedLabel] : null) : 'productive';
  if (!expected) {
    skipped.noLabel++;
    continue;
  }

  candidates.push({
    // No URL: records carry hostname only (PRIVACY.md), never full URLs. Add a
    // real URL by hand during review to make the case capture-able.
    url: `https://${g.domain}/`,
    input: { title: g.title, ...(g.channel && { channel: g.channel }), ...(g.context && { context: g.context }) },
    expected,
    set: 'feedback',
    note:
      `${g.kind} on ${g.domain}; model said "${g.modelLabel}" @${g.score?.toFixed?.(2) ?? g.score}; ` +
      `${g.installs.size} install(s), ${g.count} report(s)`,
    _review: {
      agreement: g.installs.size,
      reports: g.count,
      urlIsGuessed: true,
    },
  });
}

candidates.sort((a, b) => b._review.agreement - a._review.agreement || b._review.reports - a._review.reports);

writeFileSync(
  OUT_URL,
  JSON.stringify(
    {
      'review-note':
        'CANDIDATES ONLY — not part of any eval run. Review each case, replace the guessed ' +
        '`url` with the real page URL, confirm `expected`, then move it into eval-dataset.json ' +
        '(test) or prototype-seeds.json (train) — never both. Delete this file when done.',
      generatedAt: new Date().toISOString(),
      source: FROM_WORKER ? 'worker' : inputPath,
      candidates,
    },
    null,
    2,
  ) + '\n',
);

console.log(`${candidates.length} candidate case(s) -> scripts/feedback-candidates.json`);
console.log(`  skipped ${skipped.alreadyCovered} already covered by the eval set`);
console.log(`  skipped ${skipped.seedCollision} colliding with training seeds (train/test split)`);
console.log(`  skipped ${skipped.lowAgreement} below --min-agreement=${MIN_AGREEMENT}`);
console.log(`  skipped ${skipped.noLabel} false negatives with no corrected label`);
if (candidates.length) {
  console.log('\nEach `url` is GUESSED from the hostname (records never contain full URLs).');
  console.log('Fix them during review, then run: node scripts/eval.mjs --capture');
}
