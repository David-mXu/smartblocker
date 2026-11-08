// Unit tests for the pure typed-surrender wall (src/shared/surrender.ts).
// Runs directly under Node >= 22.6 type stripping.
//
//   node scripts/surrender-test.mjs
import assert from 'node:assert/strict';
import {
  canSubmit,
  isPhraseMatch,
  SURRENDER_DELAY_MS,
  SURRENDER_PHRASE,
  surrenderDeadline,
} from '../src/shared/surrender.ts';

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

const START = 1_700_000_000_000;

console.log('surrender tests');

test('fixed phrase is neutral and within the 80–110 character budget', () => {
  assert.equal(
    SURRENDER_PHRASE,
    'I am choosing to open this page for a good reason, and I will return to my task.',
  );
  assert.ok(SURRENDER_PHRASE.length >= 80 && SURRENDER_PHRASE.length <= 110);
});

test('deadline is pure addition and the shipped pause is 15 seconds', () => {
  assert.equal(SURRENDER_DELAY_MS, 15_000);
  assert.equal(surrenderDeadline(START, SURRENDER_DELAY_MS), START + 15_000);
  assert.equal(surrenderDeadline(START, 250), START + 250);
});

test('an exact early message cannot fire', () => {
  assert.equal(canSubmit(START, START, SURRENDER_PHRASE), false);
  assert.equal(canSubmit(START + SURRENDER_DELAY_MS - 1, START, SURRENDER_PHRASE), false);
});

test('the exact deadline edge accepts an exact phrase', () => {
  assert.equal(canSubmit(START + SURRENDER_DELAY_MS, START, SURRENDER_PHRASE), true);
});

test('an exact phrase remains acceptable after the deadline', () => {
  assert.equal(canSubmit(START + SURRENDER_DELAY_MS + 1, START, SURRENDER_PHRASE), true);
});

test('only surrounding whitespace is trimmed', () => {
  assert.equal(isPhraseMatch(`  ${SURRENDER_PHRASE}\n`, SURRENDER_PHRASE), true);
  assert.equal(canSubmit(START + SURRENDER_DELAY_MS, START, `\t${SURRENDER_PHRASE}  `), true);
});

test('internal whitespace is not collapsed', () => {
  const doubleSpace = SURRENDER_PHRASE.replace('good reason', 'good  reason');
  const newline = SURRENDER_PHRASE.replace('good reason', 'good\nreason');
  const tab = SURRENDER_PHRASE.replace('good reason', 'good\treason');
  assert.equal(isPhraseMatch(doubleSpace, SURRENDER_PHRASE), false);
  assert.equal(isPhraseMatch(newline, SURRENDER_PHRASE), false);
  assert.equal(isPhraseMatch(tab, SURRENDER_PHRASE), false);
});

test('case drift is rejected', () => {
  assert.equal(isPhraseMatch(SURRENDER_PHRASE.replace('I am', 'i am'), SURRENDER_PHRASE), false);
});

test('punctuation drift is rejected', () => {
  assert.equal(isPhraseMatch(SURRENDER_PHRASE.slice(0, -1), SURRENDER_PHRASE), false);
  assert.equal(isPhraseMatch(`${SURRENDER_PHRASE}!`, SURRENDER_PHRASE), false);
});

test('empty and whitespace-only entries are rejected', () => {
  assert.equal(isPhraseMatch('', SURRENDER_PHRASE), false);
  assert.equal(isPhraseMatch(' \n\t ', SURRENDER_PHRASE), false);
  assert.equal(canSubmit(START + SURRENDER_DELAY_MS, START, ''), false);
});

test('a wrong entry cannot submit even after the delay', () => {
  assert.equal(
    canSubmit(START + SURRENDER_DELAY_MS + 60_000, START, `${SURRENDER_PHRASE} typo`),
    false,
  );
});

test('a wrong-entry restart requires a fresh full delay with no partial credit', () => {
  const failedAt = START + SURRENDER_DELAY_MS;
  assert.equal(canSubmit(failedAt, START, 'not the sentence'), false);

  // The wall re-arms at the failed attempt, exactly as the injected UI does.
  const restartedAt = failedAt;
  assert.equal(canSubmit(restartedAt + SURRENDER_DELAY_MS - 1, restartedAt, SURRENDER_PHRASE), false);
  assert.equal(canSubmit(restartedAt + SURRENDER_DELAY_MS, restartedAt, SURRENDER_PHRASE), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
