// Versioned local configuration backup/restore — PURE core (no browser APIs).
//
// SCOPE: a backup is a user's *configuration*, not a snapshot of runtime
// state. It carries:
//   - the Default profile's policy plus the global settings that shape it
//     (`enabled`, feedback/oEmbed consent, auto-resume, reminders, display),
//   - every named profile, including its desktop-app association,
//   - the configured focus-hours rules and category windows.
//
// EXCLUDED ON PURPOSE (documented in docs/backup.md):
//   - active timers, password hashes/KDF material, delay/random-text gate
//     state, Frozen Turkey sessions, break state, partner keys/arms
//   - lock state's non-schedule fields and any schedule evaluation output
//   - usage statistics, feedback/corrections, centroids, title caches,
//     tab-status/session storage, onboarding transients, companion pairing,
//     secrets of any kind.
//
// Schedule ownership: schedules live in `lockState`, not `settings`. The
// backup exports only the authored rules plus the two merge stamps
// (`schedulesUpdatedAt`, `categorySchedulesUpdatedAt`) — never the active
// lock fields. Restore writes the lists back into an otherwise untouched
// `lockState`; because restore refuses while `settingsLocked`, it cannot
// delete a window that is currently enforcing.
//
// Node-testability: erasable syntax only, and every local runtime import
// carries an explicit `.ts` extension (see scripts/backup-test.mjs).
import { MAX_APP_BLOCKLIST, normalizeAppBlocklist } from './apps.ts';
import {
  BREAK_DELAY_MINUTES_DEFAULT,
  BREAK_DURATION_MINUTES_DEFAULT,
  BREAK_TEXT_LENGTH_DEFAULT,
  clampBreakDelayMinutes,
  clampBreakDurationMinutes,
  clampBreakTextLength,
  normalizeBreakMode,
} from './breaks.ts';
import {
  normalizeFirstDayOfWeek,
  normalizeHour24,
  sanitizeBlockMessage,
} from './display-prefs.ts';
import {
  validateCategoryScheduleRule,
  validateScheduleRule,
  type CategoryScheduleRule,
  type LockState,
  type ScheduleRule,
} from './lock-math.ts';
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizeNotificationPrefs,
  type NotificationPrefs,
} from './notifications.ts';
import {
  MAX_CHANNEL_RULES,
  MAX_FOCUS_GOAL_LENGTH,
  MAX_NAMED_PROFILES,
  MAX_POLICY_LABELS,
  MAX_POLICY_LIST,
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_TITLE_RULES,
  cloneProfilePolicy,
  defaultProfilePolicy,
  extractProfilePolicy,
  isValidProfileId,
  makeProfileId,
  normalizeProfileName,
  profileNameKey,
  sanitizeProfilePolicy,
  sanitizeProfilesState,
  type Profile,
  type ProfilePolicy,
  type ProfilePolicyKey,
  type ProfilesState,
} from './profiles.ts';
import { clampResumeAt, normalizeResumeMode, type ResumeMode } from './resume.ts';
import type { Settings } from './settings.ts';

export const BACKUP_SCHEMA_ID = 'smartblocker.config';
export const BACKUP_SCHEMA_VERSION = 1;
/** Bounded so a devtools-edited import cannot exhaust memory/storage. */
export const BACKUP_MAX_BYTES = 16 * 1024 * 1024;
export const BACKUP_MAX_PROFILES = MAX_NAMED_PROFILES;
export const BACKUP_MAX_SCHEDULES = 100;
export const BACKUP_MAX_CATEGORY_SCHEDULES = 100;
export const BACKUP_MAX_NAME_LENGTH = MAX_PROFILE_NAME_LENGTH;

export type BackupMode = 'merge' | 'replace';

/** Global fields a backup carries. `onboarded` is transient wizard state. */
export const BACKUP_GLOBAL_FIELDS = [
  'enabled',
  'shareFeedback',
  'resolveEmbedTitles',
  'resumeMode',
  'resumeAt',
  'notificationPrefs',
  'firstDayOfWeek',
  'hour24',
] as const satisfies readonly (keyof Settings)[];

export type BackupGlobalField = (typeof BACKUP_GLOBAL_FIELDS)[number];
export type BackupManagedSettings = ProfilePolicy &
  Pick<Settings, BackupGlobalField>;

export interface BackupProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  policy: ProfilePolicy;
  appBlocklist: string[];
  appBlocklistUpdatedAt: number;
}

export interface BackupScheduleList {
  updatedAt: number;
  rules: ScheduleRule[];
}

export interface BackupCategoryScheduleList {
  updatedAt: number;
  rules: CategoryScheduleRule[];
}

export interface BackupDocument {
  schema: typeof BACKUP_SCHEMA_ID;
  version: number;
  exportedAt: string;
  app: {
    name: string;
    version: string;
  };
  default: {
    settings: BackupManagedSettings;
    appBlocklist: string[];
    appBlocklistUpdatedAt: number;
  };
  profiles: BackupProfile[];
  activeProfileId: string | null;
  schedules: BackupScheduleList;
  categorySchedules: BackupCategoryScheduleList;
}

export interface BackupIssue {
  path: string;
  message: string;
}

export type BackupParseResult =
  | { ok: true; document: BackupDocument; warnings: string[] }
  | { ok: false; errors: BackupIssue[] };

export interface BackupSource {
  /** The stored Default profile (NOT `getSettings()` while a named profile
   *  is active). */
  settings: Settings;
  profiles: ProfilesState;
  lockState: Pick<
    LockState,
    'schedules' | 'schedulesUpdatedAt' | 'categorySchedules' | 'categorySchedulesUpdatedAt'
  >;
  exportedAt?: string;
  appVersion?: string;
  now?: number;
}

export interface BackupCurrentState {
  settings: Settings;
  profiles: ProfilesState;
  schedules: ScheduleRule[];
  schedulesUpdatedAt: number;
  categorySchedules: CategoryScheduleRule[];
  categorySchedulesUpdatedAt: number;
  categorySchedulesPresent: boolean;
}

export interface BackupApplyOptions {
  now: number;
  /** Offset of the device at restore time, used only for legacy rules that
   *  were authored before timezone pins existed. */
  tzOffsetMinutes: number;
  tzName: string;
}

