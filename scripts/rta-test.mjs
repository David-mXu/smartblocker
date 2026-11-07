// Unit tests for the opt-in adult-site deterministic rule (src/shared/rules.ts)
// and a source-level tripwire for its in-page sibling probe (probeAdultMeta in
// src/content/extract-meta.ts). Runs directly under Node >= 22.6 type
// stripping — rules.ts is kept erasable-syntax-only for exactly this reason.
//
//   node scripts/rta-test.mjs
//
// COVERAGE NOTE — the DOM probe (Settings.blockAdult signal #1) is covered by
// inspection here, not by execution, because extractMeta is a serialized
// in-page function that needs a real DOM. Its accepted inputs, mirrored from
// Cold Turkey's checkBlockAdult (docs/audits/
// 2026-11-07-cold-turkey-blocker-landscape-audit.md §1.1), are EXACTLY:
//
//   <meta name="rating" content="adult">
//   <meta name="rating" content="RTA-5042-1996-1400-1577-RTA">
//
// with the attribute VALUE matched case-insensitively (selector
// `meta[name="rating" i]`) and the content compared trimmed + lowercased
// against the two lowercase strings 'adult' and
// 'rta-5042-1996-1400-1577-rta'. The assertions at the bottom pin that
// contract against the extract-meta.ts source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAdultHost } from '../src/shared/rules.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log('rta / adult-host tests');

// --- isAdultHost: positives (.xxx TLD position) ---
test('exact .xxx second-level domain', () => {
  assert.equal(isAdultHost('example.xxx'), true);
});
test('deep subdomain of a .xxx domain', () => {
  assert.equal(isAdultHost('a.b.xxx'), true);
});
test('the bare TLD itself', () => {
  assert.equal(isAdultHost('xxx'), true);
});
test('subdomain literally named xxx inside the .xxx TLD', () => {
  assert.equal(isAdultHost('xxx.xxx'), true);
});
test('case-insensitive', () => {
  assert.equal(isAdultHost('ExAmPlE.XXX'), true);
});
test('trailing root dot (FQDN form)', () => {
  assert.equal(isAdultHost('example.xxx.'), true);
});
test('surrounding whitespace tolerated', () => {
  assert.equal(isAdultHost('  example.xxx  '), true);
});

// --- isAdultHost: negatives (xxx elsewhere than the TLD position) ---
test('xxx.com is a .com site, NOT .xxx', () => {
  assert.equal(isAdultHost('xxx.com'), false);
});
test('fooxxx.net — xxx inside a label is not the TLD', () => {
  assert.equal(isAdultHost('fooxxx.net'), false);
});
test('notxxx.co — suffix of a label is not the TLD', () => {
  assert.equal(isAdultHost('notxxx.co'), false);
});
test('sub.xxx.com — xxx mid-host is not the TLD', () => {
  assert.equal(isAdultHost('sub.xxx.com'), false);
});
test('near-miss TLD .xx', () => {
  assert.equal(isAdultHost('example.xx'), false);
});
test('empty hostname never matches', () => {
  assert.equal(isAdultHost(''), false);
});
test('localhost / IPs are untouched', () => {
  assert.equal(isAdultHost('localhost'), false);
  assert.equal(isAdultHost('127.0.0.1'), false);
});

// --- signal #1 contract: the meta strings probeAdultMeta accepts ---
// extractMeta cannot import rules.ts (it is serialized into the page), so the
// accepted strings live inline in extract-meta.ts. A future edit that loosens
// or renames the RTA check without updating the audit-derived contract trips
// this assertion. Review hint: real RTA tags in the wild may be padded or
// mixed-case — the probe trims and lowercases, so " Adult " and
// "RTA-5042-1996-1400-1577-RTA" are accepted spellings of the same strings.
const extractMetaSrc = readFileSync(
  new URL('../src/content/extract-meta.ts', import.meta.url),
  'utf8',
);
test('probe uses a case-insensitive <meta name="rating"> selector', () => {
  assert.ok(extractMetaSrc.includes('meta[name="rating" i]'));
});
test("probe accepts content 'adult' (lowercased compare)", () => {
  assert.ok(extractMetaSrc.includes("content === 'adult'"));
});
test('probe accepts the RTA tag rta-5042-1996-1400-1577-rta', () => {
  assert.ok(extractMetaSrc.includes('rta-5042-1996-1400-1577-rta'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
