// Unit tests for the deterministic rule core (src/shared/rules.ts) and its
// wiring into the offline block-decision ladder (scripts/lib/eval-harness.mjs
// decideBlock, which mirrors background/blocker.ts onTitle's ordering).
// Covers title rules (F2: compileTitleRule/matchTitleRule) and channel rules
// (F1: normalizeChannelHandle/matchChannel). The adult-host matcher has its
// own suite in scripts/rta-test.mjs.
// Runs directly under Node >= 22.6 type stripping — rules.ts is kept free of
// non-erasable TS syntax for exactly this reason.
//
//   node scripts/rules-test.mjs
import assert from 'node:assert/strict';
import {
  compileTitleRule,
  matchChannel,
  matchTitleRule,
  normalizeChannelHandle,
  normalizeTitleRule,
  TITLE_RULE_CACHE_MAX,
  TITLE_RULE_MAX_GAPS,
} from '../src/shared/rules.ts';
import { decideBlock, EVAL_SETTINGS } from './lib/eval-harness.mjs';
import { effectiveBlockScore, shouldBlockClassifierVerdict } from '../src/shared/prototypes.ts';
import {
  assessProtectionVerdict,
  PROTECTION_FIXTURES,
  protectionConfigurationCheck,
  summarizeProtectionChecks,
} from '../src/shared/protection-policy.ts';

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

console.log('rules tests (title rules + channel rules)');

// ===========================================================================
// Title rules
// ===========================================================================

// --- compiler safety: bad input must never throw ---
test('regex metachars are literal: [x(y* compiles and does not throw', () => {
  const re = compileTitleRule('[x(y*');
  assert.ok(re instanceof RegExp);
  // literal "[x(y" then a wildcard gap
  assert.equal(re.test('the [x(y anything here'), true);
  assert.equal(re.test('the x(y plain'), false);
});
test('all metachar classes escaped: . + ? ^ $ { } | \\ are literal', () => {
  const re = compileTitleRule('a.b+c? ^$ {x} | \\d');
  assert.ok(re instanceof RegExp);
  assert.equal(re.test('title a.b+c? ^$ {x} | \\d end'), true);
  assert.equal(re.test('title axbxc  title title title'), false);
});
test('compileTitleRule never throws on hostile strings', () => {
  for (const hostile of ['', '   ', '*', '***', '[', '(', '(?:', '\\', 'a[b', '*[x', '((', '*?', '?*']) {
    assert.doesNotThrow(() => compileTitleRule(hostile));
  }
});

// --- empty / star-only rule pruning ---
test('empty and whitespace-only rules are ignored', () => {
  assert.equal(compileTitleRule(''), null);
  assert.equal(compileTitleRule('   '), null);
  assert.equal(matchTitleRule('any title', ['', '   ']), null);
});
test('star-only rules are ignored (would match every title)', () => {
  assert.equal(compileTitleRule('*'), null);
  assert.equal(compileTitleRule('***'), null);
  assert.equal(compileTitleRule('* *'), null);
  assert.equal(matchTitleRule('anything at all', ['*']), null);
});

// --- bare substring semantics ---
test('bare rule (no star) is a plain substring match', () => {
  assert.equal(matchTitleRule('Fortnite Battle Pass', ['battle pass']), 'battle pass');
  assert.equal(matchTitleRule('TypeScript Tutorial', ['javascript']), null);
});
test('substring match is case-insensitive on both sides', () => {
  assert.equal(matchTitleRule('HALO INFINITE CAMPAIGN', ['halo infinite']), 'halo infinite');
  assert.equal(matchTitleRule('reddit memes', ['REDDIT']), 'REDDIT');
});
test('leading/trailing stars behave like bare substring', () => {
  assert.equal(matchTitleRule('lofi beats - YouTube', ['*lofi']), '*lofi');
  assert.equal(matchTitleRule('lofi beats - YouTube', ['lofi*']), 'lofi*');
  assert.equal(matchTitleRule('lofi beats - YouTube', ['*lofi*']), '*lofi*');
});