export interface BackupAppliedState {
  settings: Settings;
  profiles: ProfilesState;
  schedules: ScheduleRule[];
  schedulesUpdatedAt: number;
  categorySchedules: CategoryScheduleRule[];
  categorySchedulesUpdatedAt: number;
  categorySchedulesPresent: boolean;
  warnings: string[];
}

export type BackupChangeKind = 'default' | 'profile' | 'schedule' | 'category-schedule';

export interface BackupChange {
  kind: BackupChangeKind;
  action: 'add' | 'update' | 'remove';
  name: string;
  details: string[];
}

export interface BackupPreviewCounts {
  profilesAdded: number;
  profilesUpdated: number;
  profilesRemoved: number;
  profilesKept: number;
  schedulesAdded: number;
  schedulesUpdated: number;
  schedulesRemoved: number;
  categorySchedulesAdded: number;
  categorySchedulesUpdated: number;
  categorySchedulesRemoved: number;
}

export interface BackupPreview {
  mode: BackupMode;
  document: BackupDocument;
  changes: BackupChange[];
  counts: BackupPreviewCounts;
  warnings: string[];
  summary: string;
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

function normalizeListEntry(value: string): string {
  return normalizeText(value, 300);
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

function safeString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? normalizeText(value, maxLength) : fallback;
}

function sanitizeResumeAt(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value)
    : null;
}

export function defaultManagedSettings(): BackupManagedSettings {
  return {
    ...defaultProfilePolicy(),
    enabled: true,
    shareFeedback: false,
    resolveEmbedTitles: false,
    resumeMode: 'off',
    resumeAt: null,
    notificationPrefs: normalizeNotificationPrefs(DEFAULT_NOTIFICATION_PREFS),
    firstDayOfWeek: 0,
    hour24: false,
  };
}

export function sanitizeManagedSettings(
  raw: unknown,
  fallback: BackupManagedSettings = defaultManagedSettings(),
): BackupManagedSettings {
  const source = isRecord(raw) ? raw : {};
  const policy = sanitizeProfilePolicy(raw, fallback);
  return {
    ...policy,
    enabled: safeBoolean(source.enabled, fallback.enabled),
    shareFeedback: safeBoolean(source.shareFeedback, fallback.shareFeedback),
    resolveEmbedTitles: safeBoolean(source.resolveEmbedTitles, fallback.resolveEmbedTitles),
    resumeMode:
      source.resumeMode === undefined
        ? fallback.resumeMode
        : normalizeResumeMode(source.resumeMode),
    resumeAt: source.resumeAt === undefined ? fallback.resumeAt : sanitizeResumeAt(source.resumeAt),
    notificationPrefs:
      source.notificationPrefs === undefined
        ? normalizeNotificationPrefs(fallback.notificationPrefs)
        : normalizeNotificationPrefs(source.notificationPrefs),
    firstDayOfWeek:
      source.firstDayOfWeek === undefined
        ? fallback.firstDayOfWeek
        : normalizeFirstDayOfWeek(source.firstDayOfWeek),
    hour24:
      source.hour24 === undefined ? fallback.hour24 : normalizeHour24(source.hour24),
  };
}

/** Reconstruct a managed-settings object in a fixed key order so serialized
 *  bytes are deterministic. */
function canonicalManagedSettings(settings: BackupManagedSettings): BackupManagedSettings {
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
    enabled: settings.enabled,
    shareFeedback: settings.shareFeedback,
    resolveEmbedTitles: settings.resolveEmbedTitles,
    resumeMode: settings.resumeMode,
    resumeAt: settings.resumeAt,
    notificationPrefs: normalizeNotificationPrefs(settings.notificationPrefs),
    firstDayOfWeek: settings.firstDayOfWeek,
    hour24: settings.hour24,
  };
}

function canonicalRule(rule: ScheduleRule): ScheduleRule {
  const out: ScheduleRule = {
    id: rule.id,
    days: [...rule.days],
    startMinutes: rule.startMinutes,
    endMinutes: rule.endMinutes,
  };
  if (typeof rule.leadMinutes === 'number' && rule.leadMinutes > 0) {
    out.leadMinutes = rule.leadMinutes;
  }
  if (typeof rule.tzOffsetMinutes === 'number') out.tzOffsetMinutes = rule.tzOffsetMinutes;
  if (typeof rule.tzName === 'string' && rule.tzName) out.tzName = rule.tzName;
  return out;
}

function canonicalCategoryRule(rule: CategoryScheduleRule): CategoryScheduleRule {
  return { ...canonicalRule(rule), categories: [...rule.categories] };
}

function canonicalProfile(profile: BackupProfile): BackupProfile {
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    policy: cloneProfilePolicy(profile.policy),
    appBlocklist: [...profile.appBlocklist],
    appBlocklistUpdatedAt: profile.appBlocklistUpdatedAt,
  };
}

function canonicalDocument(document: BackupDocument): BackupDocument {
  return {
    schema: BACKUP_SCHEMA_ID,
    version: document.version,
    exportedAt: document.exportedAt,
    app: {
      name: document.app.name,
      version: document.app.version,
    },
    default: {
      settings: canonicalManagedSettings(document.default.settings),
      appBlocklist: [...document.default.appBlocklist],
      appBlocklistUpdatedAt: document.default.appBlocklistUpdatedAt,
    },
    profiles: document.profiles.map(canonicalProfile),
    activeProfileId: document.activeProfileId,
    schedules: {
      updatedAt: document.schedules.updatedAt,
      rules: document.schedules.rules.map(canonicalRule),
    },
    categorySchedules: {
      updatedAt: document.categorySchedules.updatedAt,
      rules: document.categorySchedules.rules.map(canonicalCategoryRule),
    },
  };
}

/** One backup file, with fixed key order and a trailing newline. Same input
 *  config + exportedAt => byte-identical output. */
export function serializeBackup(document: BackupDocument): string {
  return `${JSON.stringify(canonicalDocument(document), null, 2)}\n`;
}

