// User-configurable settings, the single source of truth the classifier and
// blocker read at runtime. config.ts holds only the DEFAULTS; everything
// here is overridable from the options page and persisted in storage.local.
//
// Named profiles (profiles.ts / profile-store.ts) compose on top of this:
// the stored `settings` object is the Default profile. While a named profile
// is active, `getSettings()` overlays ONLY that profile's scoped policy on the
// Default/global object; `setSettings()` writes scoped edits into the active
// profile snapshot instead of mutating Default.
import { api } from './api';
import type { BreakMode } from './breaks';
import { getLockStatus } from './lock';
import { clampResumeAt } from './resume';
import { normalizeFirstDayOfWeek, normalizeHour24 } from './display-prefs';
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizeNotificationPrefs,
  type NotificationPrefs,
} from './notifications';
import {
  PROFILES_STORAGE_KEY,
  applyProfilePolicy,
  defaultProfilePolicy,
  extractProfilePolicy,
  isProfilePolicyField,
  migrateLabels as migrateProfileLabels,
  migrateWhitelist as migrateProfileWhitelist,
  sanitizeProfilePolicy,
  WHITELIST_VERSION as PROFILE_WHITELIST_VERSION,
  type ProfilePolicy,
  type ProfilePolicyKey,
} from './profiles';
import {
  getProfilesState,
  primeProfilesState,
  updateActiveProfilePolicy,
} from './profile-store';

export interface Settings {
  /** Candidate categories the zero-shot model scores against. */
  labels: string[];
  /** Subset of `labels` that triggers a block. */
  blockedLabels: string[];
  /** Minimum top-label score to block (0..1). */
  blockThreshold: number;
  /** Master kill switch — when false, nothing is ever blocked. GLOBAL: not
   *  part of a profile, so switching profiles never turns blocking off. */
  enabled: boolean;
  /** Set once the first-run onboarding flow has completed. GLOBAL. */
  onboarded: boolean;
  /** Hostnames never classified/blocked. Matched by domain + subdomains. */
  whitelist: string[];
  /**
   * Schema version of `whitelist` — lets a default-list change (e.g. the v2
   * removal of search engines) reach existing installs exactly ONCE, so an
   * entry the user deliberately re-adds afterwards is respected.
   */
  whitelistVersion: number;
  /**
   * Deterministic block rules: substrings matched against the full URL + page
   * title. A match blocks immediately, skipping the ML classifier entirely.
   * Empty by default — opt-in, unlike the model-driven category blocking.
   */
  blocklist: string[];
  /**
   * Deterministic TITLE-only block rules (CT "window titles"): each rule is a
   * case-insensitive substring matched against the cleaned page title, with
   * optional `*` multi-char wildcards (see shared/rules.ts). A match blocks
   * immediately, at the same ladder position as `blocklist` (after the
   * whitelist, before the classifier). Empty by default — opt-in.
   */
  titleRules: string[];
  /**
   * Channel rules (Phase 5), matched against the channel extractMeta()
   * scrapes (lowercase handle form, "mrbeast" — see rules.ts matchChannel).
   * channelBlocklist blocks deterministically between the blocklist and the
   * classifier (classifier skipped, reason "channel block"); channelAllowlist
   * rescues ONLY a classifier block verdict, never a blocklist/
   * channelBlocklist hit. Both empty by default.
   */
  channelBlocklist: string[];
  channelAllowlist: string[];
  /**
   * Opt-in: share anonymized misclassification feedback (see PRIVACY.md) to
   * improve the model. OFF by default — SmartBlocker is telemetry-free unless
   * the user explicitly enables this on the options page. GLOBAL: corrections
   * and centroids stay shared across profiles.
   */
  shareFeedback: boolean;
  /**
   * Built-in labels the user has explicitly deleted. Tracked so that
   * migrateLabels() doesn't silently re-add them on extension updates.
   */
  deletedBuiltinLabels: string[];
  /**
   * Optional free-text description of what the user is currently working on
   * (e.g. "Studying React hooks and TypeScript", "Filing taxes"). Empty by
   * default — when set, it feeds the context-aware disambiguation pass.
   */
  focusGoal: string;
  /**
   * Opt-in: let the context pass look at currently open productive tabs (plus
   * `focusGoal`) to disambiguate gray-zone pages. OFF by default — reading
   * open tabs is a stronger privacy step than classifying the single page.
   */
  useTabContext: boolean;
  /**
   * Opt-in: resolve titles of embedded YouTube videos/SERP cards through
   * YouTube's oEmbed endpoint when the page DOM gives no usable title.
   * OFF by default (red-team P1 #9): each lookup sends the YouTube video ID
   * to www.youtube.com, which is browsing-metadata egress. Never fires for
   * youtube-nocookie or privacy-facade embeds even when enabled. See the
   * "Network requests" section of PRIVACY.md. GLOBAL (privacy posture).
   */
  resolveEmbedTitles: boolean;
  /**
   * Opt-in: deterministic adult-site blocking. OFF by default. When on,
   * either signal blocks instantly (after the whitelist, with the URL
   * blocklist, before the classifier — reason label `adult`): (1) the page
   * self-declares an adult rating via <meta name="rating"> ("adult" or the
   * RTA tag — extract-meta.ts probeAdultMeta), or (2) the host is inside the
   * .xxx TLD (shared/rules.ts isAdultHost). Fully on-device; see PRIVACY.md.
   */
  blockAdult: boolean;
  /**
   * Auto-resume (Phase 5 "autostart-resume"): while this is non-'off' AND
   * blocking is DISABLED, the background resume-enforcer turns `enabled`
   * back on automatically — on browser startup, at the next scheduled-block
   * start, or at `resumeAt`. Closes the "forgot to re-enable" relapse path
   * (CT "Autostart Blocks"). Turning the toggle back on clears any armed
   * resume (resumeAt → null) but keeps the mode for next time. GLOBAL.
   */
  resumeMode: 'off' | 'startup' | 'schedule' | 'time';
  /**
   * Epoch ms of the chosen resume instant; only meaningful when
   * `resumeMode === 'time'`. setSettings clamps writes to now+24h max
   * (MAX_RESUME_AHEAD_MS in resume.ts) and invalid values to null. GLOBAL.
   */
  resumeAt: number | null;
  /** Optional user-requested break gate. Break state lives in lockState;
   *  these fields configure only how a new break may be started. */
  breakMode: BreakMode;
  /** Pending delay before a delay break activates (whole minutes, 0–60). */
  breakDelayMinutes: number;
  /** Classifier-break duration (whole minutes, 1–1440). */
  breakDurationMinutes: number;
  /** Number of random symbols required for a random-text break (10–1000). */
  breakTextLength: number;
  /**
   * Opt-in typed confirmation for non-locked block-screen overrides. OFF by
   * default: existing installs keep one-click per-page corrections. 'phrase'
   * adds a 15-second pause and exact neutral-phrase entry in the injected
   * block screen only; it is UX friction, not an authentication boundary.
   */
  surrenderMode: 'off' | 'phrase';
  /**
   * Proactively mask distracting modules (videos, carousels, games,
   * news, shopping) and off-topic result cards on search engines, plus
   * individually classified videos on YouTube Search. Default true.
   */
  maskSearchElements: boolean;
  /**
   * Opt-in, quiet browser reminders (versioned and sanitized on every read and
   * write — see shared/notifications.ts). EVERY group is OFF by default so an
   * existing install never starts receiving toasts after an update. Global to
   * this browser profile: no per-category or per-schedule notification scope.
   */
  notificationPrefs: NotificationPrefs;
  /** Display only: 0 = Sunday, 1 = Monday. Never changes evaluation. */
  firstDayOfWeek: 0 | 1;
  /** Display only: format times as 24-hour instead of 12-hour. */
  hour24: boolean;
  /** Optional plain-text note shown on block screens. Empty = hidden. */
  blockMessage: string;
}