// --- wildcard semantics ---
test('star gap: literal parts must appear in order', () => {
  assert.equal(matchTitleRule('Minecraft - epic 100 day speedrun', ['minecraft*speedrun']), 'minecraft*speedrun');
  assert.equal(matchTitleRule('speedrun then minecraft', ['minecraft*speedrun']), null);
  assert.equal(matchTitleRule('minecraft alone', ['minecraft*speedrun']), null);
});
test('consecutive stars collapse to one wildcard', () => {
  assert.equal(matchTitleRule('one two three', ['one***three']), 'one***three');
  assert.ok(compileTitleRule('one***three') instanceof RegExp);
  assert.ok(compileTitleRule('one*three') instanceof RegExp);
  // identical matching behaviour between star counts
  const a = compileTitleRule('one***three'), b = compileTitleRule('one*three');
  assert.equal(a.test('one here there three'), b.test('one here there three'));
  assert.equal(a.test('one thre'), b.test('one thre'));
  assert.ok(compileTitleRule('a**b') instanceof RegExp);
});
test('a star gap crosses long distances', () => {
  const title = 'a ' + 'filler '.repeat(200) + 'end';
  assert.equal(matchTitleRule(title, ['a*end']), 'a*end');
});
test('wildcards do not make bare-substring rules match differently', () => {
  // "a b" without a star must NOT match "axxx b" (no star gap available)
  assert.equal(matchTitleRule('axxx b', ['a b']), null);
  assert.equal(matchTitleRule('a b', ['a b']), 'a b');
});

// --- unicode / NFKC normalization (overrides.ts approach, both sides) ---
test('NFKC: fullwidth rule text matches ASCII title (and vice versa)', () => {
  assert.equal(matchTitleRule('Fortnite Battle Pass', ['Ｆｏｒｔｎｉｔｅ']), 'Ｆｏｒｔｎｉｔｅ');
  assert.equal(matchTitleRule('Ｆｏｒｔｎｉｔｅ tonight', ['fortnite']), 'fortnite');
});
test('zero-width / format chars are stripped from the title before matching', () => {
  // ZWJ + ZWNJ smuggled inside "fortnite"
  assert.equal(matchTitleRule('fo​rtni‌te arena', ['fortnite']), 'fortnite');
});
test('zero-width chars inside the rule text are also stripped', () => {
  assert.equal(matchTitleRule('fortnite arena', ['fort​nite']), 'fort​nite');
});
test('whitespace runs collapse on both sides', () => {
  assert.equal(matchTitleRule('a    b\t c', ['a b c']), 'a b c');
  // return value is the raw rule trimmed — inner spacing preserved
  assert.equal(matchTitleRule('a b c', ['  a   b  c  ']), 'a   b  c');
});

// --- matchTitleRule plumbing ---
test('null/undefined/empty titles never match', () => {
  assert.equal(matchTitleRule(null, ['x']), null);
  assert.equal(matchTitleRule(undefined, ['x']), null);
  assert.equal(matchTitleRule('', ['x']), null);
  assert.equal(matchTitleRule('loading', ['x']), null); // stays short; no x
});
test('empty rules list never matches', () => {
  assert.equal(matchTitleRule('fortnite', []), null);
});
test('first matching rule wins and returns its trimmed raw text', () => {
  assert.equal(matchTitleRule('games games games', ['nothing', '  games  ', 'mes']), 'games');
});
test('rules that fail to compile are skipped, not fatal', () => {
  assert.equal(matchTitleRule('game over', ['*', 'over']), 'over');
});