function sanitizeRule(raw: unknown, warnings: string[], label: string): ScheduleRule | null {
  if (!isRecord(raw)) {
    warnings.push(`Dropped a malformed ${label} rule.`);
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > MAX_PROFILE_ID_LENGTH) {
    warnings.push(`Dropped a ${label} rule with an invalid id.`);
    return null;
  }
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const startMinutes = raw.startMinutes;
  const endMinutes = raw.endMinutes;
  if (
    days.length === 0 ||
    typeof startMinutes !== 'number' ||
    typeof endMinutes !== 'number'
  ) {
    warnings.push(`Dropped ${label} rule “${id}”: missing days or times.`);
    return null;
  }
  const rule: ScheduleRule = {
    id,
    days: days.sort((a, b) => a - b),
    startMinutes,
    endMinutes,
  };
  if (raw.leadMinutes !== undefined && raw.leadMinutes !== null) {
    if (typeof raw.leadMinutes === 'number' && Number.isInteger(raw.leadMinutes)) {
      if (raw.leadMinutes > 0) rule.leadMinutes = raw.leadMinutes;
    } else {
      warnings.push(`Ignored an invalid lead time on ${label} rule “${id}”.`);
    }
  }
  if (raw.tzOffsetMinutes !== undefined && raw.tzOffsetMinutes !== null) {
    if (
      typeof raw.tzOffsetMinutes === 'number' &&
      Number.isInteger(raw.tzOffsetMinutes) &&
      raw.tzOffsetMinutes >= -720 &&
      raw.tzOffsetMinutes <= 840
    ) {
      rule.tzOffsetMinutes = raw.tzOffsetMinutes;
    } else {
      warnings.push(`Ignored an invalid timezone offset on ${label} rule “${id}”.`);
    }
  }
  if (raw.tzName !== undefined && raw.tzName !== null) {
    if (typeof raw.tzName === 'string' && raw.tzName.length <= 64) {
      rule.tzName = raw.tzName;
    } else {
      warnings.push(`Ignored an invalid timezone name on ${label} rule “${id}”.`);
    }
  }
  const problem = validateScheduleRule(rule);
  if (problem) {
    warnings.push(`Dropped ${label} rule “${id}”: ${problem}`);
    return null;
  }
  return rule;
}

function sanitizeRules(
  raw: unknown,
  warnings: string[],
  label: string,
  maxRules: number,
  seenIds: Set<string>,
): ScheduleRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`Ignored a malformed ${label} list.`);
    return [];
  }
  const rules: ScheduleRule[] = [];
  for (const entry of raw) {
    if (rules.length >= maxRules) {
      warnings.push(`Only the first ${maxRules} ${label} rules were imported.`);
      break;
    }
    const rule = sanitizeRule(entry, warnings, label);
    if (!rule) continue;
    if (seenIds.has(rule.id)) {
      warnings.push(`Dropped a duplicate ${label} rule id “${rule.id}”.`);
      continue;
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function sanitizeCategoryRules(
  raw: unknown,
  warnings: string[],
): CategoryScheduleRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('Ignored a malformed category-schedule list.');
    return [];
  }
  const rules: CategoryScheduleRule[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (rules.length >= BACKUP_MAX_CATEGORY_SCHEDULES) {
      warnings.push(
        `Only the first ${BACKUP_MAX_CATEGORY_SCHEDULES} category-schedule rules were imported.`,
      );
      break;
    }
    const base = sanitizeRule(entry, warnings, 'category-schedule');
    if (!base) continue;
    if (seenIds.has(base.id)) {
      warnings.push(`Dropped a duplicate category-schedule rule id “${base.id}”.`);
      continue;
    }
    const source = isRecord(entry) ? entry : {};
    const categories = Array.isArray(source.categories)
      ? [...new Set(
          source.categories
            .filter((item): item is string => typeof item === 'string')
            .map((item) => normalizeText(item, 64))
            .filter((item) => item.length > 0),
        )]
      : [];
    const rule: CategoryScheduleRule = { ...base, categories };
    const problem = validateCategoryScheduleRule(rule);
    if (problem) {
      warnings.push(`Dropped category-schedule rule “${base.id}”: ${problem}`);
      continue;
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

/** Defensive read of a decoded backup object. Never throws; returns a repaired
 *  document plus human-readable warnings. */
export function sanitizeBackup(
  raw: unknown,
  now = Date.now(),
): { document: BackupDocument; warnings: string[] } {
  const warnings: string[] = [];
  const source = isRecord(raw) ? raw : {};
  const rawDefault = isRecord(source.default) ? source.default : {};
  const rawApp = isRecord(source.app) ? source.app : {};
  const rawSchedules = isRecord(source.schedules) ? source.schedules : {};
  const rawCategorySchedules = isRecord(source.categorySchedules)
    ? source.categorySchedules
    : {};

  const settings = sanitizeManagedSettings(rawDefault.settings);
  const rawProfiles = Array.isArray(source.profiles) ? source.profiles : [];
  if (rawProfiles.length > BACKUP_MAX_PROFILES) {
    warnings.push(
      `Only the first ${BACKUP_MAX_PROFILES} named profiles were imported; ` +
        `${rawProfiles.length - BACKUP_MAX_PROFILES} were dropped.`,
    );
  }
  const profilesState = sanitizeProfilesState(
    {
      version: 1,
      activeProfileId: source.activeProfileId,
      profiles: rawProfiles,
      defaultAppBlocklist: rawDefault.appBlocklist,
      defaultAppBlocklistUpdatedAt: rawDefault.appBlocklistUpdatedAt,
    },
    now,
  );
  const schedules = sanitizeRules(
    rawSchedules.rules,
    warnings,
    'focus-hours',
    BACKUP_MAX_SCHEDULES,
    new Set(),
  );
  const categorySchedules = sanitizeCategoryRules(rawCategorySchedules.rules, warnings);

  const exportedAt =
    typeof source.exportedAt === 'string' && source.exportedAt.length <= 64
      ? source.exportedAt
      : new Date(now).toISOString();

  return {
    document: {
      schema: BACKUP_SCHEMA_ID,
      version: BACKUP_SCHEMA_VERSION,
      exportedAt,
      app: {
        name: safeString(rawApp.name, 'SmartBlocker', 64) || 'SmartBlocker',
        version: safeString(rawApp.version, '', 64),
      },
      default: {
        settings,
        appBlocklist: normalizeAppBlocklist(rawDefault.appBlocklist),
        appBlocklistUpdatedAt: safeTimestamp(rawDefault.appBlocklistUpdatedAt, 0),
      },
      profiles: profilesState.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        policy: cloneProfilePolicy(profile.policy),
        appBlocklist: [...profile.appBlocklist],
        appBlocklistUpdatedAt: profile.appBlocklistUpdatedAt,
      })),
      activeProfileId: profilesState.activeProfileId,
      schedules: {
        updatedAt: safeTimestamp(rawSchedules.updatedAt, 0),
        rules: schedules,
      },
      categorySchedules: {
        updatedAt: safeTimestamp(rawCategorySchedules.updatedAt, 0),
        rules: categorySchedules,
      },
    },
    warnings,
  };
}

