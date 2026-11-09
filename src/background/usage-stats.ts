// Browser-event wiring for local usage statistics. Registered synchronously
// from background/index.ts; all asynchronous work is serialized by the tracker.
import { api } from '../shared/api';
import { getLockStatus } from '../shared/lock';
import { getSettings } from '../shared/settings';
import { getTabStatus, type TabStatus } from '../shared/tab-status';
import {
  normalizeUsageCategory,
  RULE_USAGE_CATEGORY,
  usageHostnameFromUrl,
  USAGE_STATS_HEARTBEAT_MINUTES,
  USAGE_STATS_IDLE_SECONDS,
  UNCATEGORIZED_USAGE_CATEGORY,
  type UsageBlockReason,
  type UsageContext,
  type UsageStatsExport,
} from '../shared/usage-stats';
import {
  UsageStatsTracker,
  type UsageTargetResolution,
} from './usage-stats-tracker';

const HEARTBEAT_ALARM = 'usage-stats-heartbeat';

let focusEventsAvailable = false;
let idleEventsAvailable = false;

function usageCategory(status: TabStatus | null): string {
  if (status?.kind === 'blocked-rule') return RULE_USAGE_CATEGORY;
  return normalizeUsageCategory(status?.label ?? UNCATEGORIZED_USAGE_CATEGORY);
}

/**
 * Classify a block-screen trigger into one disjoint bucket. The blocker's
 * existing verdict record is sufficient: deterministic rules use
 * kind=blocked-rule with a channel marker or rule label, adult rules use the
 * literal "adult" label, and the hard-lock classifier fallback is named.
 */
function usageBlockReason(status: TabStatus): UsageBlockReason {
  if (status.label === 'adult') return 'adult';
  if (status.rule?.startsWith('channel @')) return 'channel';
  if (status.kind === 'blocked-rule') return 'deterministic';
  if (status.label?.startsWith('classifier unavailable')) return 'fail-closed';
  return 'classifier';
}

/** Only a currently focused, system-active http/https tab can accrue time. */
async function resolveUsageTarget(at: number = Date.now()): Promise<UsageTargetResolution> {
  // Missing event APIs cannot prove a continuous foreground/idle segment.
  // Firefox still gets event counters, but time accounting fails conservatively
  // to zero rather than treating a background or idle tab as active.
  if (!focusEventsAvailable || !idleEventsAvailable) {
    return { target: null, context: null, discardPrevious: true };
  }
  try {
    if (!api.idle?.queryState || !api.windows?.getLastFocused) {
      return { target: null, context: null, discardPrevious: true };
    }
    const idleState = await api.idle.queryState(USAGE_STATS_IDLE_SECONDS);
    if (idleState !== 'active') return { target: null, context: null, discardPrevious: true };
  } catch {
    return { target: null, context: null, discardPrevious: true };
  }

  try {
    // Derive lock/break state at the observed boundary, not at the moment the
    // async queue drains, so an expiring lock cannot be charged to the wrong
    // interval. A malformed timestamp falls back to the wall clock.
    const boundary = Number.isFinite(at) && at > 0 ? at : Date.now();
    const [settings, lock] = await Promise.all([getSettings(), getLockStatus(boundary)]);
    // "Protected" means the system would block: the master switch is on, or a
    // lock is force-blocking even while the switch is off. It is independent
    // of whether this particular page was allowed.
    const context: UsageContext = {
      protected: settings.enabled || lock.forceBlocking,
      locked: lock.settingsLocked,
      break: lock.breakActive,
    };
    try {
      const window = await api.windows.getLastFocused();
      if (!window.focused || window.id === undefined) {
        return { target: null, context, discardPrevious: false };
      }
      const tabs = await api.tabs.query({ active: true, windowId: window.id });
      const tab = tabs.find((candidate) => candidate.active);
      const hostname = usageHostnameFromUrl(tab?.url);
      if (!hostname || tab?.id === undefined || !tab.url) {
        return { target: null, context, discardPrevious: false };
      }
      // Reuse the blocker's session verdict; never classify or persist page input.
      const status = await getTabStatus(tab.id, tab.url);
      return {
        target: { hostname, category: usageCategory(status) },
        context,
        discardPrevious: false,
      };
    } catch {
      return { target: null, context, discardPrevious: true };
    }
  } catch {
    return { target: null, context: null, discardPrevious: true };
  }
}

const tracker = new UsageStatsTracker(api.storage.local, resolveUsageTarget);

interface NavigationState {
  url: string;
  id: string;
  blocked: boolean;
  blockSequence: number;
}

const navigations = new Map<number, NavigationState>();
let fallbackNavigationSequence = 0;

function newNavigationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    fallbackNavigationSequence += 1;
    return `${Date.now().toString(36)}-${fallbackNavigationSequence.toString(36)}`;
  }
}

function withoutFragment(url: string): string {
  return url.split('#')[0];
}

