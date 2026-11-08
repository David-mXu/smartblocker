// Focused unit tests for URL/title blocklist + whitelist wildcard grammar.
// Runs directly under Node >= 22.6 type stripping; all imported TypeScript is
// erasable-syntax-only. No browser or model dependencies.
//
//   node scripts/wildcards-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isValidWildcardWhitelistEntry,
  isWhitelisted,
  matchedBlocklistEntry,
  matchingWhitelistEntries,
} from '../src/shared/titles.ts';
import { normalizeDomain, normalizeKeyword } from '../src/shared/domains.ts';
import { sanitizePage } from '../src/content/sanitize-page.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.stack ?? e.message}`);
  }
}

console.log('wildcard list grammar tests');

// --- Legacy URL/title substring behavior and first-match reason text ---
test('star-free block rules retain case-insensitive URL + title substring matching', () => {
  assert.equal(matchedBlocklistEntry('https://Example.com/Cart', null, ['example.com/cart']), 'example.com/cart');
  assert.equal(matchedBlocklistEntry('https://shop.test/', 'Black Friday Sale', ['black friday']), 'black friday');
  assert.equal(matchedBlocklistEntry('https://shop.test/', 'Sale', ['missing']), null);
});

test('block matching returns the first trimmed original spelling', () => {
  assert.equal(
    matchedBlocklistEntry('https://example.com/', 'Sale', ['nope', '  EXAMPLE.com  ', 'sale']),
    'EXAMPLE.com',
  );
});

test('star gaps are ordered, unanchored, and cross URL/title separators', () => {
  assert.equal(
    matchedBlocklistEntry('https://youtube.com/watch?v=1', '100 days of Minecraft', ['youtube.com*100 days']),
    'youtube.com*100 days',
  );
  assert.equal(matchedBlocklistEntry('https://example.com/a/b/c', '', ['/a/*c']), '/a/*c');
  assert.equal(matchedBlocklistEntry('https://example.com/c/b/a', '', ['/a/*c']), null);
  assert.equal(matchedBlocklistEntry('https://example.com/', 'speedrun then minecraft', ['minecraft*speedrun']), null);
});

test('star runs collapse and can represent a zero-character gap', () => {
  assert.equal(matchedBlocklistEntry('https://example.com/aEND', '', ['a***END']), 'a***END');
  assert.equal(matchedBlocklistEntry('https://example.com/a filler END', '', ['a***END']), 'a***END');
});

test('block wildcard matching is lowercase but preserves literal inner whitespace', () => {
  assert.equal(matchedBlocklistEntry('https://example.com/', 'MINECRAFT 100 Days', [' MiNeCrAfT*100 days ']), 'MiNeCrAfT*100 days');
  assert.equal(matchedBlocklistEntry('https://example.com/', 'Minecraft 100 Days', ['Minecraft*  100 Days']), null);
});

test('regex metacharacters are literals, never regular-expression operators', () => {
  const raw = String.raw`a.b+c?(x)*[z]{2}|^$\end`;
  const literalTitle = String.raw`prefix a.b+c?(x) gap [z]{2}|^$\end suffix`;
  assert.equal(matchedBlocklistEntry('https://safe.test/', literalTitle, [raw]), raw);
  assert.equal(matchedBlocklistEntry('https://safe.test/', 'aXb+c?(x) gap [z]{2}|^$\\end', [raw]), null);
  for (const malformed of ['[', '(', '(?:', '\\', '*?', '*[x']) {
    assert.doesNotThrow(() => matchedBlocklistEntry('https://example.com/', malformed, [malformed]));
  }
});

test('star-only block rules fail safe while explicit *.* remains a broad block', () => {
  for (const rule of ['*', '***', ' * ', '* *', '*\t*']) {
    assert.equal(matchedBlocklistEntry('https://example.com/', 'anything', [rule]), null);
  }
  assert.equal(matchedBlocklistEntry('https://example.com/', null, ['*.*']), '*.*');
  assert.equal(matchedBlocklistEntry('https://example.com/', null, ['*', 'example.com']), 'example.com');
});

test('malformed block entries and lists are ignored without throwing', () => {
  assert.equal(matchedBlocklistEntry('https://example.com/', null, null), null);
  assert.doesNotThrow(() => matchedBlocklistEntry('https://example.com/', null, [null, 42, {}, '*']));
  assert.equal(matchedBlocklistEntry('https://example.com/', null, [null, 42, {}, '*', 'example.com']), 'example.com');
  assert.equal(matchedBlocklistEntry(undefined, null, ['example.com']), null);
});