/** Build the document for the current config. `settings` must be the stored
 *  Default profile, not the effective overlay of a named profile. */
export function buildBackup(input: BackupSource): BackupDocument {
  const now = input.now ?? Date.now();
  const state = sanitizeProfilesState(input.profiles, now);
  const managed = sanitizeManagedSettings(input.settings, defaultManagedSettings());
  const schedules = sanitizeRules(
    input.lockState.schedules,
    [],
    'focus-hours',
    BACKUP_MAX_SCHEDULES,
    new Set(),
  );
  const categorySchedules = sanitizeCategoryRules(input.lockState.categorySchedules, []);
  return {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date(now).toISOString(),
    app: {
      name: 'SmartBlocker',
      version: typeof input.appVersion === 'string' ? input.appVersion.slice(0, 64) : '',
    },
    default: {
      settings: managed,
      appBlocklist: normalizeAppBlocklist(state.defaultAppBlocklist),
      appBlocklistUpdatedAt: safeTimestamp(state.defaultAppBlocklistUpdatedAt, 0),
    },
    profiles: state.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      policy: cloneProfilePolicy(profile.policy),
      appBlocklist: [...profile.appBlocklist],
      appBlocklistUpdatedAt: profile.appBlocklistUpdatedAt,
    })),
    activeProfileId: state.activeProfileId,
    schedules: {
      updatedAt: safeTimestamp(input.lockState.schedulesUpdatedAt, 0),
      rules: schedules,
    },
    categorySchedules: {
      updatedAt: safeTimestamp(input.lockState.categorySchedulesUpdatedAt, 0),
      rules: categorySchedules,
    },
  };
}

