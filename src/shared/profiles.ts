// Named profiles — additive, versioned policy snapshots for SmartBlocker.
//
// SEMANTICS (user-approved 2026-11-09):
// - The existing `settings` storage object IS the Default profile. It is the
//   migration/fallback state and is never rewritten while a named profile is
//   active.
// - A named profile replaces Default ONLY for the scoped policy fields below.
//   Global settings (master enabled switch, onboarding, feedback sharing,
//   auto-resume, oEmbed resolution) stay global. One profile is active at a
//   time (`activeProfileId`; null = Default).
// - Local AI corrections, centroids, feedback, usage stats, lock state,
//   passwords/KDF and secrets are deliberately NOT part of a profile.
// - Switching or editing profiles is refused while `settingsLocked`, so a
//   profile action can never silently weaken an active lock. Raw storage
//   writes from devtools remain the accepted soft-lock residual, as with all
//   settings.
// - A profile also associates a native app blocklist (`appBlocklist`) that the
//   background bridge applies to the desktop companion. The list is not a
//   classifier policy; it is an association carried with the profile.
//
// This module is PURE (no browser APIs) and erasable-syntax-only so
// scripts/profiles-test.mjs can load it under Node type stripping.
import {
  BLOCKED_LABELS,
  BLOCK_THRESHOLD,
  DEFAULT_WHITELIST,
  GOOGLE_PRODUCTIVE_HOSTS,
  LABELS,
  LEGACY_SEARCH_WHITELIST,
} from './config';
import {
  BREAK_DELAY_MINUTES_DEFAULT,
  BREAK_DURATION_MINUTES_DEFAULT,
  BREAK_TEXT_LENGTH_DEFAULT,
  clampBreakDelayMinutes,
  clampBreakDurationMinutes,
  clampBreakTextLength,
  normalizeBreakMode,
} from './breaks';
import { appBlocklistEqual, normalizeAppBlocklist } from './apps';
import { sanitizeBlockMessage } from './display-prefs';
import type { Settings } from './settings';

export const PROFILES_SCHEMA_VERSION = 1;
/** Deliberately a NEW key: an absent value migrates to "Default is active",
 *  which leaves every existing install's settings byte-for-byte untouched. */
export const PROFILES_STORAGE_KEY = 'profiles:v1';

/** Version of the whitelist default-list migration. Moved here so Default
 *  settings and every named profile migrate through the same code. */
export const WHITELIST_VERSION = 2;

export const MAX_NAMED_PROFILES = 12;
export const MAX_PROFILE_NAME_LENGTH = 48;
export const MAX_PROFILE_ID_LENGTH = 64;
export const MAX_POLICY_LABELS = 40;
export const MAX_POLICY_LIST = 1000;
export const MAX_TITLE_RULES = 500;
export const MAX_CHANNEL_RULES = 300;
export const MAX_FOCUS_GOAL_LENGTH = 500;
export const MIN_BLOCK_THRESHOLD = 0.3;
export const MAX_BLOCK_THRESHOLD = 0.9;

/**
 * The exact fields an active named profile replaces on Default. Keep this as
 * a `keyof Settings` check — adding a field here without adding it to
 * `Settings` is a compile error, and the tests assert the snapshot never
 * contains runtime state (lock, feedback, usage, onboarding, passwords).
 */
export const PROFILE_POLICY_FIELDS = [
  'labels',
  'blockedLabels',
  'blockThreshold',
  'whitelist',
  'whitelistVersion',
  'blocklist',
  'titleRules',
  'channelBlocklist',
  'channelAllowlist',
  'deletedBuiltinLabels',
  'focusGoal',
  'useTabContext',
  'blockAdult',
  'maskSearchElements',
  'surrenderMode',
  'blockMessage',
  'breakMode',
  'breakDelayMinutes',
  'breakDurationMinutes',
  'breakTextLength',
] as const satisfies readonly (keyof Settings)[];