// --- Existing editor normalization limits and star-free host compatibility ---
test('block editor keeps the existing minimum length and keyword normalization', () => {
  assert.equal(normalizeKeyword('*').ok, false);
  assert.equal(normalizeKeyword('a*').ok, false);
  assert.deepEqual(normalizeKeyword('*.*'), { ok: true, value: '*.*' });
  assert.deepEqual(normalizeKeyword(' Black   FRIDAY '), { ok: true, value: 'black friday' });
});

test('non-star domain normalization still reduces URLs and paths to a host', () => {
  assert.deepEqual(normalizeDomain(' https://www.Example.COM:8443/a/b?q=1 '), { ok: true, value: 'example.com' });
  assert.equal(isWhitelisted('https://example.com:8443/a', ['example.com']), true);
  assert.equal(isWhitelisted('https://example.com:8443/a', ['example.com:8443']), false); // Legacy raw-entry behavior.
  assert.equal(isWhitelisted('https://sub.example.com/path', ['https://www.example.com/old/path']), true);
  assert.equal(isWhitelisted('https://notexample.com/', ['example.com']), false);
});

test('wildcard domain normalization preserves safe grammar and rejects allow-all forms', () => {
  assert.deepEqual(normalizeDomain(' *.Example.COM '), { ok: true, value: '*.example.com' });
  assert.deepEqual(normalizeDomain('HTTPS://*.Example.COM/Docs/**?Q=*#section'), {
    ok: true,
    value: 'https://*.example.com/docs/*?q=*#section',
  });
  for (const unsafe of ['*', '***', '*.*', 'https://*/', '*/*', 'https://example.*/*', 'https://example.com:443/*']) {
    assert.equal(normalizeDomain(unsafe).ok, false, unsafe);
    assert.equal(isValidWildcardWhitelistEntry(unsafe), false, unsafe);
  }
});

// --- Fully anchored wildcard allow grammar ---
test('*.example.com suffix sugar includes apex and subdomains, not lookalikes', () => {
  const rules = ['*.Example.com'];
  for (const url of ['https://example.com/', 'https://www.example.com/a', 'https://deep.sub.example.com:8443/a']) {
    assert.equal(isWhitelisted(url, rules), true, url);
  }
  for (const url of ['https://notexample.com/', 'https://example.com.evil.test/']) {
    assert.equal(isWhitelisted(url, rules), false, url);
  }
});

test('other host-only globs are fully anchored, case-insensitive, and can span dots', () => {
  const rules = ['FOO*.example.com'];
  assert.equal(isWhitelisted('https://foo.example.com/', rules), true);
  assert.equal(isWhitelisted('https://foo.bar.example.com/', rules), true);
  assert.equal(isWhitelisted('https://xfoo.example.com/', rules), false);
  assert.equal(isWhitelisted('https://foo.example.com.evil.test/', rules), false);
  assert.equal(isWhitelisted('https://notexample.com/', ['*example.com']), true); // No implicit DNS-label sugar here.
});

test('wildcard paths match normalized host + pathname + search and ignore fragments', () => {
  const rule = 'https://Example.com/Docs/*?Q=*#ignored';
  assert.equal(isWhitelisted('https://example.com/Docs/a/b?Q=Rust#chapter', [rule]), true);
  assert.equal(isWhitelisted('http://example.com/docs/a/b?q=Rust#other', [rule]), true);
  assert.equal(isWhitelisted('https://example.com/docs/a/b?other=Rust', [rule]), false);
  assert.equal(isWhitelisted('https://example.com/other/a/b?q=Rust', [rule]), false);
  assert.equal(isWhitelisted('https://sub.example.com/docs/a/b?q=Rust', ['https://*.example.com/docs/*']), true);
  assert.equal(isWhitelisted('https://example.com/docs', ['example.com/docs#*']), true); // Ignored fragment leaves a literal.
  assert.equal(isWhitelisted('https://example.com/abxab', ['example.com/*ab']), true); // Suffix uses its final occurrence.
});

test('scheme-only wildcard allows have URL root semantics, not substring semantics', () => {
  const rules = ['https://*.example.com'];
  assert.equal(isWhitelisted('https://sub.example.com/', rules), true);
  assert.equal(isWhitelisted('http://sub.example.com/', rules), true);
  assert.equal(isWhitelisted('https://sub.example.com/docs', rules), false);
  assert.equal(isWhitelisted('https://example.com/', rules), false);
});

test('path regex punctuation stays literal', () => {
  const rules = ['example.com/a+b.(draft)*'];
  assert.equal(isWhitelisted('https://example.com/a+b.(draft)/full', rules), true);
  assert.equal(isWhitelisted('https://example.com/aaabX(draft)/full', rules), false);
});