/** Parse + schema-check + sanitize one candidate file. */
export function parseBackup(text: string, now = Date.now()): BackupParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      ok: false,
      errors: [{ path: 'file', message: 'Choose a backup file to import.' }],
    };
  }
  if (text.length > BACKUP_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        {
          path: 'file',
          message: `This file is larger than the ${Math.round(BACKUP_MAX_BYTES / (1024 * 1024))} MB limit.`,
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: 'json',
          message: `This is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [{ path: 'file', message: 'The backup file must contain a JSON object.' }],
    };
  }
  if (raw.schema !== BACKUP_SCHEMA_ID) {
    return {
      ok: false,
      errors: [
        {
          path: 'schema',
          message: 'This is not a SmartBlocker configuration backup.',
        },
      ],
    };
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      errors: [{ path: 'version', message: 'The backup version is missing or invalid.' }],
    };
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          path: 'version',
          message:
            `This backup was made by a newer SmartBlocker version (schema v${version}). ` +
            `This build understands v${BACKUP_SCHEMA_VERSION}.`,
        },
      ],
    };
  }
  const errors: BackupIssue[] = [];
  if (!isRecord(raw.default)) {
    errors.push({ path: 'default', message: 'The Default profile section is missing.' });
  } else if (!isRecord(raw.default.settings)) {
    errors.push({ path: 'default.settings', message: 'The Default settings section is missing.' });
  }
  if (!Array.isArray(raw.profiles)) {
    errors.push({ path: 'profiles', message: 'The named-profiles list is missing.' });
  }
  if (!isRecord(raw.schedules) || !Array.isArray(raw.schedules.rules)) {
    errors.push({ path: 'schedules', message: 'The focus-hours section is missing.' });
  }
  if (
    raw.categorySchedules !== undefined &&
    (!isRecord(raw.categorySchedules) || !Array.isArray(raw.categorySchedules.rules))
  ) {
    errors.push({
      path: 'categorySchedules',
      message: 'The category-schedule section is malformed.',
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const sanitized = sanitizeBackup(raw, now);
  return { ok: true, document: sanitized.document, warnings: sanitized.warnings };
}

function unionList(
  imported: readonly string[],
  local: readonly string[],
  maxItems: number,
  normalize: (value: string) => string,
  minLength = 1,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [imported, local]) {
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const value = normalize(item);
      if (value.length < minLength) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

/** Merge policy lists by union with IMPORTED-FIRST precedence; scalars come
 *  from the imported document. Documented in docs/backup.md. */
export function mergePolicies(local: ProfilePolicy, incoming: ProfilePolicy): ProfilePolicy {
  const deletedBuiltinLabels = unionList(
    incoming.deletedBuiltinLabels,
    local.deletedBuiltinLabels,
    MAX_POLICY_LABELS,
    normalizeLabel,
  );
  const deleted = new Set(deletedBuiltinLabels);
  const labels = unionList(
    incoming.labels,
    local.labels,
    MAX_POLICY_LABELS,
    normalizeLabel,
  ).filter((label) => !deleted.has(label));
  const blockedLabels = unionList(
    incoming.blockedLabels,
    local.blockedLabels,
    MAX_POLICY_LABELS,
    normalizeLabel,
  ).filter((label) => labels.includes(label));
  const candidate: ProfilePolicy = {
    labels,
    blockedLabels,
    blockThreshold: incoming.blockThreshold,
    whitelist: unionList(
      incoming.whitelist,
      local.whitelist,
      MAX_POLICY_LIST,
      normalizeListEntry,
    ),
    whitelistVersion: Math.max(local.whitelistVersion, incoming.whitelistVersion),
    blocklist: unionList(
      incoming.blocklist,
      local.blocklist,
      MAX_POLICY_LIST,
      normalizeListEntry,
    ),
    titleRules: unionList(
      incoming.titleRules,
      local.titleRules,
      MAX_TITLE_RULES,
      normalizeListEntry,
    ),
    channelBlocklist: unionList(
      incoming.channelBlocklist,
      local.channelBlocklist,
      MAX_CHANNEL_RULES,
      normalizeLabel,
    ),
    channelAllowlist: unionList(
      incoming.channelAllowlist,
      local.channelAllowlist,
      MAX_CHANNEL_RULES,
      normalizeLabel,
    ),
    deletedBuiltinLabels,
    focusGoal: incoming.focusGoal,
    useTabContext: incoming.useTabContext,
    blockAdult: incoming.blockAdult,
    maskSearchElements: incoming.maskSearchElements,
    surrenderMode: incoming.surrenderMode,
    blockMessage: sanitizeBlockMessage(incoming.blockMessage),
    breakMode: normalizeBreakMode(incoming.breakMode),
    breakDelayMinutes: clampBreakDelayMinutes(incoming.breakDelayMinutes),
    breakDurationMinutes: clampBreakDurationMinutes(incoming.breakDurationMinutes),
    breakTextLength: clampBreakTextLength(incoming.breakTextLength),
  };
  return sanitizeProfilePolicy(candidate, local);
}

function managedGlobalsFrom(
  current: Settings,
  incoming: BackupManagedSettings,
  now: number,
): Pick<Settings, BackupGlobalField> {
  return {
    enabled: incoming.enabled,
    shareFeedback: incoming.shareFeedback,
    resolveEmbedTitles: incoming.resolveEmbedTitles,
    resumeMode: incoming.resumeMode,
    resumeAt: clampResumeAt(incoming.resumeAt, now),
    notificationPrefs: normalizeNotificationPrefs(incoming.notificationPrefs),
    firstDayOfWeek: normalizeFirstDayOfWeek(incoming.firstDayOfWeek),
    hour24: normalizeHour24(incoming.hour24),
  };
}

function mergeSettings(
  current: Settings,
  incoming: BackupManagedSettings,
  now: number,
): Settings {
  return {
    ...current,
    ...mergePolicies(extractProfilePolicy(current), incoming),
    ...managedGlobalsFrom(current, incoming, now),
  };
}

function replaceSettings(
  current: Settings,
  incoming: BackupManagedSettings,
  now: number,
): Settings {
  const policy = sanitizeProfilePolicy(incoming, defaultProfilePolicy());
  return {
    ...current,
    ...policy,
    ...managedGlobalsFrom(current, incoming, now),
  };
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

function appListStamp(
  local: readonly string[],
  next: readonly string[],
  localStamp: number,
  now: number,
): number {
  return local.length === next.length && local.every((app, index) => app === next[index])
    ? localStamp
    : now;
}

function mergeProfiles(
  current: ProfilesState,
  incoming: BackupDocument,
  now: number,
  warnings: string[],
): ProfilesState {
  const profiles: Profile[] = current.profiles.map((profile) => ({
    ...profile,
    policy: cloneProfilePolicy(profile.policy),
    appBlocklist: [...profile.appBlocklist],
  }));
  const usedIds = new Set(profiles.map((profile) => profile.id));
  const usedNames = new Set(profiles.map((profile) => profileNameKey(profile.name)));
  const matchedIds = new Set<string>();
  const incomingToMerged = new Map<string, string>();

  for (const imported of incoming.profiles) {
    let target = profiles.find(
      (profile) => profile.id === imported.id && !matchedIds.has(profile.id),
    );
    if (!target) {
      const nameKey = profileNameKey(imported.name);
      target = profiles.find(
        (profile) => profileNameKey(profile.name) === nameKey && !matchedIds.has(profile.id),
      );
    }

    if (target) {
      matchedIds.add(target.id);
      usedNames.delete(profileNameKey(target.name));
      const desiredName =
        normalizeProfileName(imported.name) || target.name;
      const finalName = uniqueName(desiredName, usedNames);
      if (finalName !== desiredName) {
        warnings.push(
          `Renamed imported profile “${desiredName}” to “${finalName}” to keep names unique.`,
        );
      }
      const mergedPolicy = mergePolicies(target.policy, imported.policy);
      const mergedApps = unionList(
        imported.appBlocklist,
        target.appBlocklist,
        MAX_APP_BLOCKLIST,
        (value) => value,
      );
      const changed =
        finalName !== target.name ||
        JSON.stringify(mergedPolicy) !== JSON.stringify(target.policy) ||
        mergedApps.length !== target.appBlocklist.length ||
        mergedApps.some((app, index) => app !== target.appBlocklist[index]);
      const nextProfile: Profile = {
        ...target,
        name: finalName,
        policy: mergedPolicy,
        appBlocklist: mergedApps,
        appBlocklistUpdatedAt: appListStamp(
          target.appBlocklist,
          mergedApps,
          target.appBlocklistUpdatedAt,
          now,
        ),
        updatedAt: changed ? now : target.updatedAt,
      };
      profiles[profiles.indexOf(target)] = nextProfile;
      incomingToMerged.set(imported.id, nextProfile.id);
      continue;
    }

    if (profiles.length >= BACKUP_MAX_PROFILES) {
      warnings.push(
        `Skipped new profile “${imported.name}”: the ${BACKUP_MAX_PROFILES}-profile limit was reached.`,
      );
      continue;
    }
    let id = isValidProfileId(imported.id) && !usedIds.has(imported.id)
      ? imported.id
      : makeProfileId();
    while (usedIds.has(id)) id = makeProfileId();
    usedIds.add(id);
    const desiredName =
      normalizeProfileName(imported.name) || `Profile ${profiles.length + 1}`;
    const finalName = uniqueName(desiredName, usedNames);
    if (finalName !== desiredName) {
      warnings.push(
        `Renamed imported profile “${desiredName}” to “${finalName}” to keep names unique.`,
      );
    }
    const createdAt = safeTimestamp(imported.createdAt, now);
    const nextProfile: Profile = {
      id,
      name: finalName,
      createdAt,
      updatedAt: safeTimestamp(imported.updatedAt, createdAt),
      policy: sanitizeProfilePolicy(imported.policy, defaultProfilePolicy()),
      appBlocklist: normalizeAppBlocklist(imported.appBlocklist),
      appBlocklistUpdatedAt: safeTimestamp(imported.appBlocklistUpdatedAt, 0),
    };
    profiles.push(nextProfile);
    incomingToMerged.set(imported.id, nextProfile.id);
  }

  const defaultApps = unionList(
    incoming.default.appBlocklist,
    current.defaultAppBlocklist,
    MAX_APP_BLOCKLIST,
    (value) => value,
  );
  const next: ProfilesState = {
    version: current.version,
    activeProfileId:
      incoming.activeProfileId === null
        ? null
        : (incomingToMerged.get(incoming.activeProfileId) ?? null),
    profiles,
    defaultAppBlocklist: defaultApps,
    defaultAppBlocklistUpdatedAt: appListStamp(
      current.defaultAppBlocklist,
      defaultApps,
      current.defaultAppBlocklistUpdatedAt,
      now,
    ),
  };
  return sanitizeProfilesState(next, now);
}

function replaceProfiles(
  current: ProfilesState,
  incoming: BackupDocument,
  now: number,
  warnings: string[],
): ProfilesState {
  if (incoming.profiles.length > BACKUP_MAX_PROFILES) {
    warnings.push(
      `The backup has more than ${BACKUP_MAX_PROFILES} profiles; extra profiles were dropped.`,
    );
  }
  const state = sanitizeProfilesState(
    {
      version: current.version,
      activeProfileId: incoming.activeProfileId,
      profiles: incoming.profiles,
      defaultAppBlocklist: incoming.default.appBlocklist,
      defaultAppBlocklistUpdatedAt: incoming.default.appBlocklistUpdatedAt,
    },
    now,
  );
  return state;
}

function pinRule(rule: ScheduleRule, options: BackupApplyOptions): ScheduleRule {
  return {
    ...rule,
    tzOffsetMinutes: rule.tzOffsetMinutes ?? options.tzOffsetMinutes,
    tzName: rule.tzName ?? options.tzName.slice(0, 64),
  };
}

function ruleKey(rule: ScheduleRule | CategoryScheduleRule): string {
  const category = 'categories' in rule ? rule.categories : [];
  return JSON.stringify([
    rule.id,
    [...rule.days].sort((a, b) => a - b),
    rule.startMinutes,
    rule.endMinutes,
    rule.leadMinutes ?? 0,
    rule.tzOffsetMinutes ?? null,
    rule.tzName ?? '',
    category,
  ]);
}

function rulesEqual<T extends ScheduleRule>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((rule, index) => ruleKey(rule) === ruleKey(b[index]));
}

function sameRuleCore(a: ScheduleRule, b: ScheduleRule): boolean {
  return (
    a.startMinutes === b.startMinutes &&
    a.endMinutes === b.endMinutes &&
    (a.leadMinutes ?? 0) === (b.leadMinutes ?? 0) &&
    a.days.length === b.days.length &&
    [...a.days].sort((x, y) => x - y).every((day, index) => day === [...b.days].sort((x, y) => x - y)[index])
  );
}

function sameCategoryCore(a: CategoryScheduleRule, b: CategoryScheduleRule): boolean {
  if (!sameRuleCore(a, b) || a.categories.length !== b.categories.length) return false;
  const left = [...a.categories].sort();
  const right = [...b.categories].sort();
  return left.every((category, index) => category === right[index]);
}

/** Restore-authored rules win their content, but a legacy rule without a
 *  timezone pin must not look "changed" merely because we would pin it on the
 *  next edit: merge keeps an identical local rule's existing pin. */
function applyRules(
  local: readonly ScheduleRule[],
  incoming: readonly ScheduleRule[],
  options: BackupApplyOptions,
  mode: BackupMode,
): ScheduleRule[] {
  if (mode === 'replace') return incoming.map((rule) => pinRule(rule, options));
  const out: ScheduleRule[] = [];
  for (const rule of incoming) {
    const localRule = local.find((entry) => entry.id === rule.id);
    if (localRule && rule.tzOffsetMinutes === undefined && sameRuleCore(localRule, rule)) {
      out.push({ ...localRule, days: [...localRule.days] });
    } else {
      out.push(pinRule(rule, options));
    }
  }
  const importedIds = new Set(out.map((rule) => rule.id));
  for (const rule of local) if (!importedIds.has(rule.id)) out.push(rule);
  return out;
}

function applyCategoryRules(
  local: readonly CategoryScheduleRule[],
  incoming: readonly CategoryScheduleRule[],
  options: BackupApplyOptions,
  mode: BackupMode,
): CategoryScheduleRule[] {
  if (mode === 'replace') {
    return incoming.map((rule) => ({
      ...pinRule(rule, options),
      categories: [...rule.categories],
    }));
  }
  const out: CategoryScheduleRule[] = [];
  for (const rule of incoming) {
    const localRule = local.find((entry) => entry.id === rule.id);
    if (localRule && rule.tzOffsetMinutes === undefined && sameCategoryCore(localRule, rule)) {
      out.push({ ...localRule, days: [...localRule.days], categories: [...localRule.categories] });
    } else {
      out.push({ ...pinRule(rule, options), categories: [...rule.categories] });
    }
  }
  const importedIds = new Set(out.map((rule) => rule.id));
  for (const rule of local) if (!importedIds.has(rule.id)) out.push(rule);
  return out;
}

export function mergeBackupState(
  current: BackupCurrentState,
  incoming: BackupDocument,
  options: BackupApplyOptions,
): BackupAppliedState {
  const warnings: string[] = [];
  const profiles = mergeProfiles(current.profiles, incoming, options.now, warnings);
  const schedules = applyRules(current.schedules, incoming.schedules.rules, options, 'merge');
  const categorySchedules = applyCategoryRules(
    current.categorySchedules,
    incoming.categorySchedules.rules,
    options,
    'merge',
  );
  const schedulesChanged = !rulesEqual(current.schedules, schedules);
  const categoryChanged = !rulesEqual(current.categorySchedules, categorySchedules);
  return {
    settings: mergeSettings(current.settings, incoming.default.settings, options.now),
    profiles,
    schedules,
    schedulesUpdatedAt: schedulesChanged ? options.now : current.schedulesUpdatedAt,
    categorySchedules,
    categorySchedulesUpdatedAt: categoryChanged
      ? options.now
      : current.categorySchedulesUpdatedAt,
    categorySchedulesPresent:
      current.categorySchedulesPresent || incoming.categorySchedules.rules.length > 0,
    warnings,
  };
}

export function replaceBackupState(
  current: BackupCurrentState,
  incoming: BackupDocument,
  options: BackupApplyOptions,
): BackupAppliedState {
  const warnings: string[] = [];
  const profiles = replaceProfiles(current.profiles, incoming, options.now, warnings);
  const schedules = applyRules(current.schedules, incoming.schedules.rules, options, 'replace');
  const categorySchedules = applyCategoryRules(
    current.categorySchedules,
    incoming.categorySchedules.rules,
    options,
    'replace',
  );
  const schedulesChanged = !rulesEqual(current.schedules, schedules);
  const categoryChanged = !rulesEqual(current.categorySchedules, categorySchedules);
  return {
    settings: replaceSettings(current.settings, incoming.default.settings, options.now),
    profiles,
    schedules,
    schedulesUpdatedAt: schedulesChanged ? options.now : current.schedulesUpdatedAt,
    categorySchedules,
    categorySchedulesUpdatedAt: categoryChanged
      ? options.now
      : current.categorySchedulesUpdatedAt,
    categorySchedulesPresent: true,
    warnings,
  };
}

export function applySchedulesToLockState(
  state: LockState,
  applied: BackupAppliedState,
): LockState {
  const next: LockState = {
    ...state,
    schedules: applied.schedules,
    schedulesUpdatedAt: applied.schedulesUpdatedAt,
  };
  if (applied.categorySchedulesPresent) {
    next.categorySchedules = applied.categorySchedules;
    next.categorySchedulesUpdatedAt = applied.categorySchedulesUpdatedAt;
  }
  return next;
}

function listDelta(before: readonly string[], after: readonly string[]): {
  added: number;
  removed: number;
} {
  const beforeSet = new Set(before.map((value) => value.toLowerCase()));
  const afterSet = new Set(after.map((value) => value.toLowerCase()));
  let added = 0;
  let removed = 0;
  for (const value of afterSet) if (!beforeSet.has(value)) added += 1;
  for (const value of beforeSet) if (!afterSet.has(value)) removed += 1;
  return { added, removed };
}

function listDetail(label: string, before: readonly string[], after: readonly string[]): string | null {
  const delta = listDelta(before, after);
  if (delta.added === 0 && delta.removed === 0) return null;
  return `${label}: ${before.length} → ${after.length} (+${delta.added}, −${delta.removed})`;
}

function policyDiff(before: ProfilePolicy, after: ProfilePolicy, names: {
  whitelist: string;
  blocklist: string;
  titleRules: string;
  channelBlocklist: string;
  channelAllowlist: string;
}): string[] {
  const details: string[] = [];
  if (before.blockThreshold !== after.blockThreshold) {
    details.push(
      `Threshold: ${Math.round(before.blockThreshold * 100)}% → ${Math.round(after.blockThreshold * 100)}%`,
    );
  }
  const labels = listDetail(
    'Blocked categories',
    before.labels.filter((label) => before.blockedLabels.includes(label)),
    after.labels.filter((label) => after.blockedLabels.includes(label)),
  );
  if (labels) details.push(labels);
  if (before.labels.length !== after.labels.length) {
    details.push(`Categories: ${before.labels.length} → ${after.labels.length}`);
  }
  const listChecks: [string, readonly string[], readonly string[]][] = [
    [names.whitelist, before.whitelist, after.whitelist],
    [names.blocklist, before.blocklist, after.blocklist],
    [names.titleRules, before.titleRules, after.titleRules],
    [names.channelBlocklist, before.channelBlocklist, after.channelBlocklist],
    [names.channelAllowlist, before.channelAllowlist, after.channelAllowlist],
  ];
  for (const [label, oldList, newList] of listChecks) {
    const detail = listDetail(label, oldList, newList);
    if (detail) details.push(detail);
  }
  if (before.focusGoal !== after.focusGoal) details.push('Focus goal changed');
  if (before.useTabContext !== after.useTabContext) {
    details.push(`Open-tab context: ${before.useTabContext ? 'on' : 'off'} → ${after.useTabContext ? 'on' : 'off'}`);
  }
  if (before.blockAdult !== after.blockAdult) {
    details.push(`Adult-site blocking: ${before.blockAdult ? 'on' : 'off'} → ${after.blockAdult ? 'on' : 'off'}`);
  }
  if (before.maskSearchElements !== after.maskSearchElements) {
    details.push(
      `Search-result masking: ${before.maskSearchElements ? 'on' : 'off'} → ${after.maskSearchElements ? 'on' : 'off'}`,
    );
  }
  if (before.surrenderMode !== after.surrenderMode) {
    details.push(`Typed override confirmation: ${before.surrenderMode} → ${after.surrenderMode}`);
  }
  if (before.blockMessage !== after.blockMessage) details.push('Block-screen note changed');
  if (
    before.breakMode !== after.breakMode ||
    before.breakDelayMinutes !== after.breakDelayMinutes ||
    before.breakDurationMinutes !== after.breakDurationMinutes ||
    before.breakTextLength !== after.breakTextLength
  ) {
    details.push('Break settings changed');
  }
  return details;
}

function globalSettingsDiff(before: Settings, after: Settings): string[] {
  const details: string[] = [];
  if (before.enabled !== after.enabled) {
    details.push(`Blocking: ${before.enabled ? 'on' : 'off'} → ${after.enabled ? 'on' : 'off'}`);
  }
  if (before.shareFeedback !== after.shareFeedback) {
    details.push(`Feedback sharing: ${before.shareFeedback ? 'on' : 'off'} → ${after.shareFeedback ? 'on' : 'off'}`);
  }
  if (before.resolveEmbedTitles !== after.resolveEmbedTitles) {
    details.push(
      `Embedded-video title lookups: ${before.resolveEmbedTitles ? 'on' : 'off'} → ${after.resolveEmbedTitles ? 'on' : 'off'}`,
    );
  }
  if (before.resumeMode !== after.resumeMode || before.resumeAt !== after.resumeAt) {
    details.push('Auto-resume changed');
  }
  if (JSON.stringify(before.notificationPrefs) !== JSON.stringify(after.notificationPrefs)) {
    details.push('Reminder preferences changed');
  }
  if (before.firstDayOfWeek !== after.firstDayOfWeek || before.hour24 !== after.hour24) {
    details.push('Display preferences changed');
  }
  return details;
}

function profileDiff(before: Profile | undefined, after: Profile): string[] {
  const details: string[] = [];
  if (before) {
    if (before.name !== after.name) details.push(`Name: “${before.name}” → “${after.name}”`);
    details.push(
      ...policyDiff(before.policy, after.policy, {
        whitelist: 'Allowed sites',
        blocklist: 'Blocked URL patterns',
        titleRules: 'Title rules',
        channelBlocklist: 'Blocked channels',
        channelAllowlist: 'Allowed channels',
      }),
    );
    const appDelta = listDelta(before.appBlocklist, after.appBlocklist);
    if (appDelta.added || appDelta.removed) {
      details.push(
        `Desktop apps: ${before.appBlocklist.length} → ${after.appBlocklist.length} (+${appDelta.added}, −${appDelta.removed})`,
      );
    }
  } else {
    details.push(
      `${after.policy.blockedLabels.length} blocked ${after.policy.blockedLabels.length === 1 ? 'category' : 'categories'} · ` +
        `${after.policy.whitelist.length} allowed ${after.policy.whitelist.length === 1 ? 'site' : 'sites'} · ` +
        `${Math.round(after.policy.blockThreshold * 100)}% threshold`,
    );
    if (after.appBlocklist.length > 0) {
      details.push(
        `${after.appBlocklist.length} desktop ${after.appBlocklist.length === 1 ? 'app' : 'apps'}`,
      );
    }
  }
  return details;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function scheduleLabel(rule: ScheduleRule | CategoryScheduleRule): string {
  const days = [...rule.days].sort((a, b) => a - b);
  const dayText =
    days.length === 7
      ? 'Every day'
      : days.join(',') === '1,2,3,4,5'
        ? 'Weekdays'
        : days.join(',') === '0,6'
          ? 'Weekends'
          : days.map((day) => DAY_SHORT[day]).join(', ');
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const base = `${dayText} ${clock(rule.startMinutes)}–${clock(rule.endMinutes)}`;
  if ('categories' in rule && rule.categories.length > 0) {
    return `${base} · ${rule.categories.join(', ')}`;
  }
  return base;
}

function scheduleDiff<T extends ScheduleRule>(
  kind: 'schedule' | 'category-schedule',
  before: readonly T[],
  after: readonly T[],
  mode: BackupMode,
): { changes: BackupChange[]; added: number; updated: number; removed: number } {
  const changes: BackupChange[] = [];
  const beforeById = new Map(before.map((rule) => [rule.id, rule]));
  const afterById = new Map(after.map((rule) => [rule.id, rule]));
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const rule of after) {
    const old = beforeById.get(rule.id);
    if (!old) {
      added += 1;
      changes.push({ kind, action: 'add', name: scheduleLabel(rule), details: [] });
    } else if (ruleKey(old) !== ruleKey(rule)) {
      updated += 1;
      changes.push({ kind, action: 'update', name: scheduleLabel(rule), details: ['Times, days, lead or timezone changed'] });
    }
  }
  if (mode === 'replace') {
    for (const rule of before) {
      if (!afterById.has(rule.id)) {
        removed += 1;
        changes.push({ kind, action: 'remove', name: scheduleLabel(rule), details: [] });
      }
    }
  }
  return { changes, added, updated, removed };
}

/** Compare the current config with what a merge/replace would produce. Pure,
 *  so the UI preview and the Node tests exercise exactly the apply path. */
export function buildBackupPreview(
  current: BackupCurrentState,
  document: BackupDocument,
  mode: BackupMode,
  options: BackupApplyOptions,
): BackupPreview {
  const applied =
    mode === 'merge'
      ? mergeBackupState(current, document, options)
      : replaceBackupState(current, document, options);
  const changes: BackupChange[] = [];

  const defaultDetails = [
    ...globalSettingsDiff(current.settings, applied.settings),
    ...policyDiff(extractProfilePolicy(current.settings), extractProfilePolicy(applied.settings), {
      whitelist: 'Allowed sites',
      blocklist: 'Blocked URL patterns',
      titleRules: 'Title rules',
      channelBlocklist: 'Blocked channels',
      channelAllowlist: 'Allowed channels',
    }),
  ];
  if (defaultDetails.length > 0) {
    changes.push({
      kind: 'default',
      action: 'update',
      name: 'Default settings',
      details: defaultDetails,
    });
  }

  const beforeProfiles = new Map(current.profiles.profiles.map((profile) => [profile.id, profile]));
  const appliedIds = new Set(applied.profiles.profiles.map((profile) => profile.id));
  let profilesAdded = 0;
  let profilesUpdated = 0;
  let profilesRemoved = 0;
  let profilesKept = 0;
  for (const profile of applied.profiles.profiles) {
    const before = beforeProfiles.get(profile.id);
    const details = profileDiff(before, profile);
    if (!before) {
      profilesAdded += 1;
      changes.push({ kind: 'profile', action: 'add', name: profile.name, details });
    } else if (details.length > 0) {
      profilesUpdated += 1;
      changes.push({ kind: 'profile', action: 'update', name: profile.name, details });
    } else {
      profilesKept += 1;
    }
  }
  if (mode === 'replace') {
    for (const profile of current.profiles.profiles) {
      if (!appliedIds.has(profile.id)) {
        profilesRemoved += 1;
        changes.push({
          kind: 'profile',
          action: 'remove',
          name: profile.name,
          details: ['Not present in the backup; this profile will be deleted.'],
        });
      }
    }
  }

  const schedule = scheduleDiff(
    'schedule',
    current.schedules,
    applied.schedules,
    mode,
  );
  const categorySchedule = scheduleDiff(
    'category-schedule',
    current.categorySchedules,
    applied.categorySchedules,
    mode,
  );
  changes.push(...schedule.changes, ...categorySchedule.changes);

  const counts: BackupPreviewCounts = {
    profilesAdded,
    profilesUpdated,
    profilesRemoved,
    profilesKept,
    schedulesAdded: schedule.added,
    schedulesUpdated: schedule.updated,
    schedulesRemoved: schedule.removed,
    categorySchedulesAdded: categorySchedule.added,
    categorySchedulesUpdated: categorySchedule.updated,
    categorySchedulesRemoved: categorySchedule.removed,
  };

  const summaryParts = [
    `${mode === 'merge' ? 'Merge' : 'Replace'} · `,
    `${profilesAdded} added, ${profilesUpdated} updated, ${profilesRemoved} removed, ${profilesKept} unchanged profiles`,
    ` · ${schedule.added + categorySchedule.added} focus-hours rules added, ` +
      `${schedule.updated + categorySchedule.updated} updated, ` +
      `${schedule.removed + categorySchedule.removed} removed`,
  ];
  if (current.profiles.activeProfileId !== applied.profiles.activeProfileId) {
    const active = applied.profiles.activeProfileId === null
      ? 'Default'
      : (applied.profiles.profiles.find((profile) => profile.id === applied.profiles.activeProfileId)?.name ?? 'Default');
    summaryParts.push(` · ${active} becomes active`);
  }
  if (changes.length === 0) {
    summaryParts.push(' · nothing will change');
  }

  return {
    mode,
    document,
    changes,
    counts,
    warnings: applied.warnings,
    summary: summaryParts.join(''),
  };
}