// --- compile cache (perf + ReDoS: rules compiled once, not per title check) ---
// matchTitleRule used to recompile every rule RegExp on EVERY title check —
// the cache makes repeated checks return the same compiled object.
test('compile cache: repeated compiles of one rule return the SAME RegExp object', () => {
  const first = compileTitleRule('cache*probe');
  const again = compileTitleRule('cache*probe');
  assert.ok(first instanceof RegExp);
  assert.equal(first, again); // strict identity — a cache hit, not a recompile
});
test('compile cache: repeated matchTitleRule calls keep matching identically', () => {
  const rules = ['minecraft*speedrun', 'world of warcraft', 'a*b'];
  const t = 'Minecraft hardcore — any% speedrun attempts';
  const r1 = matchTitleRule(t, rules);
  const r2 = matchTitleRule(t, rules);
  assert.equal(r1, 'minecraft*speedrun');
  assert.equal(r2, r1);
});
test('compile cache: shared cached RegExp is stateless (no /g lastIndex hazard)', () => {
  const re = compileTitleRule('state*less');
  assert.equal(re.test('state of less'), true);
  assert.equal(re.lastIndex, 0);
  assert.equal(re.test('state of less'), true); // a /g flag would strand it at the end
});
test('compile cache: LRU refresh keeps a recently used rule alive across eviction pressure', () => {
  const mark = 'lru*probe';
  compileTitleRule(mark);
  for (let i = 0; i < TITLE_RULE_CACHE_MAX - 1; i++) compileTitleRule(`lrufill${i}*x`);
  const refreshed = compileTitleRule(mark); // LRU-reinserted: now the newest entry
  for (let i = 0; i < 5; i++) compileTitleRule(`lrufillmore${i}*x`);
  assert.equal(compileTitleRule(mark), refreshed); // still the cached object
});
test('compile cache: eviction at the cap preserves matching semantics byte-for-byte', () => {
  const re1 = compileTitleRule('evict*probe');
  assert.ok(re1 instanceof RegExp);
  // Push TITLE_RULE_CACHE_MAX distinct rules through the cache so 'evict*probe'
  // ages past the back of the LRU and is evicted.
  for (let i = 0; i < TITLE_RULE_CACHE_MAX; i++) compileTitleRule(`evictfill${i}*x`);
  const re2 = compileTitleRule('evict*probe');
  assert.notEqual(re1, re2); // recompiled — the old object was evicted
  assert.equal(re2.test('evict this probe'), true);
  assert.equal(re2.test('evict nothing alike'), false);
});
test('compile cache: invalid rules stay null through the cache', () => {
  assert.equal(compileTitleRule('*'), null);
  assert.equal(compileTitleRule('*'), null); // cached null, still null
  assert.equal(matchTitleRule('anything', ['*']), null);
});

// --- authoring guard (normalizeTitleRule) — refuses structurally risky NEW
// rules; stored rules are untouched and keep evaluating through the cache.
const gapRule = (n) => Array.from({ length: n + 1 }, () => 'ab').join('*'); // n star gaps
test('guard: rules within the gap cap are accepted (7 and 8 gaps)', () => {
  assert.equal(gapRule(7).split('*').length - 1, 7);
  assert.deepEqual(normalizeTitleRule(gapRule(7)), { ok: true, value: gapRule(7) });
  assert.deepEqual(normalizeTitleRule(gapRule(8)), { ok: true, value: gapRule(8) });
  assert.equal(8, TITLE_RULE_MAX_GAPS); // boundary constant sanity
});
test('guard: rules over the gap cap are rejected with an actionable message', () => {
  const r = normalizeTitleRule(gapRule(9));
  assert.equal(r.ok, false);
  assert.match(r.error, /\*/); // names the wildcard as the problem
  assert.match(r.error, /8/); // states the actual limit
});
test('guard: single-character-literal-only rules are rejected', () => {
  for (const risky of ['a*b', '*a*', '**a*b**', 'a* b *c']) {
    const r = normalizeTitleRule(risky);
    assert.equal(r.ok, false, `expected reject: ${risky}`);
    assert.match(r.error, /2 or more letters/);
  }
});
test('guard: star-only and too-short rules are rejected', () => {
  assert.equal(normalizeTitleRule('*').ok, false);
  assert.equal(normalizeTitleRule('* * *').ok, false); // star runs, no literals
  assert.equal(normalizeTitleRule('ab').ok, false); // keep normalizeKeyword's 3-char floor
});
test('guard: sane rules pass with the canonical stored form', () => {
  assert.deepEqual(normalizeTitleRule('  MineCraft  *SpeedRun '), {
    ok: true,
    value: 'minecraft *speedrun',
  });
  assert.deepEqual(normalizeTitleRule('world of warcraft'), {
    ok: true,
    value: 'world of warcraft',
  });
});
test('guard is authoring-side only: stored risky rules still evaluate identically', () => {
  // 9 gaps + single-char literals — refused at entry, but a stored rule with
  // these shapes keeps matching (cache makes the compile cost once).
  const nine = gapRule(9);
  const title = 'xx ' + 'ab '.repeat(10) + 'yy';
  assert.equal(matchTitleRule(title, [nine]), nine);
  assert.equal(matchTitleRule(title, [nine]), nine); // same verdict through the cache
  assert.equal(matchTitleRule('a big b', ['a*b']), 'a*b'); // legacy single-char rule stored
});
test('existing sane rules match byte-identically through the cache', () => {
  assert.equal(matchTitleRule('Fortnite Battle Pass', ['battle pass']), 'battle pass');
  assert.equal(matchTitleRule('Minecraft - epic 100 day speedrun', ['minecraft*speedrun']), 'minecraft*speedrun');
  assert.equal(matchTitleRule('speedrun then minecraft', ['minecraft*speedrun']), null);
  assert.equal(matchTitleRule('lofi beats - YouTube', ['*lofi']), '*lofi');
});

