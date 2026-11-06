// Verifies dataset integrity, schema validity, duplicate keys, and strict
// train/test disjointness between src/shared/prototype-seeds.json and
// scripts/eval-dataset.json.
import { readFileSync } from 'node:fs';
import { LABELS } from '../src/shared/config.ts';
import { classifierInputFor, signalsFor } from './lib/eval-harness.mjs';

const seeds = JSON.parse(readFileSync(new URL('../src/shared/prototype-seeds.json', import.meta.url), 'utf8'));
const dataset = JSON.parse(readFileSync(new URL('./eval-dataset.json', import.meta.url), 'utf8'));

const EXPECTED_NEUTRAL_KEYS = [
  'work and productivity',
  'documentation and reference',
  'everyday errands and utilities',
  'accounts and sign-in',
  'career and learning',
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const validLabels = new Set(LABELS);

// 1. Validate prototype-seeds.json schema & keys
const catKeys = Object.keys(seeds.categories ?? {});
const neuKeys = Object.keys(seeds.neutral ?? {});

if (catKeys.length !== LABELS.length || !catKeys.every((k) => validLabels.has(k))) {
  throw new Error(`Invalid category keys in prototype-seeds.json: expected ${LABELS.length} LABELS`);
}
if (
  neuKeys.length !== EXPECTED_NEUTRAL_KEYS.length ||
  !neuKeys.every((k) => EXPECTED_NEUTRAL_KEYS.includes(k))
) {
  throw new Error(`Invalid neutral keys in prototype-seeds.json: ${neuKeys.join(', ')}`);
}

const seedSet = new Set();
const longSeeds = [];
let totalSeeds = 0;

for (const [cat, group] of Object.entries(seeds.categories)) {
  if (!group || typeof group.description !== 'string' || !Array.isArray(group.examples) || !group.examples.length) {
    throw new Error(`Invalid schema for category "${cat}" in prototype-seeds.json`);
  }
  for (const t of [group.description, ...group.examples]) {
    const n = norm(t);
    if (!n) throw new Error(`Empty seed in category "${cat}"`);
    if (seedSet.has(n)) throw new Error(`Duplicate seed text in prototype-seeds.json: "${t}"`);
    seedSet.add(n);
    if (n.length >= 15) longSeeds.push({ source: `category:${cat}`, text: n });
    totalSeeds++;
  }
}

for (const [name, group] of Object.entries(seeds.neutral)) {
  if (!group || typeof group.description !== 'string' || !Array.isArray(group.examples) || !group.examples.length) {
    throw new Error(`Invalid schema for neutral "${name}" in prototype-seeds.json`);
  }
  for (const t of [group.description, ...group.examples]) {
    const n = norm(t);
    if (!n) throw new Error(`Empty seed in neutral "${name}"`);
    if (seedSet.has(n)) throw new Error(`Duplicate seed text in prototype-seeds.json: "${t}"`);
    seedSet.add(n);
    if (n.length >= 15) longSeeds.push({ source: `neutral:${name}`, text: n });
    totalSeeds++;
  }
}

// 2. Validate eval-dataset.json cases, duplicate keys, & train/test disjointness
const collisions = [];
const duplicateKeys = [];
const bySlice = new Map();
const v1v2Keys = new Set();
const newSliceKeys = new Map();
let shortTitles = 0;
let emptyTitles = 0;
let focusCases = 0;

for (let i = 0; i < dataset.cases.length; i++) {
  const c = dataset.cases[i];
  const slice = c.set ?? 'v1';
  bySlice.set(slice, (bySlice.get(slice) ?? 0) + 1);

  if (
    i < 395 &&
    (slice === 'v3' || slice === 'v4' || slice === 'v5' || slice === 'v6' || slice === 'v7' || slice === 'v8')
  ) {
    throw new Error(`Case #${i} in original 395 cases was modified to set=${slice}`);
  }
  if (
    i >= 395 &&
    slice !== 'v3' &&
    slice !== 'v4' &&
    slice !== 'v5' &&
    slice !== 'v6' &&
    slice !== 'v7' &&
    slice !== 'v8'
  ) {
    throw new Error(`New case #${i} missing "set": "v3", "v4", "v5", "v6", "v7", or "v8"`);
  }
  if (c.focusContext) focusCases++;

  // Validate input schema
  if (typeof c.input !== 'string' && (!c.input || typeof c.input !== 'object' || typeof c.input.title !== 'string')) {
    throw new Error(`Case #${i} has invalid input schema: ${JSON.stringify(c.input)}`);
  }
  if (c.url !== undefined) {
    try {
      const u = new URL(c.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`Case #${i} has non-http(s) url: ${c.url}`);
      }
    } catch {
      throw new Error(`Case #${i} has invalid url: ${c.url}`);
    }
  }

  // Validate expected labels
  if (c.expected !== 'productive') {
    if (!Array.isArray(c.expected) || c.expected.length === 0) {
      throw new Error(`Case #${i} has invalid expected: ${JSON.stringify(c.expected)}`);
    }
    for (const l of c.expected) {
      if (!validLabels.has(l)) {
        throw new Error(`Case #${i} has unknown label "${l}"`);
      }
    }
  }

  // Key uniqueness check: `${c.url ?? ''}|${title}`
  const rawTitle = typeof c.input === 'string' ? c.input : (c.input?.title ?? '');
  if (rawTitle === '') emptyTitles++;
  else if (rawTitle.length < 5) shortTitles++;

  const baseKey = `${c.url ?? ''}|${rawTitle}`;
  if (
    slice === 'v3' ||
    slice === 'v4' ||
    slice === 'v5' ||
    slice === 'v6' ||
    slice === 'v7' ||
    slice === 'v8'
  ) {
    if (v1v2Keys.has(baseKey)) {
      duplicateKeys.push(`Case #${i} (${slice}) collides with v1/v2 key: "${baseKey}"`);
    }
    if (newSliceKeys.has(baseKey)) {
      duplicateKeys.push(`Case #${i} (${slice}) duplicates key at #${newSliceKeys.get(baseKey)}: "${baseKey}"`);
    }
    newSliceKeys.set(baseKey, i);
  } else {
    v1v2Keys.add(baseKey);
  }

  // Train/test collision checks (exact equality + substring >= 15 chars)
  const sig = signalsFor(c);
  const titleNorm = norm(sig.title);
  const authoredTitleNorm = norm(rawTitle);
  const fullNorm = norm(classifierInputFor(c));

  for (const tNorm of new Set([titleNorm, authoredTitleNorm].filter(Boolean))) {
    if (seedSet.has(tNorm)) {
      collisions.push(`Exact title collision on case #${i} (${slice}): "${tNorm}"`);
    }
    if (tNorm.length >= 15) {
      for (const s of longSeeds) {
        if (tNorm.includes(s.text) || s.text.includes(tNorm)) {
          collisions.push(
            `Substring overlap on case #${i} (${slice}) "${tNorm}" <-> seed (${s.source}) "${s.text}"`,
          );
        }
      }
    }
  }
  if (fullNorm && seedSet.has(fullNorm)) {
    collisions.push(`Exact full-input collision on case #${i} (${slice}): "${fullNorm}"`);
  }
}

console.log(`Seeds verified: ${totalSeeds} texts across ${catKeys.length} categories + ${neuKeys.length} neutral groups.`);
console.log(`Dataset verified: ${dataset.cases.length} total cases —`, Object.fromEntries(bySlice));
console.log(`Edge-case slices: ${shortTitles} short-title (<5 chars) cases, ${emptyTitles} empty-title ("") cases, ${focusCases} focus-context cases.`);

if (duplicateKeys.length > 0) {
  console.error(`FAIL: ${duplicateKeys.length} duplicate key(s) detected:`);
  for (const d of duplicateKeys) console.error('  -', d);
  process.exit(1);
}
if (collisions.length > 0) {
  console.error(`FAIL: ${collisions.length} train/test collision(s) detected:`);
  for (const col of collisions) console.error('  -', col);
  process.exit(1);
}
console.log('PASS: Zero duplicate v3 keys and zero train/test collisions between prototype-seeds.json and eval-dataset.json.');
