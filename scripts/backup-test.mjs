// Versioned configuration backup/restore tests.
// Pure schema/merge coverage + a mocked storage.local integration for the
// lock refusal and the pre-restore recovery slot.
//
//   node scripts/backup-test.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

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

// ---------------------------------------------------------------------------
// Minimal storage.local + onChanged harness (same shape as profiles-test.mjs).
// ---------------------------------------------------------------------------
const storage = new Map();
const changeListeners = [];
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function emitChanges(changes) {
  queueMicrotask(() => {
    for (const listener of changeListeners) listener(changes, 'local');
  });
}
function readKey(key) {
  return clone(storage.get(key));
}
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: readKey(keys) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, readKey(key)]));
        const all = {};
        for (const [key, value] of storage) all[key] = clone(value);
        return all;
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: readKey(key), newValue: clone(value) };
          storage.set(key, clone(value));
        }
        emitChanges(changes);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const key of list) {
          changes[key] = { oldValue: readKey(key), newValue: undefined };
          storage.delete(key);
        }
        emitChanges(changes);
      },
      async clear() {
        const changes = {};
        for (const [key, value] of storage) changes[key] = { oldValue: clone(value), newValue: undefined };
        storage.clear();
        emitChanges(changes);
      },
    },
    onChanged: {
      addListener(listener) {
        changeListeners.push(listener);
      },
      removeListener(listener) {
        const index = changeListeners.indexOf(listener);
        if (index >= 0) changeListeners.splice(index, 1);
      },
    },
  },
  runtime: {
    getManifest: () => ({ version: '0.5.0' }),
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const {
  BACKUP_MAX_BYTES,
  BACKUP_SCHEMA_ID,
  BACKUP_SCHEMA_VERSION,
  applySchedulesToLockState,
  buildBackup,
  buildBackupPreview,
  defaultManagedSettings,
  mergeBackupState,
  parseBackup,
  replaceBackupState,
  sanitizeBackup,
  scheduleLabel,
  serializeBackup,
} = await import('../src/shared/backup.ts');
const { defaultProfilePolicy, sanitizeProfilesState } = await import('../src/shared/profiles.ts');
const backupStore = await import('../src/shared/backup-store.ts');

const NOW = 1_780_000_000_000;
const EXPORTED_AT = new Date(NOW).toISOString();

function makeSettings(overrides = {}) {
  return {
    ...defaultProfilePolicy(),
    ...defaultManagedSettings(),
    onboarded: true,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  const profiles = sanitizeProfilesState(
    overrides.profilesState ?? {
      version: 1,
      activeProfileId: null,
      profiles: [],
      defaultAppBlocklist: [],
      defaultAppBlocklistUpdatedAt: 0,
    },
    NOW,
  );
  return {
    settings: makeSettings(overrides.settings),
    profiles,
    schedules: overrides.schedules ?? [],
    schedulesUpdatedAt: overrides.schedulesUpdatedAt ?? 0,
    categorySchedules: overrides.categorySchedules ?? [],
    categorySchedulesUpdatedAt: overrides.categorySchedulesUpdatedAt ?? 0,
    categorySchedulesPresent: overrides.categorySchedulesPresent ?? false,
  };
}

function makeDoc(source, options = {}) {
  return buildBackup({
    settings: source.settings,
    profiles: source.profiles,
    lockState: {
      schedules: source.schedules,
      schedulesUpdatedAt: source.schedulesUpdatedAt,
      categorySchedules: source.categorySchedules,
      categorySchedulesUpdatedAt: source.categorySchedulesUpdatedAt,
    },
    exportedAt: EXPORTED_AT,
    appVersion: '0.5.0',
    now: NOW,
    ...options,
  });
}

const WORK_POLICY = {
  ...defaultProfilePolicy(),
  blockThreshold: 0.4,
  whitelist: ['named.example'],
  focusGoal: 'named focus',
  blockMessage: 'A note',
};

// ---------------------------------------------------------------------------
console.log('schema, versioning and determinism');

await test('a valid backup round-trips byte-for-byte', () => {
  const source = makeState({
    settings: { whitelist: ['default.example'], focusGoal: 'default focus' },
    profilesState: {
      activeProfileId: 'p_work',
      profiles: [{ id: 'p_work', name: 'Work', policy: WORK_POLICY, appBlocklist: ['steam'] }],
      defaultAppBlocklist: ['discord'],
      defaultAppBlocklistUpdatedAt: 12,
    },
    schedules: [
      {
        id: 's_one',
        label: 'Deep work',
        days: [1, 2, 3, 4, 5],
        startMinutes: 540,
        endMinutes: 1020,
      },
    ],
    schedulesUpdatedAt: 5,
  });
  const text = serializeBackup(makeDoc(source));
  const parsed = parseBackup(text, NOW);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.document.schema, BACKUP_SCHEMA_ID);
  assert.equal(parsed.document.version, BACKUP_SCHEMA_VERSION);
  assert.equal(parsed.document.schedules.rules[0].label, 'Deep work');
  assert.equal(serializeBackup(parsed.document), text);
});

await test('the same config serializes deterministically', () => {
  const source = makeState({
    settings: { whitelist: ['b.example', 'a.example'] },
    profilesState: {
      profiles: [{ id: 'p_a', name: 'A', policy: WORK_POLICY }],
      defaultAppBlocklist: [],
      defaultAppBlocklistUpdatedAt: 0,
    },
  });
  const first = serializeBackup(makeDoc(source));
  const second = serializeBackup(makeDoc(source));
  assert.equal(first, second);
  // Re-ordering source object keys cannot leak into the file: sanitize/build
  // reconstruct a fixed key order.
  const rearranged = {
    ...source,
    settings: Object.fromEntries(Object.entries(source.settings).reverse()),
  };
  assert.equal(serializeBackup(makeDoc(rearranged)), first);
});

await test('corrupt, wrong-schema, future-version and oversized files are rejected', () => {
  const valid = serializeBackup(makeDoc(makeState()));
  const cases = [
    ['not json', 'not json at all'],
    ['wrong schema', JSON.stringify({ ...JSON.parse(valid), schema: 'other.config' })],
    ['future version', JSON.stringify({ ...JSON.parse(valid), version: BACKUP_SCHEMA_VERSION + 1 })],
    ['zero version', JSON.stringify({ ...JSON.parse(valid), version: 0 })],
    ['missing default', JSON.stringify({ ...JSON.parse(valid), default: 'nope' })],
    ['missing profiles', JSON.stringify({ ...JSON.parse(valid), profiles: null })],
    ['missing schedules', JSON.stringify({ ...JSON.parse(valid), schedules: null })],
    ['oversized', 'x'.repeat(BACKUP_MAX_BYTES + 1)],
  ];
  for (const [label, text] of cases) {
    const result = parseBackup(text, NOW);
    assert.equal(result.ok, false, `${label} should fail`);
    assert.ok(result.errors.length > 0, `${label} should explain the failure`);
  }
  const future = parseBackup(cases[2][1], NOW);
  assert.match(future.errors[0].message, /newer/i);
});

await test('sanitize repairs bounds, duplicates and invalid schedule rules', () => {
  const profileList = Array.from({ length: 15 }, (_, index) => ({
    id: 'p_same',
    name: index === 0 ? 'Default' : 'Same',
    policy: { ...WORK_POLICY, whitelist: Array.from({ length: 1005 }, (_, i) => `site${i}.example`) },
  }));
  const raw = {
    schema: BACKUP_SCHEMA_ID,
    version: 1,
    exportedAt: EXPORTED_AT,
    default: { settings: defaultManagedSettings() },
    profiles: profileList,
    schedules: {
      rules: [
        {
          id: 's_ok',
          label: '  Deep\n work\t',
          days: [1, 1, 2],
          startMinutes: 540,
          endMinutes: 600,
        },
        { id: 's_bad', days: [9], startMinutes: 540, endMinutes: 600 },
        { id: 's_equal', days: [1], startMinutes: 600, endMinutes: 600 },
        {
          id: 's_label',
          label: 'L'.repeat(200),
          days: [4],
          startMinutes: 700,
          endMinutes: 800,
        },
        { id: 's_ok', days: [3], startMinutes: 700, endMinutes: 800 },
      ],
    },
    categorySchedules: {
      rules: [
        { id: 'c_ok', days: [1], startMinutes: 500, endMinutes: 600, categories: ['video games'] },
        { id: 'c_none', days: [1], startMinutes: 500, endMinutes: 600, categories: [] },
      ],
    },
  };
  const { document, warnings } = sanitizeBackup(raw, NOW);
  assert.equal(document.profiles.length, 12);
  assert.equal(new Set(document.profiles.map((profile) => profile.id)).size, 12);
  assert.equal(new Set(document.profiles.map((profile) => profile.name.toLowerCase())).size, 12);
  assert.equal(document.profiles[0].policy.whitelist.length, 1000);
  assert.deepEqual(document.schedules.rules.map((rule) => rule.id), ['s_ok', 's_label']);
  assert.deepEqual(document.schedules.rules[0].days, [1, 2]);
  assert.equal(document.schedules.rules[0].label, 'Deep work');
  assert.equal(document.schedules.rules[1].label.length, 80);
  assert.deepEqual(document.categorySchedules.rules.map((rule) => rule.id), ['c_ok']);
  assert.ok(warnings.length > 0);
});

await test('no secrets or runtime state leak into the file', () => {
  const source = makeState({
    settings: {
      passwordHash: 'a'.repeat(64),
      lockKdf: { salt: 'b'.repeat(32), iterations: 210000, v: 2 },
      usageStats: { pages: 99 },
      centroidCache: [1, 2, 3],
      companionPairing: 'pairing-secret',
      pendingFocusSession: { until: NOW },
      onboarded: true,
      whitelist: ['secret-free.example'],
    },
    profilesState: {
      profiles: [
        {
          id: 'p_work',
          name: 'Work',
          policy: WORK_POLICY,
          appBlocklist: ['steam'],
          feedback: [{ title: 'a page' }],
        },
      ],
      defaultAppBlocklist: [],
      defaultAppBlocklistUpdatedAt: 0,
    },
    schedules: [{ id: 's_one', days: [1], startMinutes: 540, endMinutes: 600 }],
  });
  const text = serializeBackup(makeDoc(source));
  const doc = parseBackup(text, NOW).document;
  for (const secret of [
    'passwordHash',
    'lockKdf',
    'usageStats',
    'centroidCache',
    'companionPairing',
    'pendingFocusSession',
    'feedback',
    'onboarded',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]) {
    assert.ok(!text.includes(secret), `${secret} leaked into the backup`);
  }
  assert.deepEqual(Object.keys(doc).sort(), [
    'activeProfileId',
    'app',
    'categorySchedules',
    'default',
    'exportedAt',
    'profiles',
    'schedules',
    'schema',
    'version',
  ]);
});

// ---------------------------------------------------------------------------
console.log('merge and replace semantics');

const local = makeState({
  settings: {
    enabled: true,
    blockThreshold: 0.5,
    whitelist: ['local.example', 'shared.example'],
    blocklist: ['local-block'],
    focusGoal: 'local goal',
  },
  profilesState: {
    activeProfileId: 'p_work',
    profiles: [
      {
        id: 'p_work',
        name: 'Work',
        policy: {
          ...WORK_POLICY,
          blockThreshold: 0.5,
          whitelist: ['local.example'],
          blocklist: ['local-block'],
        },
        appBlocklist: ['steam'],
      },
      {
        id: 'p_local',
        name: 'Local only',
        policy: { ...WORK_POLICY, whitelist: ['local-only.example'] },
      },
    ],
    defaultAppBlocklist: ['discord'],
    defaultAppBlocklistUpdatedAt: 2,
  },
  schedules: [{ id: 's_local', days: [1], startMinutes: 540, endMinutes: 600 }],
  schedulesUpdatedAt: 3,
  categorySchedules: [
    { id: 'c_local', days: [2], startMinutes: 700, endMinutes: 800, categories: ['video games'] },
  ],
  categorySchedulesUpdatedAt: 4,
  categorySchedulesPresent: true,
});

const incoming = makeDoc(
  makeState({
    settings: {
      enabled: false,
      blockThreshold: 0.4,
      whitelist: ['imported.example', 'shared.example'],
      blocklist: ['imported-block'],
      focusGoal: 'imported goal',
    },
    profilesState: {
      activeProfileId: 'p_work',
      profiles: [
        {
          id: 'p_work',
          name: 'Work',
          policy: {
            ...WORK_POLICY,
            blockThreshold: 0.3,
            whitelist: ['imported.example'],
            blocklist: ['imported-block'],
          },
          appBlocklist: ['discord'],
        },
        {
          id: 'p_new',
          name: 'New',
          policy: { ...WORK_POLICY, whitelist: ['new.example'] },
        },
      ],
      defaultAppBlocklist: ['slack'],
      defaultAppBlocklistUpdatedAt: 20,
    },
    schedules: [{ id: 's_imported', days: [3], startMinutes: 900, endMinutes: 960 }],
    schedulesUpdatedAt: 21,
    categorySchedules: [
      { id: 'c_imported', days: [4], startMinutes: 500, endMinutes: 600, categories: ['social media'] },
    ],
    categorySchedulesUpdatedAt: 22,
    categorySchedulesPresent: true,
  }),
);

const options = { now: NOW + 1000, tzOffsetMinutes: 300, tzName: 'America/Toronto' };

await test('merge updates by id, adds new profiles, keeps local-only profiles and unions lists', () => {
  const applied = mergeBackupState(local, incoming, options);
  assert.equal(applied.settings.enabled, false);
  assert.equal(applied.settings.blockThreshold, 0.4);
  assert.deepEqual(applied.settings.focusGoal, 'imported goal');
  assert.ok(applied.settings.whitelist.includes('imported.example'));
  assert.ok(applied.settings.whitelist.includes('local.example'));
  assert.ok(applied.settings.whitelist.includes('shared.example'));
  assert.equal(
    applied.settings.whitelist.filter((site) => site === 'shared.example').length,
    1,
  );
  assert.ok(applied.settings.blocklist.includes('local-block'));
  assert.ok(applied.settings.blocklist.includes('imported-block'));

  assert.equal(applied.profiles.profiles.length, 3);
  const work = applied.profiles.profiles.find((profile) => profile.id === 'p_work');
  assert.equal(work.policy.blockThreshold, 0.3);
  assert.ok(work.policy.whitelist.includes('local.example'));
  assert.ok(work.policy.whitelist.includes('imported.example'));
  assert.deepEqual(work.appBlocklist, ['discord', 'steam']);
  assert.ok(applied.profiles.profiles.some((profile) => profile.name === 'Local only'));
  assert.ok(applied.profiles.profiles.some((profile) => profile.name === 'New'));
  assert.equal(applied.profiles.activeProfileId, 'p_work');

  assert.deepEqual(
    applied.schedules.map((rule) => rule.id),
    ['s_imported', 's_local'],
  );
  assert.deepEqual(
    applied.categorySchedules.map((rule) => rule.id),
    ['c_imported', 'c_local'],
  );
  assert.equal(applied.schedulesUpdatedAt, options.now);
  assert.equal(applied.categorySchedulesUpdatedAt, options.now);
  // Legacy rules get the restore-time timezone pin.
  assert.equal(applied.schedules[0].tzOffsetMinutes, 300);
  assert.equal(applied.schedules[0].tzName, 'America/Toronto');
});

await test('merge matches by normalized name when the stable id differs', () => {
  const named = makeDoc(
    makeState({
      profilesState: {
        activeProfileId: null,
        profiles: [
          {
            id: 'p_other',
            name: 'LOCAL only',
            policy: { ...WORK_POLICY, whitelist: ['renamed.example'] },
          },
        ],
        defaultAppBlocklist: [],
        defaultAppBlocklistUpdatedAt: 0,
      },
    }),
  );
  const applied = mergeBackupState(local, named, options);
  const profile = applied.profiles.profiles.find((entry) => entry.id === 'p_local');
  assert.equal(profile.name.toLowerCase(), 'local only');
  assert.equal(profile.id, 'p_local', 'the local id survives a name match');
  assert.ok(profile.policy.whitelist.includes('renamed.example'));
  assert.equal(
    applied.profiles.profiles.filter((entry) => entry.name.toLowerCase() === 'local only').length,
    1,
  );
});

await test('merge never duplicates names/ids and reports the cap', () => {
  const many = Array.from({ length: 13 }, (_, index) => ({
    id: `p_${index}`,
    name: index === 0 ? 'Work' : `Bulk ${index}`,
    policy: WORK_POLICY,
  }));
  const bulk = makeDoc(
    makeState({
      profilesState: {
        activeProfileId: null,
        profiles: many,
        defaultAppBlocklist: [],
        defaultAppBlocklistUpdatedAt: 0,
      },
    }),
  );
  const applied = mergeBackupState(local, bulk, options);
  assert.ok(applied.profiles.profiles.length <= 12);
  assert.equal(
    new Set(applied.profiles.profiles.map((profile) => profile.id)).size,
    applied.profiles.profiles.length,
  );
  assert.equal(
    new Set(applied.profiles.profiles.map((profile) => profile.name.toLowerCase())).size,
    applied.profiles.profiles.length,
  );
  assert.ok(applied.warnings.some((warning) => /limit/i.test(warning)));
});

await test('replace swaps the managed config and removes local-only profiles/rules', () => {
  const applied = replaceBackupState(local, incoming, options);
  assert.equal(applied.settings.enabled, false);
  assert.equal(applied.settings.blockThreshold, 0.4);
  assert.deepEqual(applied.settings.whitelist, ['imported.example', 'shared.example']);
  assert.deepEqual(applied.profiles.profiles.map((profile) => profile.name), ['Work', 'New']);
  assert.equal(applied.profiles.activeProfileId, 'p_work');
  assert.deepEqual(applied.schedules.map((rule) => rule.id), ['s_imported']);
  assert.deepEqual(applied.categorySchedules.map((rule) => rule.id), ['c_imported']);
  assert.equal(applied.categorySchedulesPresent, true);
  assert.equal(applied.settings.onboarded, true, 'onboarding state stays local');
});

await test('an empty replace category list is an explicit deletion', () => {
  const emptyCategories = makeDoc(
    makeState({
      profilesState: {
        activeProfileId: null,
        profiles: [],
        defaultAppBlocklist: [],
        defaultAppBlocklistUpdatedAt: 0,
      },
    }),
  );
  const applied = replaceBackupState(local, emptyCategories, options);
  assert.deepEqual(applied.categorySchedules, []);
  assert.equal(applied.categorySchedulesPresent, true);
});

await test('merging identical schedules keeps their stamps', () => {
  const same = makeDoc(local);
  const base = { ...local, categorySchedulesPresent: true };
  const applied = mergeBackupState(base, same, options);
  assert.equal(applied.schedulesUpdatedAt, base.schedulesUpdatedAt);
  assert.equal(applied.categorySchedulesUpdatedAt, base.categorySchedulesUpdatedAt);
});

await test('applying schedules preserves every active lock field', () => {
  const lockState = {
    breakStartedAt: 10,
    breakNotBefore: 20,
    breakEndsAt: 30,
    breakUpdatedAt: 40,
    timerUntil: 50,
    passwordHash: 'a'.repeat(64),
    passwordTs: 60,
    delayUntil: 70,
    delayDurationMs: 60000,
    delayUpdatedAt: 80,
    randomTextLen: 12,
    randomTextUpdatedAt: 90,
    frozenUntil: 100,
    partnerArmGeneration: 'b'.repeat(64),
    partnerArmUpdatedAt: 110,
    schedules: [{ id: 'old', days: [1], startMinutes: 1, endMinutes: 2 }],
    schedulesUpdatedAt: 1,
  };
  const applied = replaceBackupState(local, incoming, options);
  const next = applySchedulesToLockState(lockState, applied);
  assert.equal(next.timerUntil, 50);
  assert.equal(next.passwordHash, 'a'.repeat(64));
  assert.equal(next.delayUntil, 70);
  assert.equal(next.randomTextLen, 12);
  assert.equal(next.frozenUntil, 100);
  assert.equal(next.partnerArmGeneration, 'b'.repeat(64));
  assert.equal(next.breakStartedAt, 10);
  assert.deepEqual(next.schedules.map((rule) => rule.id), ['s_imported']);
});

await test('preview names the changes and counts removals for replace', () => {
  const merge = buildBackupPreview(local, incoming, 'merge', options);
  assert.match(merge.summary, /Merge/);
  assert.ok(merge.counts.profilesAdded >= 1);
  assert.ok(merge.counts.profilesUpdated >= 1);
  assert.ok(merge.changes.some((change) => change.kind === 'profile' && change.name === 'New'));
  assert.ok(merge.changes.some((change) => change.kind === 'schedule'));
  assert.equal(scheduleLabel(incoming.schedules.rules[0]).includes('Wed'), true);

  const replace = buildBackupPreview(local, incoming, 'replace', options);
  assert.match(replace.summary, /Replace/);
  assert.ok(replace.counts.profilesRemoved >= 1);
  assert.ok(replace.changes.some((change) => change.name === 'Local only' && change.action === 'remove'));
  assert.ok(replace.counts.schedulesRemoved >= 1);
});

// ---------------------------------------------------------------------------
console.log('storage integration: lock refusal + pre-restore');

const SETTINGS_KEY = 'settings';
const PROFILES_KEY = 'profiles:v1';
const LOCK_KEY = 'lockState';

function storageSnapshot() {
  return JSON.stringify([...storage.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function seedLocal() {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: local.settings,
    [PROFILES_KEY]: local.profiles,
    [LOCK_KEY]: {
      timerUntil: null,
      passwordHash: null,
      passwordTs: 0,
      frozenUntil: null,
      schedules: local.schedules,
      schedulesUpdatedAt: local.schedulesUpdatedAt,
      categorySchedules: local.categorySchedules,
      categorySchedulesUpdatedAt: local.categorySchedulesUpdatedAt,
    },
    usageStats: { secret: true },
    lockKdf: { salt: 'c'.repeat(32), iterations: 210000, v: 2 },
  });
  await tick();
}

await test('restore refuses while settings are locked and writes nothing', async () => {
  await seedLocal();
  await chrome.storage.local.set({
    [LOCK_KEY]: {
      timerUntil: NOW + 60_000,
      passwordHash: null,
      passwordTs: 0,
      frozenUntil: null,
      schedules: local.schedules,
      schedulesUpdatedAt: local.schedulesUpdatedAt,
    },
  });
  await tick();
  const before = storageSnapshot();
  const text = serializeBackup(incoming);
  await assert.rejects(
    () => backupStore.applyBackupText(text, 'merge', NOW),
    (error) => {
      assert.equal(error.name, 'BackupLockedError');
      assert.match(error.message, /locked/i);
      assert.match(error.message, /refused/i);
      return true;
    },
  );
  assert.equal(storageSnapshot(), before, 'no storage write may happen while locked');
});

await test('merge applies, captures a downloadable pre-restore slot, and it restores', async () => {
  await seedLocal();
  const beforeSettings = await chrome.storage.local.get(SETTINGS_KEY);
  const text = serializeBackup(incoming);
  const result = await backupStore.applyBackupText(text, 'merge', NOW);
  assert.equal(result.mode, 'merge');
  const stored = await chrome.storage.local.get([SETTINGS_KEY, PROFILES_KEY, LOCK_KEY]);
  assert.equal(stored[SETTINGS_KEY].blockThreshold, 0.4);
  assert.equal(stored[SETTINGS_KEY].enabled, false);
  assert.equal(stored[SETTINGS_KEY].onboarded, true);
  assert.equal(stored[PROFILES_KEY].profiles.length, 3);
  assert.deepEqual(
    stored[LOCK_KEY].schedules.map((rule) => rule.id),
    ['s_imported', 's_local'],
  );
  assert.equal(stored[LOCK_KEY].timerUntil, null);

  const info = await backupStore.readPreRestoreInfo(NOW);
  assert.ok(info);
  assert.equal(info.document !== null, true);
  assert.ok(info.text.length > 0);
  assert.equal(info.profileCount, 2);
  assert.ok(info.scheduleCount >= 2);
  assert.equal(info.mode, 'merge');

  await backupStore.restorePreRestore(NOW + 1);
  const restored = await chrome.storage.local.get([SETTINGS_KEY, PROFILES_KEY, LOCK_KEY]);
  assert.equal(restored[SETTINGS_KEY].blockThreshold, 0.5);
  assert.equal(restored[SETTINGS_KEY].enabled, true);
  assert.equal(restored[SETTINGS_KEY].onboarded, true);
  assert.equal(restored[PROFILES_KEY].profiles.length, 2);
  assert.deepEqual(
    restored[LOCK_KEY].schedules.map((rule) => rule.id),
    ['s_local'],
  );
  assert.ok(restored[LOCK_KEY].schedulesUpdatedAt > local.schedulesUpdatedAt);
  assert.equal(
    JSON.stringify(restored[SETTINGS_KEY].whitelist),
    JSON.stringify(beforeSettings[SETTINGS_KEY].whitelist),
  );
});

await test('replace applies and the pre-restore slot recovers the replaced state', async () => {
  await seedLocal();
  const result = await backupStore.applyBackupText(serializeBackup(incoming), 'replace', NOW);
  assert.equal(result.mode, 'replace');
  const replaced = await chrome.storage.local.get([SETTINGS_KEY, PROFILES_KEY, LOCK_KEY]);
  assert.deepEqual(replaced[PROFILES_KEY].profiles.map((profile) => profile.name), ['Work', 'New']);
  assert.deepEqual(replaced[LOCK_KEY].schedules.map((rule) => rule.id), ['s_imported']);

  await backupStore.restorePreRestore(NOW + 1);
  const restored = await chrome.storage.local.get([SETTINGS_KEY, PROFILES_KEY, LOCK_KEY]);
  assert.deepEqual(restored[PROFILES_KEY].profiles.map((profile) => profile.name), ['Work', 'Local only']);
  assert.deepEqual(restored[LOCK_KEY].schedules.map((rule) => rule.id), ['s_local']);
  assert.equal(restored[SETTINGS_KEY].blockThreshold, 0.5);
});

await test('preview through the store reports validation errors without writing', async () => {
  await seedLocal();
  const before = storageSnapshot();
  const bad = await backupStore.previewBackupText('{"schema":"nope"}', 'merge', NOW);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(storageSnapshot(), before);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
