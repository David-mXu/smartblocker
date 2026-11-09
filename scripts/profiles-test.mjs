// Named-profile core, storage composition and lock-guard tests.
// Runs directly under Node >=22.15 type stripping; no browser or runner.
//
//   node scripts/profiles-test.mjs
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
// Minimal storage.local + onChanged harness. Events are asynchronous like the
// real API, so cache invalidation happens on the next macrotask.
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
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, readKey(key)]));
        }
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
        for (const [key, value] of storage) {
          changes[key] = { oldValue: clone(value), newValue: undefined };
        }
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
  runtime: {},
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const policyKeys = (policy) => Object.keys(policy).sort();

const DEFAULT_SETTINGS = {
  labels: ['video games'],
  blockedLabels: ['video games'],
  blockThreshold: 0.5,
  enabled: true,
  onboarded: true,
  whitelist: ['default.example'],
  whitelistVersion: 2,
  blocklist: ['default-block'],
  titleRules: [],
  channelBlocklist: [],
  channelAllowlist: [],
  shareFeedback: false,
  deletedBuiltinLabels: [],
  focusGoal: 'default focus',
  useTabContext: false,
  resolveEmbedTitles: false,
  blockAdult: false,
  resumeMode: 'off',
  resumeAt: null,
  breakMode: 'off',
  breakDelayMinutes: 0,
  breakDurationMinutes: 15,
  breakTextLength: 50,
  surrenderMode: 'off',
  maskSearchElements: true,
};

const WORK_POLICY = {
  labels: ['video games', 'programming and software development'],
  blockedLabels: ['video games'],
  blockThreshold: 0.4,
  whitelist: ['named.example'],
  whitelistVersion: 2,
  blocklist: ['named-block'],
  titleRules: ['named title'],
  channelBlocklist: ['namedchannel'],
  channelAllowlist: [],
  deletedBuiltinLabels: [],
  focusGoal: 'named focus',
  useTabContext: true,
  blockAdult: true,
  maskSearchElements: false,
  surrenderMode: 'phrase',
  breakMode: 'off',
  breakDelayMinutes: 5,
  breakDurationMinutes: 20,
  breakTextLength: 70,
};

storage.set('settings', clone(DEFAULT_SETTINGS));
storage.set('profiles:v1', {
  version: 1,
  activeProfileId: 'p_work',
  profiles: [
    {
      id: 'p_work',
      name: 'Work',
      createdAt: 1000,
      updatedAt: 1000,
      policy: clone(WORK_POLICY),
      appBlocklist: ['steam'],
      appBlocklistUpdatedAt: 10,
    },
  ],
  defaultAppBlocklist: [],
  defaultAppBlocklistUpdatedAt: 0,
});

const profilesModule = await import('../src/shared/profiles.ts');
const {
  MAX_CHANNEL_RULES,
  MAX_NAMED_PROFILES,
  MAX_POLICY_LABELS,
  MAX_POLICY_LIST,
  MAX_PROFILE_NAME_LENGTH,
  MAX_TITLE_RULES,
  PROFILE_GLOBAL_FIELDS,
  PROFILE_POLICY_FIELDS,
  PROFILES_SCHEMA_VERSION,
  activateProfile,
  activeAppAssociation,
  activeProfile,
  applyProfilePolicy,
  createProfile,
  defaultProfilePolicy,
  deleteProfile,
  duplicateProfile,
  extractProfilePolicy,
  migrateLabels,
  migrateWhitelist,
  normalizeProfileName,
  profilePoliciesEqual,
  reconcileAppBlocklist,
  renameProfile,
  sanitizeProfilePolicy,
  sanitizeProfilesState,
} = profilesModule;

// ---------------------------------------------------------------------------
console.log('profile schema + migration');

await test('absent or corrupt state migrates to Default active, named profiles empty', () => {
  for (const raw of [undefined, null, 'nope', 42, { profiles: 'no' }, { activeProfileId: 7 }]) {
    const state = sanitizeProfilesState(raw);
    assert.equal(state.version, PROFILES_SCHEMA_VERSION);
    assert.equal(state.activeProfileId, null);
    assert.deepEqual(state.profiles, []);
    assert.deepEqual(state.defaultAppBlocklist, []);
    assert.equal(state.defaultAppBlocklistUpdatedAt, 0);
  }
});

