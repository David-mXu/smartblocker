// Unit tests for pure schedule-overlap detection and duplicate semantics.
//   node scripts/schedule-overlaps-test.mjs
//
// No browser or test runner: both modules are erasable-syntax-only and import
// directly under Node type stripping.
import assert from 'node:assert/strict';
import {
  findScheduleOverlaps,
  formatScheduleDays,
  formatScheduleWindow,
  hasScheduleOverlap,
} from '../src/shared/schedule-overlaps.ts';
import { duplicateScheduleRule, nextScheduleCopyLabel } from '../src/shared/schedule-edit.ts';
import { scheduleWindowMinutes, validateScheduleRule } from '../src/shared/lock-math.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${error.stack ?? error.message}`);
  }
}

const rule = (id, days, startMinutes, endMinutes, extra = {}) => ({
  id,
  days,
  startMinutes,
  endMinutes,
  ...extra,
});

const entry = (r, kind = 'global') => ({ rule: r, kind });
const opts = { firstDay: 0, hour24: true, deviceOffsetMinutes: 0 };
const overlaps = (a, b, options = {}) =>
  findScheduleOverlaps([entry(a), entry(b)], { ...opts, ...options });
const windowText = (r, kind = 'global') =>
  formatScheduleWindow(entry(r, kind), opts);

console.log('schedule-overlap tests');

test('window duration is the single shared lock-math primitive', () => {
  assert.equal(scheduleWindowMinutes(rule('a', [1], 9 * 60, 17 * 60)), 8 * 60);
  assert.equal(scheduleWindowMinutes(rule('a', [1], 22 * 60, 6 * 60)), 8 * 60);
  assert.equal(scheduleWindowMinutes(rule('a', [1], 9 * 60, 9 * 60)), 0);
});

test('no overlap on the same day returns an empty list', () => {
  const pairs = overlaps(
    rule('a', [1], 9 * 60, 12 * 60),
    rule('b', [1], 13 * 60, 17 * 60),
  );
  assert.deepEqual(pairs, []);
  assert.equal(
    hasScheduleOverlap([
      entry(rule('a', [1], 9 * 60, 12 * 60)),
      entry(rule('b', [1], 13 * 60, 17 * 60)),
    ], opts),
    false,
  );
});

test('windows that only touch at an endpoint do not overlap', () => {
  assert.deepEqual(
    overlaps(rule('a', [1], 9 * 60, 12 * 60), rule('b', [1], 12 * 60, 17 * 60)),
    [],
  );
});

test('partial overlap reports the pair and the shared [start,end) range', () => {
  const pairs = overlaps(
    rule('a', [1], 9 * 60, 17 * 60),
    rule('b', [1], 12 * 60, 18 * 60),
  );
  assert.equal(pairs.length, 1);
  const pair = pairs[0];
  assert.equal(pair.summary, 'Mon 09:00–17:00 overlaps Mon 12:00–18:00');
  assert.equal(pair.detail, 'Shared time: Mon 12:00–17:00.');
  assert.equal(pair.intervals.length, 1);
  assert.deepEqual(
    {
      day: pair.intervals[0].day,
      start: pair.intervals[0].startMinutes,
      endDay: pair.intervals[0].endDay,
      end: pair.intervals[0].endMinutes,
    },
    { day: 1, start: 12 * 60, endDay: 1, end: 17 * 60 },
  );
});

test('containment reports only the contained range', () => {
  const [pair] = overlaps(
    rule('outer', [1], 9 * 60, 17 * 60),
    rule('inner', [1], 12 * 60, 14 * 60),
  );
  assert.equal(pair.detail, 'Shared time: Mon 12:00–14:00.');
});

test('identical windows report the full identical range', () => {
  const [pair] = overlaps(
    rule('a', [1], 9 * 60, 17 * 60),
    rule('b', [1], 9 * 60, 17 * 60),
  );
  assert.equal(pair.summary, 'Mon 09:00–17:00 overlaps Mon 09:00–17:00');
  assert.equal(pair.detail, 'Shared time: Mon 09:00–17:00.');
});

test('overnight rule overlaps the next calendar day', () => {
  const [pair] = overlaps(
    rule('night', [1], 22 * 60, 6 * 60),
    rule('early', [2], 5 * 60, 7 * 60),
  );
  assert.equal(pair.summary, 'Mon 22:00–06:00 overlaps Tue 05:00–07:00');
  assert.equal(pair.detail, 'Shared time: Tue 05:00–06:00.');
});

