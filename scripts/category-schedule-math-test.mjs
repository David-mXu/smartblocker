// Unit tests for pure category-scoped schedule policy.
// Runs directly under Node >=22.6 type stripping; no browser or test runner.
//
//   node scripts/category-schedule-math-test.mjs
import assert from 'node:assert/strict';
import {
  evaluateCategoryScheduleGate,
  validateCategoryScheduleRule,
} from '../src/shared/category-schedule-math.ts';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${error.stack ?? error.message}`);
  }
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const atUtc = (day, hour, minute = 0) => new Date(Date.UTC(2026, 6, day, hour, minute));
const ACTIVE_NOW = atUtc(8, 12); // Wednesday 2026-07-08 12:00 UTC.
const INACTIVE_NOW = atUtc(8, 18);
const verdict = (label, score, all) => ({
  label,
  score,
  all: all ?? { labels: [label], scores: [score] },
});
const rule = (categories, overrides = {}) => ({
  id: 'category-window',
  days: ALL_DAYS,
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
  tzOffsetMinutes: 0,
  tzName: 'UTC',
  categories,
  ...overrides,
});
const gate = (
  v,
  normallyBlocked,
  rules,
  now = ACTIVE_NOW,
  blockThreshold = 0.5,
) => evaluateCategoryScheduleGate(v, normallyBlocked, blockThreshold, rules, now);

console.log('category-schedule-math tests');

await test('validation accepts ordinary, overnight, and maximum-size rules', () => {
  assert.equal(validateCategoryScheduleRule(rule(['video games'])), null);
  assert.equal(
    validateCategoryScheduleRule(
      rule(['a'.repeat(64)], { startMinutes: 22 * 60, endMinutes: 6 * 60 }),
    ),
    null,
  );
  const categories = Array.from({ length: 64 }, (_, i) => `category ${i}`);
  assert.equal(validateCategoryScheduleRule(rule(categories)), null);
});

await test('validation rejects missing, empty, and oversized category lists', () => {
  assert.equal(validateCategoryScheduleRule(rule([])), 'Pick at least one category.');
  assert.equal(validateCategoryScheduleRule(rule(null)), 'Pick at least one category.');
  assert.equal(validateCategoryScheduleRule(rule('video games')), 'Pick at least one category.');
  const categories = Array.from({ length: 65 }, (_, i) => `category ${i}`);
  assert.equal(validateCategoryScheduleRule(rule(categories)), 'Choose no more than 64 categories.');
});

await test('validation rejects malformed and oversized category strings', () => {
  assert.notEqual(validateCategoryScheduleRule(rule([42])), null);
  assert.notEqual(validateCategoryScheduleRule(rule([''])), null);
  assert.equal(
    validateCategoryScheduleRule(rule(['a'.repeat(65)])),
    'Categories must be nonempty strings of at most 64 characters.',
  );
});

await test('validation rejects whitespace padding, blank strings, and exact duplicates', () => {
  for (const category of [' video games', 'video games ', '\tvideo games', '   ', '\n']) {
    assert.equal(
      validateCategoryScheduleRule(rule([category])),
      'Categories cannot have leading or trailing whitespace.',
    );
  }
  assert.equal(
    validateCategoryScheduleRule(rule(['video games', 'video games'])),
    'Categories must be unique.',
  );
  assert.equal(validateCategoryScheduleRule(rule(['games', 'Games'])), null);
  assert.equal(validateCategoryScheduleRule(rule(['video games'])), null);
});

await test('validation reuses every base window check before category checks', () => {
  assert.equal(
    validateCategoryScheduleRule(rule([], { days: [] })),
    'Pick at least one day.',
  );
  assert.equal(
    validateCategoryScheduleRule(rule(['games'], { startMinutes: 600, endMinutes: 600 })),
    'Start and end times must differ.',
  );
  assert.notEqual(validateCategoryScheduleRule(rule(['games'], { days: [7] })), null);
  assert.notEqual(validateCategoryScheduleRule(rule(['games'], { endMinutes: 1440 })), null);
  assert.notEqual(validateCategoryScheduleRule(rule(['games'], { tzOffsetMinutes: 841 })), null);
  assert.notEqual(validateCategoryScheduleRule(rule(['games'], { tzName: 42 })), null);
});

await test('no rules preserve either normal classifier decision exactly', () => {
  assert.deepEqual(gate(verdict('video games', 0.9), false, []), {
    blocked: false,
    effect: 'none',
    categories: [],
  });
  assert.deepEqual(gate(verdict('video games', 0.9), true, []), {
    blocked: true,
    effect: 'none',
    categories: [],
  });
});

await test('an active matching window blocks a confident classifier verdict', () => {
  assert.deepEqual(gate(verdict('video games', 0.9), false, [rule(['video games'])]), {
    blocked: true,
    effect: 'active-block',
    categories: ['video games'],
  });
});

await test('an inactive matching window rescues a normal classifier block', () => {
  assert.deepEqual(gate(verdict('video games', 0.9), true, [rule(['video games'])], INACTIVE_NOW), {
    blocked: false,
    effect: 'inactive-rescue',
    categories: ['video games'],
  });
});

await test('active same-category overlap wins over inactive rules', () => {
  const active = rule(['video games'], { id: 'active' });
  const inactive = rule(['video games'], { id: 'inactive', startMinutes: 13 * 60 });
  const result = gate(verdict('video games', 0.9), false, [inactive, active]);
  assert.equal(result.blocked, true);
  assert.equal(result.effect, 'active-block');
  assert.deepEqual(result.categories, ['video games']);
});

await test('below-threshold active precedence cannot block or fall through to rescue', () => {
  const active = rule(['video games'], { id: 'active' });
  const inactive = rule(['video games'], { id: 'inactive', startMinutes: 13 * 60 });
  const result = gate(verdict('video games', 0.4999), false, [inactive, active]);
  assert.deepEqual(result, {
    blocked: false,
    effect: 'active-block',
    categories: ['video games'],
  });
  assert.equal(gate(verdict('video games', 0.5), false, [active]).blocked, true);
});

await test('a normal block remains blocked when the active gate applies', () => {
  const result = gate(verdict('video games', 0.1), true, [rule(['video games'])], ACTIVE_NOW, 0.8);
  assert.equal(result.blocked, true);
  assert.equal(result.effect, 'active-block');
});

await test('categories absent from every rule leave normal policy unchanged', () => {
  for (const normallyBlocked of [false, true]) {
    const result = gate(verdict('music', 0.99), normallyBlocked, [rule(['video games'])]);
    assert.deepEqual(result, { blocked: normallyBlocked, effect: 'none', categories: [] });
  }
});

await test('top-2 mass uses the complete active category set', () => {
  const v = verdict('video games', 0.4, {
    labels: ['video games', 'online shopping', 'music'],
    scores: [0.4, 0.3, 0.3],
  });
  const rules = [
    rule(['video games'], { id: 'games' }),
    rule(['online shopping'], { id: 'shopping' }),
  ];
  const result = gate(v, false, rules, ACTIVE_NOW, 0.6);
  assert.deepEqual(result, {
    blocked: true,
    effect: 'active-block',
    categories: ['video games', 'online shopping'],
  });
});

await test('an inactive runner-up category contributes no top-2 mass', () => {
  const v = verdict('video games', 0.4, {
    labels: ['video games', 'online shopping', 'music'],
    scores: [0.4, 0.3, 0.3],
  });
  const rules = [
    rule(['video games'], { id: 'games' }),
    rule(['online shopping'], { id: 'shopping', startMinutes: 13 * 60 }),
  ];
  const result = gate(v, false, rules, ACTIVE_NOW, 0.6);
  assert.equal(result.blocked, false);
  assert.equal(result.effect, 'active-block');
  assert.deepEqual(result.categories, ['video games']);
});

await test('overnight windows reuse start-day and end-exclusive schedule semantics', () => {
  const overnight = rule(['video games'], {
    id: 'overnight',
    days: [1],
    startMinutes: 22 * 60,
    endMinutes: 6 * 60,
  });
  assert.equal(gate(verdict('video games', 0.9), false, [overnight], atUtc(7, 3)).blocked, true);
  const ended = gate(verdict('video games', 0.9), true, [overnight], atUtc(7, 6));
  assert.equal(ended.blocked, false);
  assert.equal(ended.effect, 'inactive-rescue');
});

await test('pinned-offset windows ignore the machine timezone', () => {
  const pinned = rule(['video games'], {
    id: 'ist',
    days: [1],
    tzOffsetMinutes: 330,
    tzName: 'Asia/Kolkata',
  });
  const inside = new Date(Date.UTC(2026, 0, 5, 10, 30)); // Monday 16:00 IST.
  const outside = new Date(Date.UTC(2026, 0, 5, 12, 0)); // Monday 17:30 IST.
  assert.equal(gate(verdict('video games',  0.9), false, [pinned], inside).blocked, true);
  assert.equal(gate(verdict('video games', 0.9), true, [pinned], outside).effect, 'inactive-rescue');
});

await test('evaluation and validation do not mutate caller inputs or share output arrays', () => {
  const rules = [
    rule(['video games', 'online shopping'], { id: 'active' }),
    rule(['music'], { id: 'inactive', startMinutes: 13 * 60 }),
  ];
  const v = verdict('video games', 0.9);
  const now = new Date(ACTIVE_NOW);
  const snapshots = structuredClone({ rules, v, now });
  Object.freeze(now);
  for (const r of rules) {
    Object.freeze(r.days);
    Object.freeze(r.categories);
    Object.freeze(r);
  }
  Object.freeze(rules);
  Object.freeze(v.all.labels);
  Object.freeze(v.all.scores);
  Object.freeze(v.all);
  Object.freeze(v);

  assert.equal(validateCategoryScheduleRule(rules[0]), null);
  const result = gate(v, false, rules, now);
  result.categories.push('result only');
  assert.deepEqual({ rules, v, now }, snapshots);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