// --- linear matching (ReDoS hardening, 2026-11-21) ---
test('stored risky rules match without catastrophic backtracking', () => {
  // Guard-passing shape (2-char literals, 4 gaps) against a hostile 300-char
  // title: the regex engine took 57s, the ordered-literal matcher is linear.
  const risky = 'ab*ab*ab*ab*c';
  const hostile = 'ab '.repeat(100); // 300 chars, no final "c"
  const t0 = performance.now();
  assert.equal(matchTitleRule(hostile, [risky]), null);
  assert.equal(matchTitleRule(hostile + ' c', [risky]), risky);
  const ms = performance.now() - t0;
  assert.ok(ms < 1_000, `title-rule match took ${ms.toFixed(1)}ms (expected < 1s; the regex took 57s)`);
});
test('ordered-literal matching is equivalent to the old regex for sane rules', () => {
  const cases = [
    ['minecraft*speedrun', 'Minecraft - epic 100 day speedrun', true],
    ['minecraft*speedrun', 'speedrun then minecraft', false],
    ['*lofi', 'lofi beats - YouTube', true],
    ['lofi*', 'lofi beats - YouTube', true],
    ['one***three', 'one two three', true],
    ['a*b', 'a big b', true],
    ['a*b', 'ba', false],
    ['no-star', 'a no-star here', true],
  ];
  for (const [rule, title, expected] of cases) {
    assert.equal(matchTitleRule(title, [rule]) !== null, expected, `${rule} on "${title}"`);
  }
});
test('guard normalizes fullwidth stars and invisible chars before counting gaps', () => {
  // NFKC folds `＊` to `*`; before this, the guard counted 0 gaps and admitted
  // a 9-wildcard rule that the compiler then turned into a slow pattern.
  const nine = Array(10).fill('ab').join('＊'); // 9 gaps
  assert.equal(normalizeTitleRule(nine).ok, false);
  assert.equal(normalizeTitleRule('mine​craft*speedrun').value, 'minecraft*speedrun');
});

// ===========================================================================
// Channel rules
// ===========================================================================
// --- normalizeChannelHandle ---
test('strips the optional leading @', () => {
  assert.deepEqual(normalizeChannelHandle('@MrBeast'), { ok: true, value: 'mrbeast' });
});
test('lowercases a bare handle', () => {
  assert.deepEqual(normalizeChannelHandle('MrBeast'), { ok: true, value: 'mrbeast' });
});
test('trims surrounding whitespace before the @', () => {
  assert.deepEqual(normalizeChannelHandle('  @Mr_Beast-1  '), { ok: true, value: 'mr_beast-1' });
});
test('strips a "(youtube.com)"-style site marker', () => {
  assert.deepEqual(normalizeChannelHandle('MrBeast (youtube.com)'), { ok: true, value: 'mrbeast' });
});
test('keeps a non-host parenthetical that is part of the name', () => {
  assert.deepEqual(normalizeChannelHandle('Channel (Official)'), {
    ok: true,
    value: 'channel (official)',
  });
});
test('keeps subreddit-style names', () => {
  assert.deepEqual(normalizeChannelHandle('r/Futurology'), { ok: true, value: 'r/futurology' });
});
test('collapses inner whitespace in display names', () => {
  assert.deepEqual(normalizeChannelHandle('Marques   Brownlee'), {
    ok: true,
    value: 'marques brownlee',
  });
});
test('empty input is rejected', () => {
  assert.equal(normalizeChannelHandle('').ok, false);
  assert.equal(normalizeChannelHandle('   ').ok, false);
  assert.equal(normalizeChannelHandle('@').ok, false);
});
test('punctuation-only input is rejected', () => {
  assert.equal(normalizeChannelHandle('!!!').ok, false);
});
test('over-long input is rejected', () => {
  assert.equal(normalizeChannelHandle('a'.repeat(101)).ok, false);
});
test('unicode letters are accepted', () => {
  assert.deepEqual(normalizeChannelHandle('@老高與小茉'), { ok: true, value: '老高與小茉' });
});