test('two overnight rules overlap across midnight', () => {
  const [pair] = overlaps(
    rule('a', [1], 22 * 60, 6 * 60),
    rule('b', [1], 23 * 60, 1 * 60),
  );
  assert.equal(pair.detail, 'Shared time: Mon 23:00–Tue 01:00.');
});

test('Sunday-night windows wrap into Monday', () => {
  const [pair] = overlaps(
    rule('sun', [0], 23 * 60, 2 * 60),
    rule('mon', [1], 0, 60),
  );
  assert.equal(pair.detail, 'Shared time: Mon 00:00–01:00.');
});

test('different start days do not overlap', () => {
  assert.deepEqual(
    overlaps(rule('a', [1], 9 * 60, 17 * 60), rule('b', [2], 9 * 60, 17 * 60)),
    [],
  );
});

test('same timezone pin compares in the rule frame', () => {
  const pinned = (id, start, end) =>
    rule(id, [1], start, end, { tzOffsetMinutes: 330, tzName: 'Asia/Kolkata' });
  const [pair] = overlaps(
    pinned('a', 9 * 60, 17 * 60),
    pinned('b', 12 * 60, 18 * 60),
  );
  assert.equal(
    pair.summary,
    'Mon 09:00–17:00 (Asia/Kolkata) overlaps Mon 12:00–18:00 (Asia/Kolkata)',
  );
});

test('mixed pinned and device-local rules compare in one absolute frame', () => {
  const [pair] = overlaps(
    rule('local', [1], 9 * 60, 17 * 60),
    rule('pinned', [1], 4 * 60, 8 * 60, {
      tzOffsetMinutes: -300,
      tzName: 'America/New_York',
    }),
  );
  // 04:00–08:00 at UTC−5 is 09:00–13:00 at UTC, inside the local 09:00–17:00.
  assert.equal(
    pair.summary,
    'Mon 09:00–17:00 overlaps Mon 04:00–08:00 (America/New_York)',
  );
  assert.equal(pair.detail, 'Shared time: Mon 09:00–13:00.');
});

test('pinned rules on different offsets can overlap after conversion', () => {
  const [pair] = overlaps(
    rule('east', [1], 9 * 60, 17 * 60, { tzOffsetMinutes: 840, tzName: 'UTC+14' }),
    rule('west', [0], 12 * 60, 15 * 60, { tzOffsetMinutes: -720, tzName: 'UTC-12' }),
  );
  assert.equal(pair.summary, 'Mon 09:00–17:00 (UTC+14) overlaps Sun 12:00–15:00 (UTC-12)');
  assert.ok(pair.intervals.length > 0);
});

test('category rules include their categories and can be non-overlapping', () => {
  const [pair] = findScheduleOverlaps(
    [
      entry(rule('games', [1], 9 * 60, 17 * 60, { categories: ['video games'] }), 'category'),
      entry(rule('social', [1], 12 * 60, 18 * 60, { categories: ['social media'] }), 'category'),
    ],
    opts,
  );
  assert.equal(
    pair.summary,
    'Mon 09:00–17:00 · video games overlaps Mon 12:00–18:00 · social media',
  );
  assert.equal(pair.kind, 'category');
  assert.deepEqual(
    findScheduleOverlaps(
      [
        entry(rule('games', [1], 9 * 60, 12 * 60, { categories: ['video games'] }), 'category'),
        entry(rule('social', [1], 13 * 60, 17 * 60, { categories: ['social media'] }), 'category'),
      ],
      opts,
    ),
    [],
  );
});

test('weekly recurrence returns one canonical interval per day', () => {
  const [pair] = overlaps(
    rule('a', [0, 1, 2, 3, 4, 5, 6], 9 * 60, 17 * 60),
    rule('b', [0, 1, 2, 3, 4, 5, 6], 12 * 60, 18 * 60),
  );
  assert.equal(pair.intervals.length, 7);
  assert.equal(pair.detail, 'Shared time: Every day 12:00–17:00.');
});

test('pairs and intervals are deterministic', () => {
  const entries = [
    entry(rule('a', [1], 9 * 60, 17 * 60)),
    entry(rule('b', [1], 12 * 60, 18 * 60)),
    entry(rule('c', [1], 16 * 60, 20 * 60)),
  ];
  const first = findScheduleOverlaps(entries, opts);
  const second = findScheduleOverlaps(entries, opts);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((pair) => `${pair.aId}-${pair.bId}`),
    ['a-b', 'a-c', 'b-c'],
  );
});