export type ProfilePolicyKey = (typeof PROFILE_POLICY_FIELDS)[number];
export type ProfilePolicy = Pick<Settings, ProfilePolicyKey>;

const PROFILE_POLICY_FIELD_SET = new Set<string>(PROFILE_POLICY_FIELDS);

export function isProfilePolicyField(key: string): key is ProfilePolicyKey {
  return PROFILE_POLICY_FIELD_SET.has(key);
}

/** Global settings a profile never carries. Documented for tests + reviewers. */
export const PROFILE_GLOBAL_FIELDS = [
  'enabled',
  'onboarded',
  'shareFeedback',
  'resolveEmbedTitles',
  'resumeMode',
  'resumeAt',
] as const satisfies readonly (keyof Settings)[];

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  policy: ProfilePolicy;
  /** Lowercase exe stems associated with this profile. */
  appBlocklist: string[];
  /** Companion clock stamp of the association's last accepted apply/edit.
   *  0 means "never synchronized"; the daemon's existing list wins. */
  appBlocklistUpdatedAt: number;
}

export interface ProfilesState {
  version: number;
  /** null = Default profile active. One active named profile at a time. */
  activeProfileId: string | null;
  profiles: Profile[];
  /** Default profile's native-app association (companion config is external). */
  defaultAppBlocklist: string[];
  defaultAppBlocklistUpdatedAt: number;
}

export interface AppAssociation {
  apps: string[];
  updatedAt: number;
  profileId: string | null;
}

export type ProfileOpCode =
  | 'locked'
  | 'invalid-name'
  | 'duplicate-name'
  | 'reserved-name'
  | 'limit'
  | 'not-found'
  | 'duplicate-id';

export interface ProfileOpFailure {
  ok: false;
  code: ProfileOpCode;
  error: string;
  state: ProfilesState;
}

export interface ProfileOpSuccess<T = Profile> {
  ok: true;
  state: ProfilesState;
  profile?: T;
}

export type ProfileOpResult<T = Profile> = ProfileOpSuccess<T> | ProfileOpFailure;

export interface ProfileMutationOptions {
  now: number;
  locked: boolean;
  /** Deterministic tests may supply an id; production mints a UUID. */
  id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeLabel(value: string): string {
  return normalizeText(value, 80).toLowerCase();
}

function safeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value)
    : fallback;
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeStringList(
  value: unknown,
  fallback: readonly string[],
  maxItems: number,
  normalize: (entry: string) => string,
  minLength = 1,
): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalize(item);
    if (normalized.length < minLength) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeListEntry(value: string): string {
  return normalizeText(value, 300);
}

function normalizeAppBlocklistTimestamp(value: unknown): number {
  return safeTimestamp(value, 0);
}

/** v1 → v2 whitelist migration (moved from settings.ts so profiles and the
 *  Default profile share exactly one implementation). Runs at read time, so it
 *  is safe while locked: it only ever shrinks exemptions (stricter). */
export function migrateWhitelist(
  stored: Partial<Pick<ProfilePolicy, 'whitelist' | 'whitelistVersion'>> | undefined,
  fallback: readonly string[] = DEFAULT_WHITELIST,
): Pick<ProfilePolicy, 'whitelist' | 'whitelistVersion'> {
  if (!Array.isArray(stored?.whitelist)) {
    return { whitelist: [...fallback], whitelistVersion: WHITELIST_VERSION };
  }
  let whitelist = sanitizeStringList(
    stored.whitelist,
    fallback,
    MAX_POLICY_LIST,
    normalizeListEntry,
  );
  const rawVersion = stored?.whitelistVersion;
  let version =
    typeof rawVersion === 'number' && Number.isSafeInteger(rawVersion) && rawVersion >= 1
      ? rawVersion
      : 1;
  if (version >= WHITELIST_VERSION) return { whitelist, whitelistVersion: version };

  const norm = (entry: string) => entry.trim().toLowerCase().replace(/^www\./, '');
  const legacy = new Set(LEGACY_SEARCH_WHITELIST);
  const hadGoogleRoot = whitelist.some((entry) => norm(entry) === 'google.com');
  whitelist = whitelist.filter((entry) => !legacy.has(norm(entry)));
  if (hadGoogleRoot) {
    const present = new Set(whitelist.map(norm));
    for (const host of GOOGLE_PRODUCTIVE_HOSTS) if (!present.has(host)) whitelist.push(host);
  }
  version = WHITELIST_VERSION;
  return { whitelist, whitelistVersion: version };
}

