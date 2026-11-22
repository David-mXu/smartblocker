// Pure tests for the title pipeline (src/shared/titles.ts cleanTitle).
//
// Why this suite exists: cleanTitle runs on EVERY page-controlled `<title>`
// before any classification, and the suffix alternation used to be quadratic
// in a long whitespace run. A page could supply a 2,000-space title and stall
// the service worker for ~15 seconds — no user rules required. These tests pin
// the bound, the timing, surrogate safety, and the ordinary suffix behavior.
import assert from 'node:assert/strict';
import { cleanTitle, MAX_TITLE_LENGTH, MAX_RAW_TITLE_LENGTH } from '../src/shared/titles.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('title pipeline tests');

test('ordinary suffixes still strip', () => {
  assert.equal(cleanTitle('React Router Tutorial - YouTube'), 'React Router Tutorial');
  assert.equal(cleanTitle('Some thread : r/webdev'), 'Some thread');
  assert.equal(cleanTitle('nvidia rtx 5090 - Google Search'), 'nvidia rtx 5090');
  assert.equal(cleanTitle('Elden Ring boss guide | YouTube'), 'Elden Ring boss guide');
});

test('generic and URL-shaped titles are rejected', () => {
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle('Loading...'), null);
  assert.equal(cleanTitle('New Tab'), null);
  assert.equal(cleanTitle('https://example.com/path'), null);
  assert.equal(cleanTitle('example.com/foo'), null);
});

test('CJK and short brand titles survive', () => {
  assert.equal(cleanTitle('淘宝'), '淘宝');
  assert.equal(cleanTitle('X'), 'X');
  assert.equal(cleanTitle('ESPN'), 'ESPN');
});

test('classification titles are capped at MAX_TITLE_LENGTH', () => {
  const out = cleanTitle('a'.repeat(10_000));
  assert.ok(out, 'long ASCII title survives as a string');
  assert.equal(out.length, MAX_TITLE_LENGTH);
});

test('raw titles are bounded before suffix regexes run', () => {
  // A raw bound larger than the output cap but far below pathological sizes.
  const raw = 'word '.repeat(10_000); // 50k chars
  const out = cleanTitle(raw);
  assert.ok(out && out.length <= MAX_TITLE_LENGTH);
  assert.ok(raw.length > MAX_RAW_TITLE_LENGTH);
});

test('whitespace-flood suffix probing is linear (was ~15s)', () => {
  const cases = [' '.repeat(2_000), ' '.repeat(2_000) + 'YouTube', '\n'.repeat(5_000) + ' - Google Search'];
  const t0 = performance.now();
  for (const c of cases) cleanTitle(c);
  const ms = performance.now() - t0;
  assert.ok(ms < 1_000, `whitespace-flood cleanTitle took ${ms.toFixed(1)}ms (expected < 1s; the old code took 1.4–15s)`);
});

test('truncation never emits a lone surrogate', () => {
  // 511 ASCII chars then an emoji straddles the 512 raw cutoff.
  const raw = 'a'.repeat(MAX_RAW_TITLE_LENGTH - 1) + '😀' + 'b'.repeat(100);
  const out = cleanTitle(raw);
  assert.ok(out);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), 'must not end on a high surrogate');
  assert.ok(!/[\uDC00-\uDFFF]/.test(out.slice(-1)), 'must not end on a low surrogate');
});

test('repeated calls with a huge title stay fast', () => {
  const raw = 'x'.repeat(1_000_000);
  const t0 = performance.now();
  cleanTitle(raw);
  const ms = performance.now() - t0;
  assert.ok(ms < 1_000, `1MB title took ${ms.toFixed(1)}ms`);
});

console.log(`\n${passed} passed, 0 failed`);
