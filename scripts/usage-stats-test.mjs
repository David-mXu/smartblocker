// Focused idle-aware usage reducer + persistence/restart tests.
// Runs directly under Node >=22.15 type stripping; no browser or test runner.
//
//   node scripts/usage-stats-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import {
  buildUsageStatsExport,
  emptyUsageStatsState,
  localUsageDate,
  nextLocalUsageMidnight,
  pruneUsageStats,
  recordUsageOverride,
  recordUsagePageSilenced,
  resetUsageCheckpoint,
  RULE_USAGE_CATEGORY,
  splitUsageIntervalAtLocalMidnight,
  summarizeUsageStats,
  transitionUsageCheckpoint,
  usageHostnameFromUrl,
  USAGE_STATS_MAX_CHECKPOINT_GAP_MS,
  USAGE_STATS_MAX_CATEGORIES_PER_DAY,
  USAGE_STATS_MAX_DECISION_IDS,
  USAGE_STATS_MAX_SITES_PER_DAY,
  USAGE_STATS_OTHER_CATEGORIES_BUCKET,
  USAGE_STATS_OTHER_SITES_BUCKET,
  USAGE_STATS_RETENTION_DAYS,
  USAGE_STATS_STORAGE_KEY,
} from '../src/shared/usage-stats.ts';

// Production imports are extensionless for Vite. Resolve those to TypeScript
// only for the persistence tracker imported below.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !specifier.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { UsageStatsTracker } = await import('../src/background/usage-stats-tracker.ts');

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

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
class MemoryUsageStorage {
  data = new Map();
  writes = [];
  removes = 0;
  failNextRemove = false;

  async get(key) {
    return this.data.has(key) ? { [key]: clone(this.data.get(key)) } : {};
  }

  async set(items) {
    this.writes.push(clone(items));
    for (const [key, value] of Object.entries(items)) this.data.set(key, clone(value));
  }

  async remove(key) {
    this.removes++;
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error('injected remove failure');
    }
    this.data.delete(key);
  }
}

const target = (hostname = 'example.com', category = 'programming') => ({ hostname, category });
const activeMs = (state, day) => state.days[day]?.totals.activeMs ?? 0;
const silenced = (state, at, id, hostname = 'example.com') =>
  recordUsagePageSilenced(state, {
    at,
    hostname,
    category: 'video games',
    decisionId: id,
  });

process.env.TZ = 'UTC';
console.log('idle-aware usage statistics tests');

await test('http/https URL extraction keeps only normalized hostnames', () => {
  assert.equal(
    usageHostnameFromUrl('HTTPS://user:secret@WWW.Example.COM:443/private/path?query=secret#fragment'),
    'www.example.com',
  );
  assert.equal(usageHostnameFromUrl('http://localhost:3000/a?b=c'), 'localhost');
  assert.equal(usageHostnameFromUrl('ftp://example.com/private'), null);
  assert.equal(usageHostnameFromUrl('not a url'), null);
  assert.equal(usageHostnameFromUrl(undefined), null);
});

await test('active intervals split at local midnight without fixed 24-hour buckets', () => {
  const start = Date.UTC(2026, 10, 7, 23, 59, 55);
  let state = resetUsageCheckpoint(emptyUsageStatsState(), start, target());
  state = transitionUsageCheckpoint(state, start + 10_000, target());
  assert.equal(activeMs(state, '2026-11-07'), 5_000);
  assert.equal(activeMs(state, '2026-11-08'), 5_000);
  assert.equal(state.days['2026-11-07'].sites['example.com'].activeMs, 5_000);
  assert.equal(state.days['2026-11-08'].categories.programming.activeMs, 5_000);
});

await test('late alarms discard the unverifiable gap instead of charging a capped tail', () => {
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = resetUsageCheckpoint(emptyUsageStatsState(), start, target());
  const late = start + USAGE_STATS_MAX_CHECKPOINT_GAP_MS + 1;
  state = transitionUsageCheckpoint(state, late, target());
  assert.equal(activeMs(state, '2026-11-08'), 0);
  assert.equal(state.checkpoint.at, late);
  state = transitionUsageCheckpoint(state, late + 10_000, target());
  assert.equal(activeMs(state, '2026-11-08'), 10_000);
});

