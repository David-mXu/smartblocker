// Unit tests for the desktop app-target UI helpers (src/desktop/apps.ts).
// Runs directly under Node >= 22.6 type stripping — keep apps.ts free of
// non-erasable TS syntax.
//
//   node scripts/app-targets-test.mjs
import assert from 'node:assert/strict';
import {
  blockedBy,
  collisionSummary,
  exactChoiceLabel,
  exactStemTarget,
  exactTargetFor,
  legacyCoverage,
  legacyMatchesApp,
  pathKey,
  targetCoverage,
  targetDetail,
  targetKey,
  targetKindLabel,
  targetMatchesApp,
  targetSummaryName,
} from '../src/desktop/apps.ts';

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

const steamC = {
  name: 'steam',
  count: 1,
  isBrowser: false,
  state: 'background',
  exePath: 'c:\\program files (x86)\\steam\\steam.exe',
};
const steamD = {
  name: 'steam',
  count: 1,
  isBrowser: false,
  state: 'background',
  exePath: 'd:\\games\\steamlibrary\\steam.exe',
};
const helper = {
  name: 'steamwebhelper',
  count: 6,
  isBrowser: false,
  state: 'open',
  exePath: 'c:\\program files (x86)\\steam\\bin\\cef\\steamwebhelper.exe',
};
const calculator = {
  name: 'calculator',
  count: 1,
  isBrowser: false,
  state: 'visible',
  exePath: 'c:\\program files\\windowsapps\\calc\\calculator.exe',
  packageFamily: 'microsoft.windowscalculator_8wekyb3d8bbwe',
};
const apps = [steamC, steamD, helper, calculator];

console.log('app-target UI helpers');

test('pathKey folds case, slashes and long-path prefixes', () => {
  assert.equal(
    pathKey('C:\\Program Files\\Steam\\Steam.exe'),
    'c:/program files/steam/steam.exe',
  );
  assert.equal(
    pathKey('\\\\?\\C:\\Program Files\\Steam\\Steam.exe'),
    'c:/program files/steam/steam.exe',
  );
  assert.equal(pathKey('c:/Program Files/Steam/Steam.exe'), 'c:/program files/steam/steam.exe');
  assert.equal(
    pathKey('\\\\?\\UNC\\Server\\Share\\Steam.exe'),
    '//server/share/steam.exe',
  );
});

test('exact identity prefers package, then path, then stem', () => {
  assert.deepEqual(exactTargetFor(calculator), {
    version: 1,
    kind: 'msixPackage',
    familyName: 'microsoft.windowscalculator_8wekyb3d8bbwe',
  });
  assert.deepEqual(exactTargetFor(steamC), {
    version: 1,
    kind: 'exePath',
    path: 'c:\\program files (x86)\\steam\\steam.exe',
  });
  assert.deepEqual(
    exactTargetFor({ name: 'slack', count: 1, isBrowser: false, state: 'background' }),
    { version: 1, kind: 'exactStem', stem: 'slack' },
  );
  assert.equal(exactChoiceLabel(calculator), 'This Store app');
  assert.equal(exactChoiceLabel(steamC), 'This exact app');
});

test('exact targets never fall back to substring or folder recursion', () => {
  const exact = exactTargetFor(steamC);
  assert.equal(targetMatchesApp(exact, steamC), true);
  assert.equal(targetMatchesApp(exact, steamD), false);
  assert.equal(targetMatchesApp(exact, helper), false);
  assert.equal(
    targetMatchesApp(
      { version: 1, kind: 'exactStem', stem: 'steam' },
      helper,
    ),
    false,
  );
  assert.equal(
    targetMatchesApp(
      { version: 1, kind: 'exePath', path: 'c:\\program files (x86)\\steam' },
      steamC,
    ),
    false,
  );
  assert.equal(
    targetMatchesApp(
      { version: 1, kind: 'msixPackage', familyName: 'microsoft.windowscalculator_8wekyb3d8bbwe' },
      calculator,
    ),
    true,
  );
});

test('legacy contains stays broad and case-insensitive', () => {
  assert.equal(legacyMatchesApp('steam', helper), true);
  assert.equal(legacyMatchesApp('STEAM', steamC), true);
  assert.equal(legacyMatchesApp('steam', calculator), false);
  assert.deepEqual(legacyCoverage('steam', apps).map((a) => a.name), ['steam', 'steam', 'steamwebhelper']);
});

test('precedence shows exact before legacy', () => {
  const targets = [exactTargetFor(calculator)];
  assert.deepEqual(blockedBy(calculator, ['calculator'], targets), { kind: 'exact', index: 0 });
  const legacyOnly = { name: 'steamwebhelper', count: 1, isBrowser: false, state: 'background' };
  assert.deepEqual(blockedBy(legacyOnly, ['steam'], []), { kind: 'legacy', index: 0 });
  assert.equal(blockedBy(steamC, [], []), null);
});

test('collision preview names the sibling install an exact path leaves open', () => {
  const summary = collisionSummary(steamC, apps, 'exact');
  assert.match(summary, /closes this install only/i);
  assert.match(summary, /steam\.exe/);
  assert.match(summary, /stay open/i);
  assert.match(collisionSummary(steamC, apps, 'legacy'), /steamwebhelper\.exe/);
  assert.match(collisionSummary(steamC, apps, 'legacy'), /future app/i);
  assert.match(collisionSummary(calculator, apps, 'exact'), /package/i);
});

test('target keys/details are deterministic and human-readable', () => {
  const path = exactTargetFor(steamC);
  assert.equal(targetKey(path), 'exePath:c:/program files (x86)/steam/steam.exe');
  assert.equal(targetKey(exactStemTarget('Steam.exe')), 'exactStem:steam');
  assert.equal(targetKindLabel(path), 'Exact path');
  assert.equal(targetDetail(path), 'c:\\program files (x86)\\steam\\steam.exe');
  assert.equal(targetSummaryName(exactStemTarget('steam')), 'steam');
  assert.equal(targetSummaryName(path), 'steam');
  assert.equal(targetSummaryName(exactTargetFor(calculator)), 'windowscalculator');
  assert.deepEqual(targetCoverage(path, apps).map((a) => a.exePath), [steamC.exePath]);
});

test('manual exact-name normalization still strips a pasted path', () => {
  assert.deepEqual(exactStemTarget('C:\\Program Files\\Steam\\Steam.exe'), {
    version: 1,
    kind: 'exactStem',
    stem: 'steam',
  });
  assert.equal(exactStemTarget(''), null);
});

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