/** v1: original list (search engines whitelisted). v2 (2026-11-07): search
 *  roots removed, `google.com` replaced by its productive subdomains. */
export const WHITELIST_VERSION = PROFILE_WHITELIST_VERSION;

const POLICY_DEFAULTS = defaultProfilePolicy(WHITELIST_VERSION);

export const DEFAULTS: Settings = {
  ...POLICY_DEFAULTS,
  enabled: true,
  onboarded: false,
  shareFeedback: false,
  resolveEmbedTitles: false,
  resumeMode: 'off',
  resumeAt: null,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
  firstDayOfWeek: 0,
  hour24: false,
};

const STORAGE_KEY = 'settings';
/** Written in the SAME storage transaction as a daemon-applied `enabled`
 * value. The background bridge recognizes this unique receipt instead of
 * guessing from the boolean value, so overlapping writes and old-connection
 * events cannot be mistaken for new user intent. */
export const COMPANION_BLOCKING_ECHO_KEY = 'companionBlockingApplyEcho';

// Re-exported for callers that used the old settings-local helpers.
export { migrateProfileLabels as migrateLabels };
export { migrateProfileWhitelist as migrateWhitelist };

let cache: Settings | null = null;

// Invalidate the in-memory cache when any context (options page, popup) writes
// new settings OR activates/edits a named profile, so a long-lived service
// worker / offscreen doc sees the new effective policy.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[STORAGE_KEY] || changes[PROFILES_STORAGE_KEY])) cache = null;
});

/** Display preferences are presentation only. Sanitizing on READ (and again on
 *  write) keeps devtools-tampered values from reaching every renderer. The
 *  custom block message is policy-scoped, so it is sanitized with the rest of
 *  the profile policy instead. */
function normalizeDisplaySettings(
  stored: Partial<Settings> | undefined,
): Pick<Settings, 'firstDayOfWeek' | 'hour24'> {
  return {
    firstDayOfWeek: normalizeFirstDayOfWeek(stored?.firstDayOfWeek),
    hour24: normalizeHour24(stored?.hour24),
  };
}

/** Merge stored Default/global fields with sanitized policy values. Policy
 *  migration/sanitization lives in profiles.ts so Default and every named
 *  profile share one implementation. */