await test('invalid, future-backwards, and idle checkpoint transitions never invent time', () => {
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = resetUsageCheckpoint(emptyUsageStatsState(), start, target());
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(transitionUsageCheckpoint(state, invalid, target()), state);
  }
  state = transitionUsageCheckpoint(state, start - 50_000, target());
  assert.equal(activeMs(state, '2026-11-08'), 0);
  state = resetUsageCheckpoint(emptyUsageStatsState(), start, target());
  state = transitionUsageCheckpoint(state, start + 30_000, null, true);
  assert.equal(activeMs(state, '2026-11-08'), 0);
  assert.equal(state.checkpoint.target, null);
});

await test('duplicate blocked decisions are suppressed globally and per aggregation bucket', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = silenced(emptyUsageStatsState(), at, 'navigation-a:block-1');
  const once = state;
  state = silenced(state, at, 'navigation-a:block-1');
  assert.equal(state, once, 'duplicate should be reference-equal/write-free');
  state = silenced(state, at + 1_000, 'navigation-b:block-1');
  state = silenced(state, at + 2_000, 'navigation-a:block-1');
  const day = state.days['2026-11-08'];
  assert.equal(day.totals.pagesSilenced, 2);
  assert.equal(day.sites['example.com'].pagesSilenced, 2);
  assert.equal(day.categories['video games'].pagesSilenced, 2);
});

await test('counters are safe for unusual category map keys', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  const state = recordUsagePageSilenced(emptyUsageStatsState(), {
    at,
    hostname: 'example.com',
    category: '__proto__',
    decisionId: 'opaque-id',
  });
  assert.equal(state.days['2026-11-08'].categories['__proto__'].pagesSilenced, 1);
  assert.equal({}.pagesSilenced, undefined);
});

await test('override rate is explicit and denominator-empty safe', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = recordUsageOverride(emptyUsageStatsState(), {
    at: now,
    hostname: 'example.com',
    category: 'video games',
  });
  let summary = summarizeUsageStats(buildUsageStatsExport(state, now), now);
  assert.equal(summary.totals.overrides, 1);
  assert.equal(summary.overrideRate, null);
  state = silenced(state, now, 'one');
  state = silenced(state, now, 'two');
  summary = summarizeUsageStats(buildUsageStatsExport(state, now), now);
  assert.equal(summary.totals.pagesSilenced, 2);
  assert.equal(summary.overrideRate, 0.5);
});

await test('rule-derived override and active-time categories never retain rule text or URLs', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  const ruleLabels = [
    'blocked rule: "https://example.test/private?token=secret"',
    'title rule: "private draft /team?token=title-secret"',
    'channel block: "@private-channel"',
  ];
  let state = emptyUsageStatsState();
  for (const category of ruleLabels) {
    state = recordUsageOverride(state, { at, hostname: 'example.test', category });
  }
  state = resetUsageCheckpoint(state, at, target('example.test', ruleLabels[0]));
  state = transitionUsageCheckpoint(state, at + 10_000, target('example.test', ruleLabels[0]));

  const day = state.days['2026-11-08'];
  assert.deepEqual(Object.keys(day.categories), [RULE_USAGE_CATEGORY]);
  assert.equal(day.categories[RULE_USAGE_CATEGORY].overrides, 3);
  assert.equal(day.categories[RULE_USAGE_CATEGORY].activeMs, 10_000);
  const serialized = JSON.stringify({ state, exported: buildUsageStatsExport(state, at + 10_000) });
  for (const privateText of [
    'token=secret',
    'token=title-secret',
    '@private-channel',
    '/private',
    'blocked rule:',
    'title rule:',
    'channel block:',
  ]) {
    assert.ok(!serialized.includes(privateText), `usage data leaked ${privateText}`);
  }
});

await test('rolling weekly summaries use local civil days and ignore older rows', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = silenced(emptyUsageStatsState(), now, 'this-week');
  state = silenced(state, now - 6 * 86_400_000, 'seven-days-ago-inclusive');
  state = silenced(state, now - 7 * 86_400_000, 'eight-days-ago-excluded');
  const summary = summarizeUsageStats(buildUsageStatsExport(state, now), now);
  assert.equal(summary.days, 2);
  assert.equal(summary.totals.pagesSilenced, 2);
});

await test('retention prunes old daily aggregates and their opaque dedupe IDs', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const old = now - USAGE_STATS_RETENTION_DAYS * 86_400_000;
  let state = silenced(emptyUsageStatsState(), old, 'old');
  state = silenced(state, now, 'current');
  state = pruneUsageStats(state, now);
  assert.equal(Object.keys(state.days).length, 1);
  assert.ok(state.days['2026-11-08']);
  assert.deepEqual(state.recentSilenced, [{ id: 'current', day: '2026-11-08' }]);
});