await test('duplicate ids, duplicate names and the reserved Default name are repaired', () => {
  const state = sanitizeProfilesState({
    activeProfileId: 'p_missing',
    profiles: [
      { id: 'p_same', name: 'Work', policy: WORK_POLICY },
      { id: 'p_same', name: 'Work', policy: WORK_POLICY },
      { id: 'p_three', name: ' default ', policy: WORK_POLICY },
      { id: 'not valid!', name: '', policy: WORK_POLICY },
    ],
  });
  assert.equal(state.activeProfileId, null, 'unknown active id falls back to Default');
  assert.equal(state.profiles.length, 4);
  assert.equal(new Set(state.profiles.map((profile) => profile.id)).size, 4);
  assert.deepEqual(
    state.profiles.map((profile) => profile.name),
    ['Work', 'Work (2)', 'Default profile', 'Profile 4'],
  );
  for (const profile of state.profiles) assert.ok(profile.id.length <= 64);
});

await test('profile snapshots contain exactly the scoped policy fields', () => {
  const state = sanitizeProfilesState({
    profiles: [
      {
        id: 'p_one',
        name: 'One',
        policy: {
          ...WORK_POLICY,
          enabled: false,
          onboarded: true,
          shareFeedback: true,
          resolveEmbedTitles: true,
          resumeMode: 'time',
          resumeAt: 99,
          passwordHash: 'secret',
          lockState: { timerUntil: 5 },
          usage: { pages: 12 },
          corrections: [{ title: 'x' }],
          sampleCount: 4,
          centroid: [0.1, 0.2],
        },
      },
    ],
  });
  assert.deepEqual(policyKeys(state.profiles[0].policy), [...PROFILE_POLICY_FIELDS].sort());
  for (const globalField of PROFILE_GLOBAL_FIELDS) {
    assert.ok(!(globalField in state.profiles[0].policy), `${globalField} leaked into a profile`);
  }
  for (const runtimeField of ['passwordHash', 'lockState', 'usage', 'corrections', 'sampleCount', 'centroid']) {
    assert.ok(!(runtimeField in state.profiles[0].policy), `${runtimeField} leaked into a profile`);
  }
});

await test('numeric, list and name bounds clamp instead of throwing', () => {
  const manySites = Array.from({ length: MAX_POLICY_LIST + 5 }, (_, i) => `site${i}.example`);
  const manyRules = Array.from({ length: MAX_TITLE_RULES + 5 }, (_, i) => `title-${i}`);
  const manyChannels = Array.from({ length: MAX_CHANNEL_RULES + 5 }, (_, i) => `channel${i}`);
  const manyLabels = Array.from({ length: MAX_POLICY_LABELS + 8 }, (_, i) => `label ${i}`);
  const policy = sanitizeProfilePolicy({
    labels: manyLabels,
    blockedLabels: manyLabels,
    blockThreshold: 5,
    whitelist: manySites,
    blocklist: manySites,
    titleRules: manyRules,
    channelBlocklist: manyChannels,
    channelAllowlist: manyChannels,
    focusGoal: 'x'.repeat(600),
    useTabContext: 'yes',
    blockAdult: 1,
    surrenderMode: 'maybe',
  });
  assert.equal(policy.blockThreshold, 0.9);
  assert.equal(policy.whitelist.length, MAX_POLICY_LIST);
  assert.equal(policy.blocklist.length, MAX_POLICY_LIST);
  assert.equal(policy.titleRules.length, MAX_TITLE_RULES);
  assert.equal(policy.channelBlocklist.length, MAX_CHANNEL_RULES);
  assert.equal(policy.channelAllowlist.length, MAX_CHANNEL_RULES);
  assert.equal(policy.focusGoal.length, 500);
  assert.equal(policy.useTabContext, false, 'wrong-typed booleans fall back');
  assert.equal(policy.blockAdult, false);
  assert.equal(policy.surrenderMode, 'off');

  const low = sanitizeProfilePolicy({ blockThreshold: -5 });
  assert.equal(low.blockThreshold, 0.3);
  assert.equal(normalizeProfileName('  a  b  '), 'a b');
  assert.equal(normalizeProfileName('x'.repeat(80)).length, MAX_PROFILE_NAME_LENGTH);
});

await test('at most the configured number of named profiles survives corruption', () => {
  const profiles = Array.from({ length: MAX_NAMED_PROFILES + 3 }, (_, i) => ({
    id: `p_${i}`,
    name: `Profile ${i}`,
    policy: WORK_POLICY,
  }));
  const state = sanitizeProfilesState({ profiles });
  assert.equal(state.profiles.length, MAX_NAMED_PROFILES);
});

