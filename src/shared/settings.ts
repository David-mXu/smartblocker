// User-configurable settings, the single source of truth the classifier and
// blocker read at runtime. config.ts now holds only the DEFAULTS; everything
// here is overridable from the options page and persisted in storage.local.
import { api } from './api';
import {
  BLOCKED_LABELS,
  BLOCK_THRESHOLD,
  DEFAULT_WHITELIST,
  GOOGLE_PRODUCTIVE_HOSTS,
  LABELS,
  LEGACY_SEARCH_WHITELIST,
} from './config';
import { getLockStatus } from './lock';
import { clampResumeAt } from './resume';
import {
  clampBreakDelayMinutes,
  clampBreakDurationMinutes,
  clampBreakTextLength,
  normalizeBreakMode,
  type BreakMode,
} from './breaks';
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizeNotificationPrefs,
  type NotificationPrefs,
} from './notifications';

export interface Settings {
  /** Candidate categories the zero-shot model scores against. */
  labels: string[];
  /** Subset of `labels` that triggers a block. */
  blockedLabels: string[];
  /** Minimum top-label score to block (0..1). */
  blockThreshold: number;
  /** Master kill switch — when false, nothing is ever blocked. */
  enabled: boolean;
  /** Set once the first-run onboarding flow has completed. */
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
   * the user explicitly enables this on the options page.
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
   * "Network requests" section of PRIVACY.md.
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
   * resume (resumeAt → null) but keeps the mode for next time.
   */
  resumeMode: 'off' | 'startup' | 'schedule' | 'time';
  /**
   * Epoch ms of the chosen resume instant; only meaningful when
   * `resumeMode === 'time'`. setSettings clamps writes to now+24h max
   * (MAX_RESUME_AHEAD_MS in resume.ts) and invalid values to null.
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
}

/** v1: original list (search engines whitelisted). v2 (2026-11-07): search
 *  roots removed, `google.com` replaced by its productive subdomains. */
export const WHITELIST_VERSION = 2;

export const DEFAULTS: Settings = {
  labels: [...LABELS],
  blockedLabels: [...BLOCKED_LABELS],
  blockThreshold: BLOCK_THRESHOLD,
  enabled: true,
  onboarded: false,
  whitelist: [...DEFAULT_WHITELIST],
  whitelistVersion: WHITELIST_VERSION,
  blocklist: [],
  titleRules: [],
  channelBlocklist: [],
  channelAllowlist: [],
  shareFeedback: false,
  deletedBuiltinLabels: [],
  focusGoal: '',
  useTabContext: false,
  resolveEmbedTitles: false,
  blockAdult: false,
  resumeMode: 'off',
  resumeAt: null,
  breakMode: 'off',
  breakDelayMinutes: 1,
  breakDurationMinutes: 10,
  breakTextLength: 100,
  surrenderMode: 'off',
  maskSearchElements: true,
  notificationPrefs: DEFAULT_NOTIFICATION_PREFS,
};

const STORAGE_KEY = 'settings';
/** Written in the SAME storage transaction as a daemon-applied `enabled`
 * value. The background bridge recognizes this unique receipt instead of
 * guessing from the boolean value, so overlapping writes and old-connection
 * events cannot be mistaken for new user intent. */
export const COMPANION_BLOCKING_ECHO_KEY = 'companionBlockingApplyEcho';

let cache: Settings | null = null;

// Invalidate the in-memory cache when any context (options page, popup) writes
// new settings, so a long-lived service worker / offscreen doc sees changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/**
 * `labels`/`blockedLabels` are persisted snapshots taken at onboarding time,
 * so they go stale whenever config.ts's LABELS/BLOCKED_LABELS grow (e.g. the
 * 13-category expansion) — an existing user's stored settings would silently
 * keep classifying against only their old label set forever. Append any
 * canonical label missing from the stored snapshot (preserving user order/
 * edits otherwise), carrying over the new label's default blocked-ness.
 */