// --- matchChannel ---
test('matches the stored handle against a scraped display name + site marker', () => {
  assert.equal(matchChannel('MrBeast (youtube.com)', ['mrbeast']), 'mrbeast');
});
test('case-insensitive on both sides, and tolerant of an unnormalized stored @', () => {
  assert.equal(matchChannel('mrbeast', ['@MrBeast']), '@MrBeast');
});
test('returns the stored entry (for reason labels), first match wins', () => {
  assert.equal(matchChannel('MrBeast', ['nope', 'mrbeast', 'mrbeast2']), 'mrbeast');
});
test('null / missing channel never matches', () => {
  assert.equal(matchChannel(null, ['mrbeast']), null);
  assert.equal(matchChannel(undefined, ['mrbeast']), null);
  assert.equal(matchChannel('', ['mrbeast']), null);
});
test('empty list never matches', () => {
  assert.equal(matchChannel('MrBeast (youtube.com)', []), null);
});
test('invisible and compatibility characters cannot evade a channel rule', () => {
  for (const variant of [
    'Mr​Beast', // zero-width space
    'Mr‍Beast', // zero-width joiner
    'Mr­Beast', // soft hyphen
    '‎MrBeast', // left-to-right mark
    'ＭｒＢｅａｓｔ', // fullwidth
  ]) {
    assert.equal(matchChannel(variant, ['mrbeast']), 'mrbeast', JSON.stringify(variant));
  }
  assert.deepEqual(normalizeChannelHandle('ＭｒＢｅａｓｔ'), { ok: true, value: 'mrbeast' });
  assert.deepEqual(normalizeChannelHandle('Mr​Beast'), { ok: true, value: 'mrbeast' });
});
test('no substring matching: "beast" cannot catch "mrbeast2" and vice versa', () => {
  assert.equal(matchChannel('mrbeast2', ['mrbeast']), null);  assert.equal(matchChannel('beast', ['mrbeast']), null);
});
test('whitespace-insensitive: a stored handle matches a spaced display name', () => {
  assert.equal(matchChannel('Marques Brownlee (youtube.com)', ['marquesbrownlee']), 'marquesbrownlee');
  assert.equal(matchChannel('Marques Brownlee', ['marques brownlee']), 'marques brownlee');
});
test('matches subreddit-style channels', () => {
  assert.equal(matchChannel('r/futurology', ['r/futurology']), 'r/futurology');
});
test('matches the hostname fallback form applyUrlSignals produces', () => {
  assert.equal(matchChannel('youtube.com', ['youtube.com']), 'youtube.com');
});
test('un-normalizable stored entries are skipped, not crashes', () => {
  assert.equal(matchChannel('mrbeast', ['(youtube.com)', '@@@']), null);
});

// --- ladder semantics (decideBlock mirrors blocker.ts onTitle) ---
const BLOCKED = { label: 'video games', score: 0.9 };
const ALLOWED = { label: 'programming and software development', score: 0.7 };
const YT_WATCH = 'https://www.youtube.com/watch?v=abc123def45';
const mrbeastCase = {
  input: { title: 'I Built 100 Homes And Gave Them Away!', channel: 'MrBeast (youtube.com)' },
  url: YT_WATCH,
};
const withChannels = (over = {}) => ({
  ...EVAL_SETTINGS,
  channelBlocklist: [],
  channelAllowlist: [],
  ...over,
});