await test('whitelist and label migrations are shared, stricter and idempotent', () => {
  const migrated = migrateWhitelist({
    whitelist: ['google.com', 'github.com'],
    whitelistVersion: 1,
  });
  assert.equal(migrated.whitelistVersion, 2);
  assert.ok(!migrated.whitelist.includes('google.com'));
  assert.ok(migrated.whitelist.includes('github.com'));
  assert.ok(migrated.whitelist.includes('mail.google.com'));
  assert.deepEqual(migrateWhitelist(migrated), migrated);

  const labels = migrateLabels({
    labels: ['video games'],
    blockedLabels: ['video games'],
    deletedBuiltinLabels: ['sports'],
  });
  assert.ok(labels.labels.includes('programming and software development'));
  assert.ok(!labels.labels.includes('sports'), 'an explicit deletion is respected');
  assert.ok(labels.blockedLabels.includes('video games'));
  assert.deepEqual(migrateLabels(labels), labels);
});

// ---------------------------------------------------------------------------
console.log('snapshot operations + lock semantics');

await test('extract/apply replaces scoped policy only and preserves global settings', () => {
  const base = {
    ...DEFAULT_SETTINGS,
    ...defaultProfilePolicy(),
    enabled: false,
    onboarded: true,
    shareFeedback: true,
    resolveEmbedTitles: true,
    resumeMode: 'startup',
    resumeAt: 123,
  };
  const policy = extractProfilePolicy({ ...base, ...WORK_POLICY });
  assert.deepEqual(policyKeys(policy), [...PROFILE_POLICY_FIELDS].sort());
  assert.equal(profilePoliciesEqual(policy, extractProfilePolicy({ ...base, ...WORK_POLICY })), true);

  const applied = applyProfilePolicy(base, policy);
  assert.equal(applied.whitelist[0], 'named.example');
  assert.equal(applied.enabled, false);
  assert.equal(applied.shareFeedback, true);
  assert.equal(applied.resolveEmbedTitles, true);
  assert.equal(applied.resumeMode, 'startup');
  assert.equal(applied.resumeAt, 123);
  // The source policy is cloned, never aliased into the settings object.
  applied.whitelist.push('mutated.example');
  assert.ok(!policy.whitelist.includes('mutated.example'));
});

await test('create/duplicate/rename/delete enforce names, ids and limits', () => {
  const empty = sanitizeProfilesState(undefined);
  const created = createProfile(empty, {
    name: 'Work',
    policy: WORK_POLICY,
    now: 10,
    locked: false,
    id: 'p_work',
  });
  assert.equal(created.ok, true);
  assert.equal(created.profile.name, 'Work');
  assert.equal(created.state.activeProfileId, null, 'creation never auto-activates');

  const duplicateName = createProfile(created.state, {
    name: ' work ',
    policy: WORK_POLICY,
    now: 11,
    locked: false,
  });
  assert.equal(duplicateName.ok, false);
  assert.equal(duplicateName.code, 'duplicate-name');

  const reserved = createProfile(created.state, {
    name: 'Default',
    policy: WORK_POLICY,
    now: 11,
    locked: false,
  });
  assert.equal(reserved.ok, false);
  assert.equal(reserved.code, 'reserved-name');

  const copy = duplicateProfile(created.state, 'p_work', { now: 12, locked: false, id: 'p_copy' });
  assert.equal(copy.ok, true);
  assert.equal(copy.profile.name, 'Work copy');
  assert.notEqual(copy.profile.policy, created.profile.policy);

  const renamed = renameProfile(copy.state, 'p_copy', 'Evening', { now: 13, locked: false });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.profile.name, 'Evening');
  assert.equal(renameProfile(renamed.state, 'p_work', 'evening', { now: 14, locked: false }).ok, false);

  const deleted = deleteProfile(renamed.state, 'p_copy', { locked: false });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state.profiles.length, 1);

  let full = created.state;
  for (let i = 1; i < MAX_NAMED_PROFILES; i++) {
    const result = createProfile(full, {
      name: `Profile ${i}`,
      policy: WORK_POLICY,
      now: 20 + i,
      locked: false,
      id: `p_${i}`,
    });
    assert.equal(result.ok, true);
    full = result.state;
  }
  const overflow = createProfile(full, {
    name: 'One too many',
    policy: WORK_POLICY,
    now: 99,
    locked: false,
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'limit');
});