await test('dedupe metadata is bounded', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = emptyUsageStatsState();
  for (let i = 0; i < USAGE_STATS_MAX_DECISION_IDS + 5; i++) {
    state = silenced(state, at, `decision-${i}`);
  }
  assert.equal(state.recentSilenced.length, USAGE_STATS_MAX_DECISION_IDS);
  assert.equal(state.recentSilenced[0].id, 'decision-5');
  assert.equal(state.days['2026-11-08'].totals.pagesSilenced, USAGE_STATS_MAX_DECISION_IDS + 5);
});

await test('daily host/category maps stay bounded without losing total counters', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = emptyUsageStatsState();
  const count = USAGE_STATS_MAX_SITES_PER_DAY + 5;
  for (let i = 0; i < count; i++) {
    state = recordUsagePageSilenced(state, {
      at,
      hostname: `site-${i}.example`,
      category: `category-${i}`,
      decisionId: `bounded-${i}`,
    });
  }
  const day = state.days['2026-11-08'];
  assert.equal(Object.keys(day.sites).length, USAGE_STATS_MAX_SITES_PER_DAY);
  assert.equal(Object.keys(day.categories).length, USAGE_STATS_MAX_CATEGORIES_PER_DAY);
  assert.equal(day.totals.pagesSilenced, count);
  assert.equal(day.sites[USAGE_STATS_OTHER_SITES_BUCKET].pagesSilenced, 6);
  assert.equal(day.categories[USAGE_STATS_OTHER_CATEGORIES_BUCKET].pagesSilenced, count - (USAGE_STATS_MAX_CATEGORIES_PER_DAY - 1));
});

await test('JSON export has aggregate days only, never checkpoints, event trails, or URLs', () => {
  const at = Date.UTC(2026, 10, 8, 12, 0, 0);
  let state = resetUsageCheckpoint(emptyUsageStatsState(), at, target());
  state = silenced(state, at, 'opaque-navigation-id');
  const exported = buildUsageStatsExport(state, at);
  assert.equal(exported.version, 1);
  assert.equal(exported.retentionDays, USAGE_STATS_RETENTION_DAYS);
  assert.equal(exported.days[0].date, '2026-11-08');
  assert.ok(exported.metricDefinitions.overrideRate.includes('null'));
  const json = JSON.stringify(exported);
  assert.ok(!json.includes('"checkpoint":'));
  assert.ok(!json.includes('"recentSilenced":'));
  assert.ok(!json.includes('opaque-navigation-id'));
  assert.ok(!json.includes('/private'));
});

await test('civil-date helpers observe spring 23-hour and fall 25-hour DST days', () => {
  const previousTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const spring = new Date(2026, 2, 8, 0, 0, 0).getTime();
    const fall = new Date(2026, 10, 1, 0, 0, 0).getTime();
    assert.equal(nextLocalUsageMidnight(spring) - spring, 23 * 3_600_000);
    assert.equal(nextLocalUsageMidnight(fall) - fall, 25 * 3_600_000);
    const fallChunks = splitUsageIntervalAtLocalMidnight(fall - 3_600_000, fall + 3_600_000);
    assert.deepEqual(fallChunks.map((chunk) => chunk.end - chunk.start), [3_600_000, 3_600_000]);
    assert.equal(localUsageDate(Date.UTC(2026, 10, 1, 5, 30)), '2026-11-01');
    assert.equal(localUsageDate(Date.UTC(2026, 10, 1, 6, 30)), '2026-11-01');
  } finally {
    process.env.TZ = previousTz;
  }
});