test('default settings: a channel signal alone changes nothing (baseline no-op)', () => {
  assert.deepEqual(decideBlock(mrbeastCase, BLOCKED, EVAL_SETTINGS), {
    decision: 'block',
    reason: 'classifier',
  });
  assert.deepEqual(decideBlock(mrbeastCase, ALLOWED, EVAL_SETTINGS), {
    decision: 'allow',
    reason: 'classifier',
  });
});
test('channelBlocklist blocks deterministically even when the classifier would allow', () => {
  const r = decideBlock(mrbeastCase, ALLOWED, withChannels({ channelBlocklist: ['mrbeast'] }));
  assert.deepEqual(r, { decision: 'block', reason: 'channel-block:mrbeast' });
});
test('optional top-level case `channel` field feeds the rules', () => {
  const c = { input: 'I Built 100 Homes And Gave Them Away!', channel: 'MrBeast (youtube.com)' };
  const r = decideBlock(c, ALLOWED, withChannels({ channelBlocklist: ['mrbeast'] }));
  assert.deepEqual(r, { decision: 'block', reason: 'channel-block:mrbeast' });
});
test('URL whitelist beats channelBlocklist', () => {
  const c = {
    input: { title: 'Some page', channel: 'MrBeast (youtube.com)' },
    url: 'https://github.com/some/repo',
  };
  const r = decideBlock(c, BLOCKED, withChannels({ channelBlocklist: ['mrbeast'] }));
  assert.equal(r.decision, 'allow');
  assert.equal(r.reason, 'whitelist');
});
test('URL/title blocklist beats channelBlocklist (ladder order)', () => {
  const s = withChannels({ blocklist: ['youtube.com/watch'], channelBlocklist: ['mrbeast'] });
  assert.equal(decideBlock(mrbeastCase, BLOCKED, s).reason, 'blocklist:youtube.com/watch');
});
test('channelAllowlist rescues a classifier block verdict', () => {
  const r = decideBlock(mrbeastCase, BLOCKED, withChannels({ channelAllowlist: ['mrbeast'] }));
  assert.deepEqual(r, { decision: 'allow', reason: 'channel-allow' });
});
test('channelAllowlist does NOT rescue a URL/title-blocklist hit', () => {
  const s = withChannels({ blocklist: ['youtube.com/watch'], channelAllowlist: ['mrbeast'] });
  const r = decideBlock(mrbeastCase, BLOCKED, s);
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'blocklist:youtube.com/watch');
});
test('channelAllowlist does NOT rescue a channelBlocklist hit (block wins)', () => {
  const s = withChannels({ channelBlocklist: ['mrbeast'], channelAllowlist: ['mrbeast'] });
  const r = decideBlock(mrbeastCase, BLOCKED, s);
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'channel-block:mrbeast');
});
test('channelAllowlist is irrelevant when the classifier allows on its own', () => {
  const r = decideBlock(mrbeastCase, ALLOWED, withChannels({ channelAllowlist: ['mrbeast'] }));
  assert.deepEqual(r, { decision: 'allow', reason: 'classifier' });
});
test('channelAllowlist is irrelevant below the block threshold', () => {
  const r = decideBlock(
    mrbeastCase,
    { label: 'video games', score: 0.4 },
    withChannels({ channelAllowlist: ['mrbeast'] }),
  );
  assert.deepEqual(r, { decision: 'allow', reason: 'classifier' });
});
test('no channel signal: lists never fire', () => {
  const s = withChannels({ channelBlocklist: ['mrbeast'], channelAllowlist: ['mrbeast'] });
  const c = { input: 'A video game trailer' }; // no url -> no hostname fallback either
  assert.deepEqual(decideBlock(c, BLOCKED, s), { decision: 'block', reason: 'classifier' });
});
test('url-bearing case without a channel signal matches the hostname fallback', () => {
  const c = { input: 'Some untitled watch page', url: YT_WATCH };
  const r = decideBlock(c, ALLOWED, withChannels({ channelBlocklist: ['youtube.com'] }));
  assert.deepEqual(r, { decision: 'block', reason: 'channel-block:youtube.com' });
});
test('neutral classifier verdicts are never "rescued" (already allowed)', () => {
  const r = decideBlock(
    mrbeastCase,
    { label: 'neutral: work and productivity', score: 0.9 },
    withChannels({ channelAllowlist: ['mrbeast'] }),
  );
  assert.deepEqual(r, { decision: 'allow', reason: 'neutral' });
});

// ===========================================================================
// Shared classifier predicate + proof-of-protection policy
// ===========================================================================

const verdict = (label, score, all) => ({
  text: label,
  label,
  score,
  all: all ?? { labels: [label], scores: [score] },
  loadMs: 0,
  inferMs: 1,
  cached: false,
});
const [distractionFixture, productiveFixture] = PROTECTION_FIXTURES;
const passedAccess = { id: 'site-access', status: 'passed', label: 'All-site access', detail: '' };