test('invalid and empty rules are ignored', () => {
  const invalid = [
    entry(rule('empty-days', [], 9 * 60, 17 * 60)),
    entry(rule('zero-window', [1], 9 * 60, 9 * 60)),
    entry(rule('bad-day', [7], 9 * 60, 17 * 60)),
  ];
  const entries = [...invalid, entry(rule('valid', [1], 9 * 60, 17 * 60))];
  const pairs = findScheduleOverlaps(entries, opts);
  assert.deepEqual(pairs, []);
});

test('display preferences change the human summaries', () => {
  assert.equal(formatScheduleDays([1, 3, 5], 0), 'Mon, Wed, Fri');
  assert.equal(formatScheduleDays([1, 3, 5], 1), 'Mon, Wed, Fri');
  assert.equal(
    windowText(rule('a', [1], 9 * 60, 17 * 60)),
    'Mon 09:00–17:00',
  );
  assert.equal(
    formatScheduleWindow(entry(rule('a', [1], 9 * 60, 17 * 60)), {
      ...opts,
      hour24: false,
    }),
    'Mon 9:00 AM–5:00 PM',
  );
});

console.log('schedule duplicate tests');

test('duplicate gets a fresh id, fallback label, and cloned days', () => {
  const source = rule('source', [1, 2], 9 * 60, 17 * 60, {
    leadMinutes: 30,
    tzOffsetMinutes: 330,
    tzName: 'Asia/Kolkata',
  });
  const copy = duplicateScheduleRule(source, {
    fallbackLabel: 'Focus hours',
    idFactory: () => 'fresh-id',
  });
  assert.equal(copy.id, 'fresh-id');
  assert.equal(copy.label, 'Focus hours (copy)');
  assert.deepEqual(copy.days, [1, 2]);
  assert.notEqual(copy.days, source.days);
  assert.equal(copy.startMinutes, 9 * 60);
  assert.equal(copy.endMinutes, 17 * 60);
  assert.equal(copy.leadMinutes, 30);
  assert.equal(copy.tzOffsetMinutes, 330);
  assert.equal(copy.tzName, 'Asia/Kolkata');
  assert.equal(source.label, undefined);
  assert.equal(source.id, 'source');
});

test('duplicating an existing label numbers the copies', () => {
  assert.equal(nextScheduleCopyLabel('Deep work'), 'Deep work (copy)');
  assert.equal(nextScheduleCopyLabel('Deep work (copy)'), 'Deep work (copy 2)');
  assert.equal(nextScheduleCopyLabel('Deep work (copy 2)'), 'Deep work (copy 3)');
  assert.equal(nextScheduleCopyLabel(undefined, 'Focus hours'), 'Focus hours (copy)');
  const once = duplicateScheduleRule(rule('a', [1], 540, 1020, { label: 'Deep work' }), {
    idFactory: () => 'one',
  });
  const twice = duplicateScheduleRule(once, { idFactory: () => 'two' });
  assert.equal(once.label, 'Deep work (copy)');
  assert.equal(twice.label, 'Deep work (copy 2)');
});

test('duplicate labels respect the supported length bound', () => {
  const label = 'x'.repeat(120);
  const copy = duplicateScheduleRule(rule('a', [1], 540, 1020, { label }), {
    idFactory: () => 'copy',
  });
  assert.ok(copy.label.length <= 80, `label length ${copy.label.length}`);
  assert.ok(copy.label.endsWith(' (copy)'));
  assert.equal(nextScheduleCopyLabel('y'.repeat(200), 'Fallback').length <= 80, true);
});

test('the base validator accepts only bounded display labels', () => {
  assert.equal(validateScheduleRule(rule('a', [1], 540, 1020, { label: 'Deep work' })), null);
  assert.equal(
    validateScheduleRule(rule('a', [1], 540, 1020, { label: 'x'.repeat(80) })),
    null,
  );
  assert.equal(
    validateScheduleRule(rule('a', [1], 540, 1020, { label: 'x'.repeat(81) })),
    'Name must be at most 80 characters.',
  );
});

test('category duplication clones categories too', () => {
  const source = rule('cat', [1], 9 * 60, 17 * 60, {
    categories: ['video games', 'social media'],
  });
  const copy = duplicateScheduleRule(source, {
    fallbackLabel: 'Category schedule',
    idFactory: () => 'cat-copy',
  });
  assert.equal(copy.label, 'Category schedule (copy)');
  assert.deepEqual(copy.categories, ['video games', 'social media']);
  assert.notEqual(copy.categories, source.categories);
  assert.equal(copy.id, 'cat-copy');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