/** Append canonical labels that an existing install has never seen, while
 *  respecting explicit deletions. Used by both Default and named profiles. */
export function migrateLabels(
  stored:
    | Partial<Pick<ProfilePolicy, 'labels' | 'blockedLabels' | 'deletedBuiltinLabels'>>
    | undefined,
  fallback: Pick<ProfilePolicy, 'labels' | 'blockedLabels'> = {
    labels: [...LABELS],
    blockedLabels: [...BLOCKED_LABELS],
  },
): Pick<ProfilePolicy, 'labels' | 'blockedLabels' | 'deletedBuiltinLabels'> {
  if (!Array.isArray(stored?.labels)) {
    return {
      labels: [...fallback.labels],
      blockedLabels: [...fallback.blockedLabels],
      deletedBuiltinLabels: [],
    };
  }
  const deletedBuiltinLabels = sanitizeStringList(
    stored.deletedBuiltinLabels ?? [],
    [],
    MAX_POLICY_LABELS,
    normalizeLabel,
  );
  const labels = sanitizeStringList(
    stored.labels,
    fallback.labels,
    MAX_POLICY_LABELS,
    normalizeLabel,
  );
  const known = new Set(labels);
  const deleted = new Set(deletedBuiltinLabels);
  const missing = LABELS.filter((label) => !known.has(label) && !deleted.has(label));
  const nextLabels = [...labels, ...missing];
  const blockedLabels = sanitizeStringList(
    stored.blockedLabels ?? fallback.blockedLabels,
    fallback.blockedLabels,
    MAX_POLICY_LABELS,
    normalizeLabel,
  ).filter((label) => nextLabels.includes(label));
  return {
    labels: nextLabels,
    blockedLabels: [
      ...blockedLabels,
      ...missing.filter((label) => BLOCKED_LABELS.has(label)),
    ],
    deletedBuiltinLabels,
  };
}

/** Every policy default is composed from config.ts, never pasted values. */
export function defaultProfilePolicy(
  whitelistVersion: number = WHITELIST_VERSION,
): ProfilePolicy {
  return {
    labels: [...LABELS],
    blockedLabels: [...BLOCKED_LABELS],
    blockThreshold: BLOCK_THRESHOLD,
    whitelist: [...DEFAULT_WHITELIST],
    whitelistVersion,
    blocklist: [],
    titleRules: [],
    channelBlocklist: [],
    channelAllowlist: [],
    deletedBuiltinLabels: [],
    focusGoal: '',
    useTabContext: false,
    blockAdult: false,
    maskSearchElements: true,
    surrenderMode: 'off',
    blockMessage: '',
    breakMode: 'off',
    breakDelayMinutes: BREAK_DELAY_MINUTES_DEFAULT,
    breakDurationMinutes: BREAK_DURATION_MINUTES_DEFAULT,
    breakTextLength: BREAK_TEXT_LENGTH_DEFAULT,
  };
}

export function cloneProfilePolicy(policy: ProfilePolicy): ProfilePolicy {
  return {
    ...policy,
    labels: [...policy.labels],
    blockedLabels: [...policy.blockedLabels],
    whitelist: [...policy.whitelist],
    blocklist: [...policy.blocklist],
    titleRules: [...policy.titleRules],
    channelBlocklist: [...policy.channelBlocklist],
    channelAllowlist: [...policy.channelAllowlist],
    deletedBuiltinLabels: [...policy.deletedBuiltinLabels],
  };
}