test('classifier predicate includes the exact threshold and excludes values just below it', () => {
  const v = verdict('video games', 0.5);
  assert.equal(shouldBlockClassifierVerdict(v, ['video games'], 0.5), true);
  assert.equal(shouldBlockClassifierVerdict(verdict('video games', 0.4999), ['video games'], 0.5), false);
});
test('classifier predicate sums blocked top-2 mass and caps it at 1', () => {
  const v = verdict('video games', 0.6, {
    labels: ['video games', 'online shopping', 'music'],
    scores: [0.6, 0.55, 0.1],
  });
  assert.equal(effectiveBlockScore(v, ['video games', 'online shopping']), 1);
  assert.equal(shouldBlockClassifierVerdict(v, ['video games', 'online shopping'], 1), true);
});
test('classifier predicate does not add a neutral or unblocked runner-up', () => {
  const v = verdict('video games', 0.4, {
    labels: ['video games', 'music'],
    scores: [0.4, 0.5],
  });
  assert.equal(shouldBlockClassifierVerdict(v, ['video games'], 0.5), false);
});
test('an unblocked top label never blocks even at high confidence', () => {
  assert.equal(shouldBlockClassifierVerdict(verdict('music', 0.99), ['video games'], 0.5), false);
});
test('compatible fresh fixtures produce honest block and allow evidence', () => {
  const blocked = assessProtectionVerdict(
    distractionFixture,
    verdict('video games', 0.9),
    EVAL_SETTINGS,
  );
  const allowed = assessProtectionVerdict(
    productiveFixture,
    verdict('programming and software development', 0.8),
    EVAL_SETTINGS,
  );
  assert.equal(blocked.status, 'passed');
  assert.equal(blocked.verdict.decision, 'block');
  assert.equal(blocked.verdict.cached, false);
  assert.equal(allowed.status, 'passed');
  assert.equal(allowed.verdict.decision, 'allow');
  assert.equal(summarizeProtectionChecks([passedAccess, blocked, allowed]), 'ready');
});
test('a cached outcome cannot pass readiness even when its label and decision match', () => {
  const check = assessProtectionVerdict(
    distractionFixture,
    { ...verdict('video games', 0.9), cached: true },
    EVAL_SETTINGS,
  );
  assert.equal(check.status, 'error');
  assert.match(check.detail, /cached verdict/);
  assert.equal(summarizeProtectionChecks([passedAccess, check]), 'error');
});
test('custom category settings produce configuration failures, not inference claims', () => {
  const custom = {
    ...EVAL_SETTINGS,
    blockedLabels: [
      ...EVAL_SETTINGS.blockedLabels.filter((label) => label !== 'video games'),
      'programming and software development',
    ],
  };
  const distraction = protectionConfigurationCheck(distractionFixture, custom);
  const productive = protectionConfigurationCheck(productiveFixture, custom);
  assert.equal(distraction.status, 'failed');
  assert.match(distraction.detail, /current settings allow/);
  assert.equal(productive.status, 'failed');
  assert.match(productive.detail, /current settings block/);
  assert.equal(summarizeProtectionChecks([passedAccess, distraction, productive]), 'degraded');
});
test('a missing fixture category is reported before inference', () => {
  const custom = { ...EVAL_SETTINGS, labels: EVAL_SETTINGS.labels.filter((label) => label !== 'video games') };
  const check = protectionConfigurationCheck(distractionFixture, custom);
  assert.equal(check.status, 'failed');
  assert.match(check.detail, /category isn’t active/);
});
test('a correct gaming label below a custom threshold is degraded with threshold guidance', () => {
  const custom = { ...EVAL_SETTINGS, blockThreshold: 0.95 };
  const check = assessProtectionVerdict(distractionFixture, verdict('video games', 0.8), custom);
  assert.equal(check.status, 'failed');
  assert.equal(check.verdict.decision, 'allow');
  assert.match(check.detail, /below your 95% block threshold/);
});
test('an unexpected semantic label never becomes a successful decision check', () => {
  const check = assessProtectionVerdict(distractionFixture, verdict('sports', 0.9), EVAL_SETTINGS);
  assert.equal(check.status, 'failed');
  assert.equal(check.verdict.decision, 'allow');
  assert.match(check.detail, /not “video games”/);
});
test('missing required checks cannot summarize as ready', () => {
  assert.equal(summarizeProtectionChecks([passedAccess]), 'degraded');
  assert.equal(summarizeProtectionChecks([]), 'degraded');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