function migrateLabels(stored: Partial<Settings> | undefined): Pick<Settings, 'labels' | 'blockedLabels'> {
  if (!stored?.labels) {
    return { labels: [...DEFAULTS.labels], blockedLabels: [...DEFAULTS.blockedLabels] };
  }
  const known = new Set(stored.labels);
  const deleted = new Set(stored.deletedBuiltinLabels ?? []);
  // Append canonical labels the user hasn't seen yet, but skip any they
  // explicitly deleted — otherwise updates would silently re-add them.
  const newLabels = LABELS.filter((l) => !known.has(l) && !deleted.has(l));
  if (newLabels.length === 0) {
    return { labels: stored.labels, blockedLabels: stored.blockedLabels ?? [...DEFAULTS.blockedLabels] };
  }
  return {
    labels: [...stored.labels, ...newLabels],
    blockedLabels: [
      ...(stored.blockedLabels ?? []),
      ...newLabels.filter((l) => BLOCKED_LABELS.has(l)),
    ],
  };
}

/**
 * Bring a stored whitelist up to WHITELIST_VERSION. Runs at READ time (like
 * migrateLabels), so it also applies while settings are locked — safe, since
 * it only ever shrinks the exemption set (stricter, never looser) — and is
 * persisted by the next setSettings(). v1 → v2: strip the legacy search-engine
 * roots (whitelisting "google.com" exempted Google News, image viewers and
 * inline video previews — the standard YouTube bypass) and, if "google.com"
 * was present, keep its productive subdomains working by adding them back
 * explicitly.
 */
export function migrateWhitelist(
  stored: Partial<Settings> | undefined,
): Pick<Settings, 'whitelist' | 'whitelistVersion'> {
  if (!stored?.whitelist) {
    return { whitelist: [...DEFAULT_WHITELIST], whitelistVersion: WHITELIST_VERSION };
  }
  const version = stored.whitelistVersion ?? 1;
  if (version >= WHITELIST_VERSION) {
    return { whitelist: stored.whitelist, whitelistVersion: version };
  }
  const norm = (e: string) => e.trim().toLowerCase().replace(/^www\./, '');
  const legacy = new Set(LEGACY_SEARCH_WHITELIST);
  const hadGoogleRoot = stored.whitelist.some((e) => norm(e) === 'google.com');
  const next = stored.whitelist.filter((e) => !legacy.has(norm(e)));
  if (hadGoogleRoot) {
    const present = new Set(next.map(norm));
    for (const h of GOOGLE_PRODUCTIVE_HOSTS) if (!present.has(h)) next.push(h);
  }
  return { whitelist: next, whitelistVersion: WHITELIST_VERSION };
}

function normalizeBreakSettings(
  stored: Partial<Settings> | undefined,
): Pick<Settings, 'breakMode' | 'breakDelayMinutes' | 'breakDurationMinutes' | 'breakTextLength'> {
  return {
    breakMode: normalizeBreakMode(stored?.breakMode),
    breakDelayMinutes: clampBreakDelayMinutes(stored?.breakDelayMinutes),
    breakDurationMinutes: clampBreakDurationMinutes(stored?.breakDurationMinutes),
    breakTextLength: clampBreakTextLength(stored?.breakTextLength),
  };
}

/** Read settings (cached), falling back to DEFAULTS for any missing field. */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  const storedSettings = stored[STORAGE_KEY] as Partial<Settings> | undefined;
  cache = {
    ...DEFAULTS,
    ...storedSettings,
    ...normalizeBreakSettings(storedSettings),
    ...migrateLabels(storedSettings),
    ...migrateWhitelist(storedSettings),
    notificationPrefs: normalizeNotificationPrefs(storedSettings?.notificationPrefs),
  };
  return cache;
}

/** Merge a partial update into the stored settings and return the result.
 *  THROWS while a lock is active (see lock.ts) — the single choke point every
 *  settings writer goes through, in whichever context it runs. (A raw
 *  storage.local.set from devtools bypasses it: accepted soft-lock.) */
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
  const next = { ...(await getSettings()), ...patch };
  // Centralized write clamp for the auto-resume instant (24h horizon, invalid
  // → null — see resume.ts). Central here so every writer (options page,
  // popup, background) is covered identically.
  if ('resumeAt' in patch) {
    next.resumeAt = clampResumeAt(patch.resumeAt, Date.now());
  }
  Object.assign(next, normalizeBreakSettings(next));
  next.notificationPrefs = normalizeNotificationPrefs(next.notificationPrefs);
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
 * through the same lock guard as every other settings mutation. */
export async function setCompanionBlockingEnabled(
  enabled: boolean,
  echoId: string,
): Promise<Settings> {
  return writeSettings({ enabled }, echoId);
}