/** Defensive read: unknown fields, wrong types and corruption fall back to the
 *  caller's baseline (Default/previous profile), never throw. */
export function sanitizeProfilePolicy(
  raw: unknown,
  fallback: ProfilePolicy = defaultProfilePolicy(),
): ProfilePolicy {
  const source = isRecord(raw) ? raw : {};
  const labels = migrateLabels(
    {
      labels: Array.isArray(source.labels) ? (source.labels as string[]) : fallback.labels,
      blockedLabels: Array.isArray(source.blockedLabels)
        ? (source.blockedLabels as string[])
        : fallback.blockedLabels,
      deletedBuiltinLabels: Array.isArray(source.deletedBuiltinLabels)
        ? (source.deletedBuiltinLabels as string[])
        : fallback.deletedBuiltinLabels,
    },
    fallback,
  );
  const { whitelist, whitelistVersion } = migrateWhitelist(
    {
      whitelist: Array.isArray(source.whitelist)
        ? (source.whitelist as string[])
        : fallback.whitelist,
      whitelistVersion:
        typeof source.whitelistVersion === 'number'
          ? source.whitelistVersion
          : fallback.whitelistVersion,
    },
    fallback.whitelist,
  );
  const breakMode =
    typeof source.breakMode === 'string'
      ? normalizeBreakMode(source.breakMode)
      : fallback.breakMode;
  return {
    labels: labels.labels,
    blockedLabels: labels.blockedLabels,
    blockThreshold: clampNumber(
      source.blockThreshold,
      MIN_BLOCK_THRESHOLD,
      MAX_BLOCK_THRESHOLD,
      fallback.blockThreshold,
    ),
    whitelist,
    whitelistVersion,
    blocklist: sanitizeStringList(
      source.blocklist,
      fallback.blocklist,
      MAX_POLICY_LIST,
      normalizeListEntry,
    ),
    titleRules: sanitizeStringList(
      source.titleRules,
      fallback.titleRules,
      MAX_TITLE_RULES,
      normalizeListEntry,
    ),
    channelBlocklist: sanitizeStringList(
      source.channelBlocklist,
      fallback.channelBlocklist,
      MAX_CHANNEL_RULES,
      normalizeLabel,
    ),
    channelAllowlist: sanitizeStringList(
      source.channelAllowlist,
      fallback.channelAllowlist,
      MAX_CHANNEL_RULES,
      normalizeLabel,
    ),
    deletedBuiltinLabels: labels.deletedBuiltinLabels,
    focusGoal:
      typeof source.focusGoal === 'string'
        ? normalizeText(source.focusGoal, MAX_FOCUS_GOAL_LENGTH)
        : fallback.focusGoal,
    useTabContext: safeBoolean(source.useTabContext, fallback.useTabContext),
    blockAdult: safeBoolean(source.blockAdult, fallback.blockAdult),
    maskSearchElements: safeBoolean(source.maskSearchElements, fallback.maskSearchElements),
    surrenderMode:
      source.surrenderMode === 'phrase'
        ? 'phrase'
        : source.surrenderMode === 'off'
          ? 'off'
          : fallback.surrenderMode,
    blockMessage:
      source.blockMessage === undefined
        ? fallback.blockMessage
        : sanitizeBlockMessage(source.blockMessage),
    breakMode,
    breakDelayMinutes:
      source.breakDelayMinutes === undefined
        ? fallback.breakDelayMinutes
        : clampBreakDelayMinutes(source.breakDelayMinutes),
    breakDurationMinutes:
      source.breakDurationMinutes === undefined
        ? fallback.breakDurationMinutes
        : clampBreakDurationMinutes(source.breakDurationMinutes),
    breakTextLength:
      source.breakTextLength === undefined
        ? fallback.breakTextLength
        : clampBreakTextLength(source.breakTextLength),
  };
}

