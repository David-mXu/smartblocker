import assert from 'node:assert/strict';
import { classifierReliefAllowed, evaluateCategoryScheduleGate } from '../src/shared/category-schedule-math.ts';

const cases = [
  [{ forceBlocking: true, reasons: ['frozen'] }, 'none', false, 'Frozen cannot be relaxed'],
  [{ forceBlocking: true, reasons: ['schedule'] }, 'none', false, 'global forced schedules cannot be relaxed'],
  [{ forceBlocking: false, reasons: ['password'] }, 'none', false, 'password lock cannot be relaxed'],
  [{ forceBlocking: false, reasons: [] }, 'active-block', false, 'active scoped block cannot be relaxed'],
  [{ forceBlocking: false, reasons: [] }, 'inactive-rescue', true, 'inactive scoped rescue remains allowed'],
  [{ forceBlocking: false, reasons: ['partner'] }, 'none', true, 'unrelated ordinary lock reason does not change this isolated check'],
];
let passed = 0;
for (const [lock, effect, expected, name] of cases) {
  assert.equal(classifierReliefAllowed(lock, effect), expected, name);
  passed++;
}
const base = { id: 'work', days: [0, 1, 2, 3, 4, 5, 6], startMinutes: 0, endMinutes: 1439, tzOffsetMinutes: 0, categories: ['video games'] };
for (const normallyBlocked of [true, false]) {
  const gate = evaluateCategoryScheduleGate({ label: 'video games', score: 0.99 }, normallyBlocked, 0.5, [base], new Date());
  assert.equal(gate.effect, 'active-block');
  assert.equal(gate.blocked, true);
  assert.equal(classifierReliefAllowed({ forceBlocking: false, reasons: [] }, gate.effect), false, 'allowance cannot rescue an active scoped block');
  passed++;
}
console.log(`\n${passed} passed, 0 failed`);