function observeNavigation(tabId: number, url: string, forceNew = false): NavigationState | null {
  if (!usageHostnameFromUrl(url)) {
    navigations.delete(tabId);
    return null;
  }
  const existing = navigations.get(tabId);
  if (!forceNew && existing && withoutFragment(existing.url) === withoutFragment(url)) {
    existing.url = url;
    return existing;
  }
  const next = { url, id: newNavigationId(), blocked: false, blockSequence: 0 };
  navigations.set(tabId, next);
  return next;
}

function isBlockedStatus(status: TabStatus | undefined): status is TabStatus {
  return status?.kind === 'blocked' || status?.kind === 'blocked-rule';
}

function silencedDecisionId(
  tabId: number,
  status: TabStatus,
  countTransition = true,
): string | null {
  const navigation = observeNavigation(tabId, status.url);
  if (!navigation) return null;
  if (!isBlockedStatus(status)) {
    navigation.blocked = false;
    return null;
  }
  if (navigation.blocked) return null;
  navigation.blocked = true;
  // A worker has no in-memory navigation map after restart. If storage says
  // this exact page was already blocked, reconstruct that state without
  // counting the re-emitted verdict as a fresh transition.
  if (!countTransition) return null;
  navigation.blockSequence += 1;
  return `${navigation.id}:${navigation.blockSequence}`;
}

function reportError(message: string, error: unknown): void {
  console.warn(message, error);
}

function checkpointUsage(): void {
  tracker.checkpoint().catch((error) => reportError('[SmartBlocker] usage checkpoint failed:', error));
}

function observeTabStatus(
  tabId: number,
  status: TabStatus | undefined,
  previousStatus: TabStatus | undefined,
): void {
  if (!status || typeof status.url !== 'string' || typeof status.kind !== 'string') {
    checkpointUsage();
    return;
  }
  const alreadyKnown = navigations.has(tabId);
  const resumedBlockedPage =
    !alreadyKnown &&
    isBlockedStatus(status) &&
    isBlockedStatus(previousStatus) &&
    withoutFragment(previousStatus.url) === withoutFragment(status.url);
  const decisionId = silencedDecisionId(tabId, status, !resumedBlockedPage);
  const work = decisionId
    ? tracker.recordSilenced({
        url: status.url,
        category: usageCategory(status),
        reason: usageBlockReason(status),
        decisionId,
      })
    : tracker.checkpoint();
  work.catch((error) => reportError('[SmartBlocker] usage status observation failed:', error));
}

/** MV3 startup entry point: every browser listener is attached synchronously. */
export function initUsageStats(): void {
  try {
    focusEventsAvailable = Boolean(api.windows?.onFocusChanged?.addListener);
    if (focusEventsAvailable) {
      api.windows.onFocusChanged.addListener(() => checkpointUsage());
    }
  } catch {
    focusEventsAvailable = false;
  }

  try {
    idleEventsAvailable = Boolean(api.idle?.onStateChanged?.addListener);
    if (idleEventsAvailable) {
      api.idle.onStateChanged.addListener(() => checkpointUsage());
      void Promise.resolve(api.idle.setDetectionInterval(USAGE_STATS_IDLE_SECONDS)).catch(() => {
        // resolveUsageTarget re-queries each boundary and drops uncertain time.
      });
    }
  } catch {
    idleEventsAvailable = false;
  }

  api.tabs.onActivated.addListener(() => checkpointUsage());
  api.tabs.onRemoved.addListener((tabId) => {
    navigations.delete(tabId);
    checkpointUsage();
  });
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.url) observeNavigation(tabId, tab.url);
    checkpointUsage();
  });

  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    // onCommitted is a new main-frame generation even when a reload reuses the
    // exact URL. Verdict paints and fragment updates reuse that generation.
    observeNavigation(details.tabId, details.url, true);
    checkpointUsage();
  });
  api.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    observeNavigation(details.tabId, details.url);
    checkpointUsage();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('tabStatus:')) continue;
        const tabId = Number(key.slice('tabStatus:'.length));
        if (!Number.isInteger(tabId) || tabId < 0) continue;
        observeTabStatus(
          tabId,
          change.newValue as TabStatus | undefined,
          change.oldValue as TabStatus | undefined,
        );
      }
      return;
    }
    if (area !== 'local') return;
    // An exact boundary for protection/lock/break annotations. The prior
    // interval is charged with the prior context, then a new checkpoint is
    // resolved against the just-written state.
    if (changes.settings || changes.lockState) checkpointUsage();
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) checkpointUsage();
  });
  void api.alarms.create(HEARTBEAT_ALARM, {
    delayInMinutes: USAGE_STATS_HEARTBEAT_MINUTES,
    periodInMinutes: USAGE_STATS_HEARTBEAT_MINUTES,
  });

  // Startup reconciliation does not charge the persisted pre-restart segment:
  // the tracker's first live checkpoint is always recovery-only.
  checkpointUsage();
}

export function getUsageStatsSnapshot(): Promise<UsageStatsExport> {
  return tracker.snapshot();
}

export function clearUsageStatsSnapshot(): Promise<UsageStatsExport> {
  return tracker.clear();
}

/** Called only after the existing authenticated OVERRIDE path succeeds. */
export function recordUsageOverrideAction(input: {
  url: string;
  category: string;
}): Promise<boolean> {
  return tracker.recordOverride(input);
}