function mergeStoredSettings(storedSettings: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULTS,
    ...storedSettings,
    ...sanitizeProfilePolicy(storedSettings, POLICY_DEFAULTS),
    ...normalizeDisplaySettings(storedSettings),
    notificationPrefs: normalizeNotificationPrefs(storedSettings?.notificationPrefs),
  };
}

/** Read the Default profile (the stored `settings` key) without overlaying a
 *  named profile. Exported for the Profiles page and tests. */
export async function getDefaultSettings(): Promise<Settings> {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return mergeStoredSettings(stored[STORAGE_KEY] as Partial<Settings> | undefined);
}

/** Read effective settings: Default/global fields, with the active named
 *  profile's scoped policy replacing Default only for those fields. */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const base = await getDefaultSettings();
  const profiles = await getProfilesState();
  const active =
    profiles.activeProfileId === null
      ? null
      : profiles.profiles.find((profile) => profile.id === profiles.activeProfileId) ?? null;
  cache = active ? applyProfilePolicy(base, active.policy) : base;
  return cache;
}

function pickPolicyPatch(patch: Partial<Settings>): Partial<ProfilePolicy> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!isProfilePolicyField(key)) continue;
    out[key] = (patch as Record<string, unknown>)[key];
  }
  return out as Partial<ProfilePolicy>;
}

function pickGlobalPatch(patch: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isProfilePolicyField(key)) continue;
    out[key] = value;
  }
  return out as Partial<Settings>;
}

/** Merge a partial update into the effective settings and return the result.
 *  THROWS while a lock is active (see lock.ts) — the single choke point every
 *  settings writer goes through, in whichever context it runs. While a named
 *  profile is active, scoped fields persist to that profile's snapshot; the
 *  Default profile's scoped fields are untouched. */
async function writeSettings(patch: Partial<Settings>, echoId?: string): Promise<Settings> {
  const lock = await getLockStatus();
  // Enabling ordinary blocking is always legal. Every disable and every other
  // settings mutation stays frozen by ANY active lock, including timer-only,
  // password, delay, random-text, Frozen Turkey, and schedule locks.
  const enableOnly = Object.keys(patch).length === 1 && patch.enabled === true;
  if (lock.settingsLocked && !enableOnly) {
    throw new Error(
      'SmartBlocker settings are locked' +
        (lock.until
          ? ` until ${new Date(lock.until).toLocaleString()}`
          : ' (password required)'),
    );
  }

  const base = await getDefaultSettings();
  const policyPatch = pickPolicyPatch(patch);
  const globalPatch = pickGlobalPatch(patch);
  const profiles = await getProfilesState();
  const active =
    profiles.activeProfileId === null
      ? null
      : profiles.profiles.find((profile) => profile.id === profiles.activeProfileId) ?? null;
  const nextBase: Settings = { ...base, ...globalPatch };
  // Centralized write clamp for the auto-resume instant (24h horizon, invalid
  // → null — see resume.ts). Central here so every writer (options page,
  // popup, background) is covered identically.
  if ('resumeAt' in globalPatch) {
    nextBase.resumeAt = clampResumeAt(globalPatch.resumeAt, Date.now());
  }
  // Global presentation/reminder fields are normalized on write too, so a
  // profile switch can never smuggle an unsanitized value into Default.
  nextBase.notificationPrefs = normalizeNotificationPrefs(nextBase.notificationPrefs);
  Object.assign(nextBase, normalizeDisplaySettings(nextBase));

  if (active) {
    const hasPolicyPatch = Object.keys(policyPatch).length > 0;
    const nextState = hasPolicyPatch
      ? updateActiveProfilePolicy(
          profiles,
          active.id,
          sanitizeProfilePolicy({ ...active.policy, ...policyPatch }, active.policy),
          Date.now(),
        )
      : profiles;
    const next = applyProfilePolicy(nextBase, hasPolicyPatch
      ? nextState.profiles.find((profile) => profile.id === active.id)!.policy
      : active.policy);
    cache = next;
    if (hasPolicyPatch) primeProfilesState(nextState);
    await api.storage.local.set({
      [STORAGE_KEY]: nextBase,
      ...(hasPolicyPatch ? { [PROFILES_STORAGE_KEY]: nextState } : {}),
      ...(echoId ? { [COMPANION_BLOCKING_ECHO_KEY]: echoId } : {}),
    });
    return next;
  }

  const defaultPolicy = extractProfilePolicy(base);
  const nextPolicy = sanitizeProfilePolicy(
    { ...defaultPolicy, ...policyPatch },
    defaultPolicy,
  );
  const next: Settings = { ...nextBase, ...nextPolicy };
  cache = next;
  await api.storage.local.set({
    [STORAGE_KEY]: next,
    ...(echoId ? { [COMPANION_BLOCKING_ECHO_KEY]: echoId } : {}),
  });
  return next;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return writeSettings(patch);
}

/** Daemon-owned ordinary-blocking application. This deliberately passes
 *  through the same lock guard as every other settings mutation. */
export async function setCompanionBlockingEnabled(
  enabled: boolean,
  echoId: string,
): Promise<Settings> {
  return writeSettings({ enabled }, echoId);
}