/** Extract the scoped policy from an effective Settings object. */
export function extractProfilePolicy(settings: Settings): ProfilePolicy {
  return {
    labels: [...settings.labels],
    blockedLabels: [...settings.blockedLabels],
    blockThreshold: settings.blockThreshold,
    whitelist: [...settings.whitelist],
    whitelistVersion: settings.whitelistVersion,
    blocklist: [...settings.blocklist],
    titleRules: [...settings.titleRules],
    channelBlocklist: [...settings.channelBlocklist],
    channelAllowlist: [...settings.channelAllowlist],
    deletedBuiltinLabels: [...settings.deletedBuiltinLabels],
    focusGoal: settings.focusGoal,
    useTabContext: settings.useTabContext,
    blockAdult: settings.blockAdult,
    maskSearchElements: settings.maskSearchElements,
    surrenderMode: settings.surrenderMode,
    blockMessage: settings.blockMessage,
    breakMode: settings.breakMode,
    breakDelayMinutes: settings.breakDelayMinutes,
    breakDurationMinutes: settings.breakDurationMinutes,
    breakTextLength: settings.breakTextLength,
  };
}

/** Compose effective settings: active scoped policy replaces Default scoped
 *  fields; every global field stays exactly as stored. */
export function applyProfilePolicy(settings: Settings, policy: ProfilePolicy): Settings {
  return { ...settings, ...cloneProfilePolicy(policy) };
}