await test('tracker batches writes, suppresses duplicates, and stores no full event URL', async () => {
  process.env.TZ = 'UTC';
  const storage = new MemoryUsageStorage();
  let now = Date.UTC(2026, 10, 7, 23, 59, 45);
  let resolution = { target: target(), discardPrevious: false };
  const tracker = new UsageStatsTracker(storage, () => resolution, () => now);
  try {
    await tracker.checkpoint(); // first observation is recovery/initialization only
    now += 30_000;
    await tracker.checkpoint();
    assert.equal(storage.writes.length, 0, 'event path should batch, not write immediately');
    assert.equal(
      await tracker.recordSilenced({
        url: 'https://example.com/private/movie?query=do-not-store#fragment',
        category: 'movies and tv shows',
        decisionId: 'nav-1:block-1',
      }),
      true,
    );
    assert.equal(
      await tracker.recordSilenced({
        url: 'https://example.com/private/movie?query=do-not-store#fragment',
        category: 'movies and tv shows',
        decisionId: 'nav-1:block-1',
      }),
      false,
    );
    assert.equal(
      await tracker.recordOverride({
        url: 'https://example.com/private/movie?query=do-not-store#fragment',
        category: 'movies and tv shows',
      }),
      true,
    );
    assert.equal(storage.writes.length, 0, 'several same-turn events should remain coalesced');
    const exported = await tracker.snapshot();
    assert.equal(storage.writes.length, 1, 'snapshot forces exactly one pending batch flush');
    assert.equal(exported.days[0].totals.pagesSilenced, 1);
    assert.equal(exported.days[0].totals.overrides, 1);
    assert.equal(exported.days.reduce((sum, day) => sum + day.totals.activeMs, 0), 30_000);
    const raw = JSON.stringify(storage.data.get(USAGE_STATS_STORAGE_KEY));
    assert.ok(raw.includes('example.com'));
    assert.ok(!raw.includes('/private'));
    assert.ok(!raw.includes('do-not-store'));
    assert.ok(!raw.includes('query='));
  } finally {
    tracker.dispose();
    resolution = { target: null, discardPrevious: true };
  }
});

await test('serialized overlapping checkpoints and restart recovery never double-charge', async () => {
  const storage = new MemoryUsageStorage();
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  let now = start;
  const resolution = { target: target(), discardPrevious: false };
  const first = new UsageStatsTracker(storage, () => resolution, () => now);
  await first.checkpoint();
  now += 20_000;
  await Promise.all([first.checkpoint(), first.checkpoint(), first.checkpoint()]);
  let exported = await first.snapshot();
  assert.equal(exported.days[0].totals.activeMs, 20_000);
  const writesBeforeRestart = storage.writes.length;
  first.dispose();

  const restarted = new UsageStatsTracker(storage, () => resolution, () => now);
  try {
    now += 60_000;
    await restarted.checkpoint(); // recovery discards the entire pre-restart gap
    exported = await restarted.snapshot();
    assert.equal(exported.days[0].totals.activeMs, 20_000);
    assert.equal(storage.writes.length, writesBeforeRestart + 1);

    now += USAGE_STATS_MAX_CHECKPOINT_GAP_MS + 10_000;
    await restarted.checkpoint(); // late heartbeat discards the stale interval
    exported = await restarted.snapshot();
    assert.equal(exported.days[0].totals.activeMs, 20_000);
    now += 5_000;
    await restarted.checkpoint();
    exported = await restarted.snapshot();
    assert.equal(exported.days[0].totals.activeMs, 25_000);
  } finally {
    restarted.dispose();
  }
});

await test('queued checkpoints retain their event timestamps behind a slow resolution', async () => {
  const storage = new MemoryUsageStorage();
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  let now = start;
  let resolution = { target: target(), discardPrevious: false };
  let resolutions = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const tracker = new UsageStatsTracker(
    storage,
    () => {
      resolutions++;
      if (resolutions === 1) {
        const firstResolution = resolution;
        return new Promise((resolve) => {
          releaseFirst = () => resolve(firstResolution);
          markFirstStarted();
        });
      }
      return resolution;
    },
    () => now,
  );
  try {
    const initial = tracker.checkpoint();
    await firstStarted;
    now += 30_000;
    resolution = { target: null, discardPrevious: false };
    const unfocus = tracker.checkpoint();
    now += 30_000;
    releaseFirst();
    await Promise.all([initial, unfocus]);
    const exported = await tracker.snapshot();
    assert.equal(exported.days[0].totals.activeMs, 30_000);
  } finally {
    releaseFirst?.();
    tracker.dispose();
  }
});