await test('every profile mutation is refused while settings are locked', () => {
  const state = sanitizeProfilesState({
    activeProfileId: 'p_work',
    profiles: [{ id: 'p_work', name: 'Work', policy: WORK_POLICY }],
  });
  const locked = { now: 10, locked: true };
  for (const result of [
    createProfile(state, { ...locked, name: 'New', policy: WORK_POLICY }),
    duplicateProfile(state, 'p_work', locked),
    renameProfile(state, 'p_work', 'Renamed', locked),
    deleteProfile(state, 'p_work', locked),
    activateProfile(state, null, locked),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'locked');
    assert.equal(result.state, state);
  }
});

await test('activation is explicit and deleting the active profile falls back to Default', () => {
  const state = sanitizeProfilesState({
    profiles: [
      { id: 'p_a', name: 'A', policy: WORK_POLICY, appBlocklist: ['steam'], appBlocklistUpdatedAt: 5 },
      { id: 'p_b', name: 'B', policy: WORK_POLICY },
    ],
  });
  const activeA = activateProfile(state, 'p_a', { now: 100, locked: false });
  assert.equal(activeA.ok, true);
  assert.equal(activeA.state.activeProfileId, 'p_a');
  assert.equal(activeA.state.profiles[0].appBlocklistUpdatedAt, 100, 'synced association applies on activation');
  assert.equal(activeA.state.profiles[1].appBlocklistUpdatedAt, 0, 'never-synced association stays deferred');

  const activeB = activateProfile(activeA.state, 'p_b', { now: 200, locked: false });
  assert.equal(activeB.state.profiles[1].appBlocklistUpdatedAt, 0);

  const deleted = deleteProfile(activeB.state, 'p_b', { locked: false });
  assert.equal(deleted.state.activeProfileId, null);
  assert.equal(activeProfile(deleted.state), null);
});

await test('app-list reconciliation obeys stamps and never wipes a first local list', () => {
  const local = (apps, updatedAt) => ({ apps, updatedAt, profileId: null });
  assert.deepEqual(reconcileAppBlocklist(local(['steam'], 0), ['steam'], 0), { action: 'none' });
  assert.deepEqual(reconcileAppBlocklist(local(['Steam.exe'], 0), ['steam'], 9), { action: 'none' });
  assert.deepEqual(reconcileAppBlocklist(local(['steam'], 0), [], 0), {
    action: 'push',
    apps: ['steam'],
    updatedAt: 0,
  });
  assert.deepEqual(reconcileAppBlocklist(local([], 0), ['steam'], 0), {
    action: 'adopt',
    apps: ['steam'],
    updatedAt: 0,
  });
  assert.deepEqual(reconcileAppBlocklist(local(['steam'], 5), ['discord'], 10), {
    action: 'adopt',
    apps: ['discord'],
    updatedAt: 10,
  });
  assert.deepEqual(reconcileAppBlocklist(local(['steam'], 10), ['discord'], 5), {
    action: 'push',
    apps: ['steam'],
    updatedAt: 10,
  });
  assert.deepEqual(reconcileAppBlocklist(local(['steam'], 10), ['discord'], 10), {
    action: 'adopt',
    apps: ['discord'],
    updatedAt: 10,
  });
});

await test('active app association follows the active profile, not Default', () => {
  const state = sanitizeProfilesState({
    activeProfileId: 'p_work',
    profiles: [{ id: 'p_work', name: 'Work', policy: WORK_POLICY, appBlocklist: ['steam'] }],
    defaultAppBlocklist: ['discord'],
  });
  assert.deepEqual(activeAppAssociation(state), { apps: ['steam'], updatedAt: 0, profileId: 'p_work' });
  assert.deepEqual(activeAppAssociation({ ...state, activeProfileId: null }), {
    apps: ['discord'],
    updatedAt: 0,
    profileId: null,
  });
});

// ---------------------------------------------------------------------------
console.log('effective settings + storage integration');

const {
  getDefaultSettings,
  getSettings,
  setSettings,
} = await import('../src/shared/settings.ts');
const {
  activateNamedProfile,
  createNamedProfile,
  deleteNamedProfile,
  getProfilesState,
} = await import('../src/shared/profile-store.ts');

