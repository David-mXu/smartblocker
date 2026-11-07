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
} from '../src/shared/rules.ts';
import { decideBlock, EVAL_SETTINGS } from './lib/eval-harness.mjs';

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
test('no substring matching: "beast" cannot catch "mrbeast2" and vice versa', () => {
  assert.equal(matchChannel('mrbeast2', ['mrbeast']), null);
  assert.equal(matchChannel('beast', ['mrbeast']), null);
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