await test('idle discards uncertain time; a precise unfocus boundary closes active time', async () => {
  const storage = new MemoryUsageStorage();
  const start = Date.UTC(2026, 10, 8, 12, 0, 0);
  let now = start;
  let resolution = { target: target(), discardPrevious: false };
  const tracker = new UsageStatsTracker(storage, () => resolution, () => now);
  try {
    await tracker.checkpoint();
    now += 20_000;
    resolution = { target: null, discardPrevious: true };
    await tracker.checkpoint();
    let exported = await tracker.snapshot();
    assert.equal(exported.days.length, 0, 'idle observation should not charge the preceding gap');

    now += 10_000;
    resolution = { target: target(), discardPrevious: false };
    await tracker.checkpoint();
    now += 15_000;
    resolution = { target: null, discardPrevious: false };
    await tracker.checkpoint();
    exported = await tracker.snapshot();
    assert.equal(exported.days[0].totals.activeMs, 15_000);
  } finally {
    tracker.dispose();
  }
});

await test('clear removes the persisted namespace and returns an actually empty export', async () => {
  const storage = new MemoryUsageStorage();
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const tracker = new UsageStatsTracker(storage, () => ({ target: target(), discardPrevious: false }), () => now);
  try {
    await tracker.recordSilenced({
      url: 'https://example.com/a?private=1',
      category: 'video games',
      decisionId: 'one',
    });
    await tracker.snapshot();
    assert.ok(storage.data.has(USAGE_STATS_STORAGE_KEY));
    const exported = await tracker.clear();
    assert.deepEqual(exported.days, []);
    assert.equal(storage.data.has(USAGE_STATS_STORAGE_KEY), false);
    assert.equal(storage.removes, 1);
  } finally {
    tracker.dispose();
  }
});

await test('failed clear preserves durable and in-memory data and remains retryable', async () => {
  const storage = new MemoryUsageStorage();
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const tracker = new UsageStatsTracker(storage, () => ({ target: null, discardPrevious: false }), () => now);
  try {
    await tracker.recordSilenced({
      url: 'https://example.com/a?private=1',
      category: 'video games',
      decisionId: 'one',
    });
    await tracker.snapshot();
    storage.failNextRemove = true;
    await assert.rejects(tracker.clear(), /injected remove failure/);
    const afterFailure = await tracker.snapshot();
    assert.equal(afterFailure.days[0].totals.pagesSilenced, 1);
    assert.equal(storage.data.get(USAGE_STATS_STORAGE_KEY).days['2026-11-08'].totals.pagesSilenced, 1);
    const afterRetry = await tracker.clear();
    assert.deepEqual(afterRetry.days, []);
    assert.equal(storage.data.has(USAGE_STATS_STORAGE_KEY), false);
  } finally {
    tracker.dispose();
  }
});