test('defensive allow rejection covers match-everything and hostless rule variants', () => {
  const denied = ['*', '***', '* *', '*.*', 'https://*/', 'https://*/*', '*/*', 'https://*.*/', 'https://example.*/*', '*://*/'];
  for (const url of ['https://example.com/a?q=1', 'https://unrelated.net/']) {
    assert.deepEqual(matchingWhitelistEntries(url, denied), [], url);
    assert.equal(isWhitelisted(url, denied), false, url);
  }
  // Safe counterexamples ensure rejection is not simply disabling all globs.
  assert.equal(isWhitelisted('https://example.com/a', ['https://example.com/*']), true);
  assert.equal(isWhitelisted('https://sub.example.com/a', ['https://*.example.com/*']), true);
});

test('malformed wildcard allows and invalid URLs never crash or allow', () => {
  const malformed = [null, 42, {}, '', 'https://[*.example.com/*', 'https://user@*.example.com/*', '*.example..com', 'https://example.com:443/*'];
  assert.doesNotThrow(() => matchingWhitelistEntries('https://example.com/', malformed));
  assert.deepEqual(matchingWhitelistEntries('https://example.com/', malformed), []);
  assert.deepEqual(matchingWhitelistEntries('not a url', ['*', '*.example.com']), []);
  assert.deepEqual(matchingWhitelistEntries(undefined, ['*.example.com']), []);
  assert.deepEqual(matchingWhitelistEntries('https://example.com/', null), []);
});

test('active SERP, search vertical, and translation guards precede every wildcard allow', () => {
  const rules = ['*', '*.google.com', 'https://*.google.com/*', 'google.com*'];
  for (const url of [
    'https://www.google.com/search?q=focus',
    'https://www.google.com/videos',
    'https://play.google.com/store/apps',
    'https://translate.google.com/translate?u=https://example.com',
    'https://example-com.translate.goog/?_x_tr_sl=auto&_x_tr_tl=en',
  ]) {
    assert.deepEqual(matchingWhitelistEntries(url, rules), [], url);
  }
  assert.equal(isWhitelisted('https://www.google.com/', ['*.google.com']), true); // Blank homepage remains allow-able.
});

// --- Shared popup parity and the self-contained sanitizer mirror ---
test('popup matching gets every raw trimmed rule through the shared API', () => {
  const rules = [' nope ', ' example.com ', ' *.Example.com ', 'FOO*.EXAMPLE.COM', 'https://*/'];
  assert.deepEqual(matchingWhitelistEntries('https://foo.example.com/docs', rules), [
    'example.com',
    '*.Example.com',
    'FOO*.EXAMPLE.COM',
  ]);
  const popupSource = readFileSync(new URL('../src/popup/popup-model.ts', import.meta.url), 'utf8');
  assert.match(popupSource, /const allowedBy = matchingWhitelistEntries\(url, settings\.whitelist\)/);
  assert.match(popupSource, /allowedBy,/);
  assert.doesNotMatch(popupSource, /function whitelistMatches/);
});

test('popup removal matches trimmed labels back to whitespace-padded stored rules', () => {
  const stored = [' other.test ', '  example.com  ', ' *.Example.com ', 'keep.test'];
  const allowedBy = matchingWhitelistEntries('https://foo.example.com/docs', stored);
  const drop = new Set(allowedBy);
  assert.deepEqual(stored.filter((entry) => !drop.has(entry.trim())), [' other.test ', 'keep.test']);
  const popupSource = readFileSync(new URL('../src/popup/PopupApp.tsx', import.meta.url), 'utf8');
  assert.match(popupSource, /\.filter\(\(e\) => !drop\.has\(e\.trim\(\)\)\)/);
});

test('serialized sanitizer local matcher has direct behavioral parity', () => {
  // sanitizePage cannot import shared code. Evaluate only its nested pure
  // matcher from the actual serialized function, with no DOM/browser stubs.
  const serialized = sanitizePage.toString();
  const start = serialized.indexOf('function matchesOrderedWildcard');
  const end = serialized.indexOf('function runScan(', start);
  assert.ok(start >= 0 && end > start, 'nested sanitizer matcher is extractable');
  const localMatches = new Function(`${serialized.slice(start, end)}\nreturn matchesBlocklist;`)();
  const cases = [
    ['https://Example.com/a/b', 'A Title', ['example.com/a']],
    ['https://youtube.com/watch', '100 days of Minecraft', ['youtube.com*100 days']],
    ['https://example.com/aEND', '', ['a***END']],
    ['https://example.com/', 'anything', ['*', '* *']],
    ['https://example.com/a/b', '', ['a.b+*?(x)']],
    ['https://example.com/', '', ['*.*']],
    ['https://example.com/', 'speedrun then minecraft', ['minecraft*speedrun']],
    ['', 'A Title', ['*', 'title']],
    ['https://example.com/', '', null],
  ];
  for (const [url, title, list] of cases) {
    assert.equal(localMatches(url, title, list), matchedBlocklistEntry(url, title, list), `${url} ${list}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