export function profilePoliciesEqual(a: ProfilePolicy, b: ProfilePolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function profilePolicyKey(policy: ProfilePolicy): string {
  return JSON.stringify(policy);
}

export function profileNameKey(name: string): string {
  return normalizeProfileName(name).toLowerCase();
}

export function normalizeProfileName(raw: unknown): string {
  return typeof raw === 'string' ? normalizeText(raw, MAX_PROFILE_NAME_LENGTH) : '';
}

export function isValidProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function makeProfileId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `p_${uuid}`.slice(0, MAX_PROFILE_ID_LENGTH);
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tail = ` (${suffix++})`;
    candidate = `${name.slice(0, MAX_PROFILE_NAME_LENGTH - tail.length).trimEnd()}${tail}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function emptyState(): ProfilesState {
  return {
    version: PROFILES_SCHEMA_VERSION,
    activeProfileId: null,
    profiles: [],
    defaultAppBlocklist: [],
    defaultAppBlocklistUpdatedAt: 0,
  };
}

/**
 * Versioned migration + sanitization. Absent/corrupt data becomes the empty
 * state (Default active) so an existing user loses nothing: their settings
 * key is still the Default profile. A v0 array/`profiles` object is accepted
 * and upgraded in place; duplicate ids get fresh ids, duplicate names get a
 * suffix, and duplicate/runtime fields are dropped.
 */
export function sanitizeProfilesState(raw: unknown, now = Date.now()): ProfilesState {
  if (!isRecord(raw) && !Array.isArray(raw)) return emptyState();
  const source = isRecord(raw) ? raw : {};
  const rawProfiles = Array.isArray(source.profiles)
    ? source.profiles
    : isRecord(source.profiles)
      ? Object.values(source.profiles)
      : Array.isArray(raw)
        ? raw
        : [];
  const basePolicy = defaultProfilePolicy();
  const profiles: Profile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of rawProfiles) {
    if (!isRecord(entry)) continue;
    if (profiles.length >= MAX_NAMED_PROFILES) break;
    let id = isValidProfileId(entry.id) ? entry.id : makeProfileId();
    while (ids.has(id)) id = makeProfileId();
    ids.add(id);
    let name = normalizeProfileName(entry.name);
    if (!name) name = `Profile ${profiles.length + 1}`;
    if (name.toLowerCase() === 'default') name = 'Default profile';
    name = uniqueName(name, names);
    const policySource = isRecord(entry.policy)
      ? entry.policy
      : isRecord(entry.policySnapshot)
        ? entry.policySnapshot
        : entry;
    const createdAt = safeTimestamp(entry.createdAt, now);
    const updatedAt = safeTimestamp(entry.updatedAt, createdAt);
    profiles.push({
      id,
      name,
      createdAt,
      updatedAt,
      policy: sanitizeProfilePolicy(policySource, basePolicy),
      appBlocklist: normalizeAppBlocklist(entry.appBlocklist ?? entry.apps),
      appBlocklistUpdatedAt: normalizeAppBlocklistTimestamp(entry.appBlocklistUpdatedAt),
    });
  }
  const activeRaw = source.activeProfileId;
  const activeProfileId =
    typeof activeRaw === 'string' && profiles.some((profile) => profile.id === activeRaw)
      ? activeRaw
      : null;
  return {
    version: PROFILES_SCHEMA_VERSION,
    activeProfileId,
    profiles,
    defaultAppBlocklist: normalizeAppBlocklist(source.defaultAppBlocklist),
    defaultAppBlocklistUpdatedAt: normalizeAppBlocklistTimestamp(
      source.defaultAppBlocklistUpdatedAt,
    ),
  };
}

export function activeProfile(state: ProfilesState): Profile | null {
  if (state.activeProfileId === null) return null;
  return state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
}

export function activeAppAssociation(state: ProfilesState): AppAssociation {
  const profile = activeProfile(state);
  if (profile) {
    return {
      apps: [...profile.appBlocklist],
      updatedAt: profile.appBlocklistUpdatedAt,
      profileId: profile.id,
    };
  }
  return {
    apps: [...state.defaultAppBlocklist],
    updatedAt: state.defaultAppBlocklistUpdatedAt,
    profileId: null,
  };
}

/** Adopt the companion's app list into the ACTIVE profile/default. This is
 *  the only external-write path for the association; it never touches
 *  settings or Default policy while a named profile is active. */
export function adoptActiveAppBlocklist(
  state: ProfilesState,
  apps: readonly string[],
  updatedAt: number,
): ProfilesState {
  const normalized = normalizeAppBlocklist(apps);
  const stamp = normalizeAppBlocklistTimestamp(updatedAt);
  const association = activeAppAssociation(state);
  if (appBlocklistEqual(association.apps, normalized) && association.updatedAt === stamp) {
    return state;
  }
  if (association.profileId !== null) {
    return {
      ...state,
      profiles: state.profiles.map((profile) =>
        profile.id === association.profileId
          ? { ...profile, appBlocklist: normalized, appBlocklistUpdatedAt: stamp }
          : profile,
      ),
    };
  }
  return { ...state, defaultAppBlocklist: normalized, defaultAppBlocklistUpdatedAt: stamp };
}

/** Explicit local edit/apply of the active association (used by the bridge
 *  before a push and by a future in-options app editor). */
export function markActiveAppBlocklist(
  state: ProfilesState,
  apps: readonly string[],
  now: number,
): ProfilesState {
  return adoptActiveAppBlocklist(state, apps, normalizeAppBlocklistTimestamp(now));
}

/** How the active app association should converge with the companion's
 *  current list. Equal lists are already converged, whatever the stamps say.
 *  A differing list is the daemon's when its stamp is newer; on a tie the
 *  daemon wins too, except two never-synchronized stamps (0) where a non-empty
 *  local list is the user's first intent and must not be wiped. */
export type AppBlocklistReconciliation =
  | { action: 'none' }
  | { action: 'push'; apps: string[]; updatedAt: number }
  | { action: 'adopt'; apps: string[]; updatedAt: number };

export function reconcileAppBlocklist(
  local: AppAssociation,
  daemonApps: readonly string[],
  daemonUpdatedAt: number,
): AppBlocklistReconciliation {
  const localApps = normalizeAppBlocklist(local.apps);
  const apps = normalizeAppBlocklist(daemonApps);
  if (appBlocklistEqual(localApps, apps)) return { action: 'none' };
  const daemonAt = normalizeAppBlocklistTimestamp(daemonUpdatedAt);
  const daemonWins =
    daemonAt > local.updatedAt ||
    (daemonAt === local.updatedAt && (daemonAt > 0 || localApps.length === 0));
  return daemonWins
    ? { action: 'adopt', apps, updatedAt: daemonAt }
    : { action: 'push', apps: localApps, updatedAt: local.updatedAt };
}

export function setProfilePolicy(
  state: ProfilesState,
  id: string,
  policy: ProfilePolicy,
  now: number,
): ProfilesState {
  return {
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.id === id
        ? { ...profile, policy: sanitizeProfilePolicy(policy, profile.policy), updatedAt: now }
        : profile,
    ),
  };
}

function lockedFailure(state: ProfilesState): ProfileOpFailure {
  return {
    ok: false,
    code: 'locked',
    error: 'Profiles are locked. Wait for the current lock to end, then try again.',
    state,
  };
}

function invalidName(state: ProfilesState, error: string): ProfileOpFailure {
  return { ok: false, code: 'invalid-name', error, state };
}

function validateName(
  state: ProfilesState,
  rawName: unknown,
  excludeId?: string,
): { ok: true; name: string } | ProfileOpFailure {
  const name = normalizeProfileName(rawName);
  if (!name) return invalidName(state, 'Enter a profile name.');
  if (name.toLowerCase() === 'default') {
    return {
      ok: false,
      code: 'reserved-name',
      error: '"Default" is the fallback profile. Pick another name.',
      state,
    };
  }
  if (
    state.profiles.some(
      (profile) => profile.id !== excludeId && profileNameKey(profile.name) === name.toLowerCase(),
    )
  ) {
    return {
      ok: false,
      code: 'duplicate-name',
      error: `A profile named "${name}" already exists.`,
      state,
    };
  }
  return { ok: true, name };
}

export interface CreateProfileInput extends ProfileMutationOptions {
  name: string;
  policy: ProfilePolicy;
  appBlocklist?: readonly string[];
  appBlocklistUpdatedAt?: number;
}

/** Create a profile from the caller's current effective policy. It does NOT
 *  activate itself: activation is always an explicit second action. */
export function createProfile(
  state: ProfilesState,
  input: CreateProfileInput,
): ProfileOpResult {
  if (input.locked) return lockedFailure(state);
  if (state.profiles.length >= MAX_NAMED_PROFILES) {
    return {
      ok: false,
      code: 'limit',
      error: `You can keep up to ${MAX_NAMED_PROFILES} named profiles. Delete one first.`,
      state,
    };
  }
  const validated = validateName(state, input.name);
  if (!('name' in validated)) return validated;
  const id = input.id ?? makeProfileId();
  if (!isValidProfileId(id)) {
    return { ok: false, code: 'duplicate-id', error: 'Invalid profile id.', state };
  }
  if (state.profiles.some((profile) => profile.id === id)) {
    return {
      ok: false,
      code: 'duplicate-id',
      error: 'A profile with that id already exists.',
      state,
    };
  }
  const now = safeTimestamp(input.now, Date.now());
  const profile: Profile = {
    id,
    name: validated.name,
    createdAt: now,
    updatedAt: now,
    policy: sanitizeProfilePolicy(input.policy, defaultProfilePolicy()),
    appBlocklist: normalizeAppBlocklist(input.appBlocklist ?? []),
    appBlocklistUpdatedAt: normalizeAppBlocklistTimestamp(input.appBlocklistUpdatedAt),
  };
  return { ok: true, state: { ...state, profiles: [...state.profiles, profile] }, profile };
}

export function duplicateProfile(
  state: ProfilesState,
  id: string,
  options: ProfileMutationOptions,
): ProfileOpResult {
  if (options.locked) return lockedFailure(state);
  const source = state.profiles.find((profile) => profile.id === id);
  if (!source) return { ok: false, code: 'not-found', error: 'Profile not found.', state };
  if (state.profiles.length >= MAX_NAMED_PROFILES) {
    return {
      ok: false,
      code: 'limit',
      error: `You can keep up to ${MAX_NAMED_PROFILES} named profiles. Delete one first.`,
      state,
    };
  }
  const used = new Set(state.profiles.map((profile) => profileNameKey(profile.name)));
  let name = `${source.name} copy`.slice(0, MAX_PROFILE_NAME_LENGTH).trimEnd();
  name = uniqueName(name, used);
  const now = safeTimestamp(options.now, Date.now());
  const profile: Profile = {
    ...source,
    id: options.id ?? makeProfileId(),
    name,
    createdAt: now,
    updatedAt: now,
    policy: cloneProfilePolicy(source.policy),
    appBlocklist: [...source.appBlocklist],
  };
  if (state.profiles.some((entry) => entry.id === profile.id)) {
    return {
      ok: false,
      code: 'duplicate-id',
      error: 'A profile with that id already exists.',
      state,
    };
  }
  return { ok: true, state: { ...state, profiles: [...state.profiles, profile] }, profile };
}

export function renameProfile(
  state: ProfilesState,
  id: string,
  rawName: string,
  options: Pick<ProfileMutationOptions, 'now' | 'locked'>,
): ProfileOpResult {
  if (options.locked) return lockedFailure(state);
  const profile = state.profiles.find((entry) => entry.id === id);
  if (!profile) return { ok: false, code: 'not-found', error: 'Profile not found.', state };
  const validated = validateName(state, rawName, id);
  if (!('name' in validated)) return validated;
  const next = {
    ...profile,
    name: validated.name,
    updatedAt: safeTimestamp(options.now, Date.now()),
  };
  return {
    ok: true,
    state: {
      ...state,
      profiles: state.profiles.map((entry) => (entry.id === id ? next : entry)),
    },
    profile: next,
  };
}

/** Deleting the active profile falls back to Default. Refused while locked,
 *  because that switch could otherwise land mid-lock. */
export function deleteProfile(
  state: ProfilesState,
  id: string,
  options: Pick<ProfileMutationOptions, 'locked'>,
): ProfileOpResult {
  if (options.locked) return lockedFailure(state);
  if (!state.profiles.some((profile) => profile.id === id)) {
    return { ok: false, code: 'not-found', error: 'Profile not found.', state };
  }
  return {
    ok: true,
    state: {
      ...state,
      activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
      profiles: state.profiles.filter((profile) => profile.id !== id),
    },
  };
}

/**
 * Manual activation. `null` activates Default. Refused while locked: a switch
 * is an arbitrary policy replacement, so allowing it during a lock could
 * silently weaken the active protection.
 *
 * An association that has synchronized before (timestamp > 0) is stamped with
 * the activation time so switching profiles explicitly applies its app list.
 * A never-synchronized association keeps timestamp 0, letting an existing
 * desktop list populate it on first connect instead of wiping it with [].
 */
export function activateProfile(
  state: ProfilesState,
  id: string | null,
  options: Pick<ProfileMutationOptions, 'now' | 'locked'>,
): ProfileOpResult {
  if (options.locked) return lockedFailure(state);
  if (id !== null && !state.profiles.some((profile) => profile.id === id)) {
    return { ok: false, code: 'not-found', error: 'Profile not found.', state };
  }
  if (state.activeProfileId === id) {
    return { ok: true, state };
  }
  const now = safeTimestamp(options.now, Date.now());
  let next: ProfilesState = { ...state, activeProfileId: id };
  const association = activeAppAssociation(next);
  if (association.updatedAt > 0) {
    next = adoptActiveAppBlocklist(next, association.apps, now);
  }
  return { ok: true, state: next };
}

export function profilesStateEqual(a: ProfilesState, b: ProfilesState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