await test('background listeners dedupe real session status events and gate focus/idle time', async () => {
  const previousChrome = globalThis.chrome;
  const previousDateNow = Date.now;
  const makeEvent = () => {
    const listeners = [];
    return {
      listeners,
      addListener(listener) {
        listeners.push(listener);
      },
      emit(...args) {
        for (const listener of [...listeners]) listener(...args);
      },
    };
  };
  const storage = new MemoryUsageStorage();
  const storageChanges = makeEvent();
  const sessionValues = new Map();
  const session = {
    async get(key) {
      return sessionValues.has(key) ? { [key]: clone(sessionValues.get(key)) } : {};
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: clone(sessionValues.get(key)), newValue: clone(value) };
        sessionValues.set(key, clone(value));
      }
      storageChanges.emit(changes, 'session');
    },
    async remove(key) {
      const oldValue = sessionValues.get(key);
      sessionValues.delete(key);
      storageChanges.emit({ [key]: { oldValue, newValue: undefined } }, 'session');
    },
  };
  const events = {
    focus: makeEvent(),
    idle: makeEvent(),
    activated: makeEvent(),
    removed: makeEvent(),
    updated: makeEvent(),
    committed: makeEvent(),
    historyState: makeEvent(),
    alarm: makeEvent(),
  };
  const window = { id: 1, focused: true };
  const tab = { id: 7, windowId: 1, active: true, url: 'https://example.com/video?private=1', title: 'Private title' };
  let idleState = 'active';
  let now = Date.UTC(2026, 10, 8, 12, 0, 0);
  Date.now = () => now;
  globalThis.chrome = {
    storage: { local: storage, session, onChanged: storageChanges },
    windows: {
      onFocusChanged: events.focus,
      async getLastFocused() {
        return window;
      },
    },
    idle: {
      onStateChanged: events.idle,
      async queryState() {
        return idleState;
      },
      async setDetectionInterval() {},
    },
    tabs: {
      onActivated: events.activated,
      onRemoved: events.removed,
      onUpdated: events.updated,
      async query() {
        return [tab];
      },
    },
    webNavigation: {
      onCommitted: events.committed,
      onHistoryStateUpdated: events.historyState,
    },
    alarms: {
      onAlarm: events.alarm,
      async create() {},
    },
  };

  try {
    const usage = await import('../src/background/usage-stats.ts');
    usage.initUsageStats();
    await usage.getUsageStatsSnapshot();

    // Simulate a blocked verdict that predates a service-worker restart. Its
    // re-emission must reconstruct dedupe state without counting the page again.
    const restoredBlockedStatus = {
      url: tab.url,
      title: 'A private page title that must not be persisted',
      kind: 'blocked',
      label: 'video games',
      score: 0.99,
      ts: now,
    };
    sessionValues.set('tabStatus:7', clone(restoredBlockedStatus));
    await session.set({ 'tabStatus:7': { ...restoredBlockedStatus, ts: now + 1 } });
    let exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0]?.totals.pagesSilenced ?? 0, 0);

    now += 10_000;
    events.activated.emit({ tabId: 7, windowId: 1 });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.activeMs, 10_000);

    const status = {
      url: tab.url,
      title: 'A private page title that must not be persisted',
      kind: 'blocked',
      label: 'video games',
      score: 0.99,
      ts: now,
    };
    // A real committed navigation is a fresh generation even at the same URL.
    events.committed.emit({ frameId: 0, tabId: 7, url: tab.url });
    await session.set({ 'tabStatus:7': status });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.pagesSilenced, 1);
    await session.set({ 'tabStatus:7': status });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.pagesSilenced, 1, 'same overlay status must count once');
    events.committed.emit({ frameId: 0, tabId: 7, url: tab.url });
    await session.set({ 'tabStatus:7': { ...status, ts: now + 1_000 } });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.pagesSilenced, 2, 'same-URL reload is a new navigation decision');
    const rawLocal = JSON.stringify(storage.data.get(USAGE_STATS_STORAGE_KEY));
    assert.ok(!rawLocal.includes(status.title));
    assert.ok(!rawLocal.includes('private=1'));
    assert.ok(!rawLocal.includes('0.99'));

    now += 20_000;
    idleState = 'idle';
    events.idle.emit('idle');
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.activeMs, 10_000, 'idle transition must discard uncertain time');

    now += 5_000;
    idleState = 'active';
    events.idle.emit('active');
    await usage.getUsageStatsSnapshot();
    now += 10_000;
    window.focused = false;
    events.focus.emit(1);
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.activeMs, 20_000, 'unfocus closes only the prior active segment');

    now += 5_000;
    window.focused = true;
    events.focus.emit(1);
    await usage.getUsageStatsSnapshot();
    now += USAGE_STATS_MAX_CHECKPOINT_GAP_MS + 1;
    events.alarm.emit({ name: 'usage-stats-heartbeat' });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].totals.activeMs, 20_000, 'late alarm must not add a capped interval');

    // An authenticated deterministic-rule override carries its user-facing
    // label. Subsequent active time must collapse it to a generic category,
    // just like the direct override counter, rather than storing its URL/rule.
    const privateRule = 'blocked rule: "https://example.com/private?token=do-not-store"';
    await session.set({
      'tabStatus:7': { ...status, kind: 'overridden', label: privateRule, ts: now },
    });
    now += 10_000;
    events.activated.emit({ tabId: 7, windowId: 1 });
    exported = await usage.getUsageStatsSnapshot();
    assert.equal(exported.days[0].categories[RULE_USAGE_CATEGORY].activeMs, 10_000);
    const finalRaw = JSON.stringify({
      stored: storage.data.get(USAGE_STATS_STORAGE_KEY),
      exported,
    });
    assert.ok(!finalRaw.includes(privateRule));
    assert.ok(!finalRaw.includes('token=do-not-store'));
    assert.ok(!finalRaw.includes('blocked rule:'));
  } finally {
    Date.now = previousDateNow;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

await test('both manifests request idle and no new stats source reads chrome.history', async () => {
  for (const browser of ['chrome', 'firefox']) {
    const manifest = JSON.parse(await readFile(new URL(`../manifests/${browser}.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.permissions.filter((permission) => permission === 'idle').length, 1);
  }
  for (const file of [
    '../src/shared/usage-stats.ts',
    '../src/background/usage-stats.ts',
    '../src/background/usage-stats-tracker.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!source.includes('chrome.history'), `${file} must not read browser history`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