await test('Default stays stored in settings while the active profile overlays scope', async () => {
  const effective = await getSettings();
  assert.equal(effective.whitelist[0], 'named.example');
  assert.equal(effective.blocklist[0], 'named-block');
  assert.equal(effective.focusGoal, 'named focus');
  assert.equal(effective.blockThreshold, 0.4);
  assert.equal(effective.enabled, true, 'global enabled comes from Default');

  const defaultSettings = await getDefaultSettings();
  assert.equal(defaultSettings.whitelist[0], 'default.example');
  assert.equal(defaultSettings.focusGoal, 'default focus');
  assert.equal(defaultSettings.blockThreshold, 0.5);

  const state = await getProfilesState();
  assert.equal(state.activeProfileId, 'p_work');
  assert.equal(activeProfile(state).name, 'Work');
});

await test('scoped edits persist to the active profile; global edits persist once', async () => {
  const next = await setSettings({
    whitelist: ['edited.example'],
    focusGoal: 'edited focus',
    enabled: false,
  });
  assert.equal(next.whitelist[0], 'edited.example');
  assert.equal(next.focusGoal, 'edited focus');
  assert.equal(next.enabled, false);

  const defaultSettings = await getDefaultSettings();
  assert.equal(defaultSettings.whitelist[0], 'default.example', 'Default policy is untouched');
  assert.equal(defaultSettings.focusGoal, 'default focus');
  assert.equal(defaultSettings.enabled, false, 'enabled is a global field');

  const state = await getProfilesState();
  const work = activeProfile(state);
  assert.equal(work.policy.whitelist[0], 'edited.example');
  assert.equal(work.policy.blocklist[0], 'named-block');
  assert.equal(work.policy.focusGoal, 'edited focus');
  assert.equal(work.policy.blockThreshold, 0.4);
});

await test('global-only edits while a profile is active do not rewrite that profile', async () => {
  const before = await getProfilesState();
  await setSettings({ shareFeedback: true, resumeMode: 'startup' });
  const after = await getProfilesState();
  assert.equal(JSON.stringify(before.profiles), JSON.stringify(after.profiles));
  const effective = await getSettings();
  assert.equal(effective.shareFeedback, true);
  assert.equal(effective.resumeMode, 'startup');
});

await test('storage lock freezes profile create/delete/activate and scoped edits', async () => {
  await chrome.storage.local.set({
    lockState: {
      timerUntil: Date.now() + 60_000,
      passwordHash: null,
      passwordTs: 0,
      frozenUntil: null,
      schedules: [],
      schedulesUpdatedAt: 0,
    },
  });
  await tick();

  await assert.rejects(
    () => createNamedProfile({ name: 'Locked out', policy: defaultProfilePolicy() }),
    (error) => error.code === 'locked',
  );
  await assert.rejects(
    () => deleteNamedProfile('p_work'),
    (error) => error.code === 'locked',
  );
  await assert.rejects(
    () => activateNamedProfile(null),
    (error) => error.code === 'locked',
  );
  await assert.rejects(() => setSettings({ blocklist: ['weaker'] }), /locked/i);

  // Enabling ordinary blocking remains the one legal write.
  const enabled = await setSettings({ enabled: true });
  assert.equal(enabled.enabled, true);

  const state = await getProfilesState();
  assert.equal(state.activeProfileId, 'p_work');
  assert.equal(activeProfile(state).policy.blocklist[0], 'named-block');

  // Unlock, then a manual switch to Default keeps the profile snapshots but
  // makes the stored Default policy effective again.
  await chrome.storage.local.set({
    lockState: {
      timerUntil: null,
      passwordHash: null,
      passwordTs: 0,
      frozenUntil: null,
      schedules: [],
      schedulesUpdatedAt: 0,
    },
  });
  await tick();
  await activateNamedProfile(null);
  const effective = await getSettings();
  assert.equal(effective.whitelist[0], 'default.example');
  assert.equal(effective.focusGoal, 'default focus');
  assert.equal(effective.enabled, true);
});

await test('exported policy defaults are composed, not pasted', () => {
  const policy = defaultProfilePolicy();
  assert.deepEqual(policyKeys(policy), [...PROFILE_POLICY_FIELDS].sort());
  assert.equal(policy.blockThreshold, 0.5);
  assert.equal(policy.whitelistVersion, 2);
  assert.ok(policy.whitelist.includes('github.com'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
