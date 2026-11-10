// Browser wiring for opt-in productive-work reward accrual. The pure reducer
// lives in shared/reward-accrual.ts; this module resolves eligibility from
// local browser state and submits ONLY authoritative `reward` commands.
import { api } from '../shared/api';
import {
  DEFAULT_ALLOWANCE_CONFIG,
  deriveAllowance,
  normalizeAllowanceConfig,
} from '../shared/allowance-math';
import { allowanceLocalDayKey } from '../shared/allowance-store';
import { getLockStatus } from '../shared/lock';
import { getSettings } from '../shared/settings';
import { getTabStatus } from '../shared/tab-status';
import {
  rewardVerdictEligible,
  REWARD_ACCRUAL_STORAGE_KEY,
  type RewardAccrualStatus,
  type RewardEarningConfig,
  type RewardEarningReason,
} from '../shared/reward-accrual';
import { getAllowanceResponse, submitAllowanceCommand } from './allowance';
import { allowanceReliefForCategory } from './allowance';
import { getFocusCycleResponse } from './focus-cycles';
import {
  RewardAccrualTracker,
  type RewardResolution,
} from './reward-tracker';

const HEARTBEAT_ALARM = 'reward-accrual-heartbeat';
const IDLE_SECONDS = 30;

let focusEventsAvailable = false;
let idleEventsAvailable = false;
let tracker: RewardAccrualTracker | null = null;

function emptyResolution(reason: RewardEarningReason, discardPrevious = false): RewardResolution {
  return { categories: [], configs: {}, reason, discardPrevious };
}

function configForCurrentDay(
  category: string,
  ledger: unknown,
  config: ReturnType<typeof normalizeAllowanceConfig>,
  at: number,
): RewardEarningConfig | null {
  if (!config.rewardEarning || config.rewardCapMs <= 0) return null;
  const derived = deriveAllowance(ledger, config, {
    nowMs: at,
    dayKey: allowanceLocalDayKey(new Date(at)),
  });
  const remainingCapMs = Math.max(0, config.rewardCapMs - derived.earnedRewardMs);
  if (remainingCapMs <= 0) return null;
  return {
    workMs: config.rewardWorkMs,
    awardMs: config.rewardAwardMs,
    remainingCapMs,
  };
}

/**
 * The conservative earning rule:
 * - SmartBlocker enabled and a settings lock/focus session active;
 * - not an explicit break or an active focus/Pomodoro program (those already
 *   award their own completed work);
 * - focused window, system-active, foreground http(s) tab only;
 * - a real classifier ALLOW at or above the configured threshold — whitelisted
 *   pages (no verdict), overrides, browsing containers, weak verdicts, and
 *   blocked/fail-closed pages do not earn;
 * - not a live allowance/opening/Pomodoro-relieved page.
 */
async function resolveRewardTarget(at: number): Promise<RewardResolution> {
  // Configs are read even when not currently earning: a pending award from a
  // segment that ended on a lock/tab boundary must still settle.
  const authority = await getAllowanceResponse();
  const configs: Record<string, RewardEarningConfig> = {};
  let capped = false;
  if (authority.ok && authority.state) {
    for (const [category, current] of Object.entries(authority.state.categories)) {
      const normalized = normalizeAllowanceConfig(current.config);
      if (!normalized.rewardEarning) continue;
      if (normalized.rewardCapMs <= 0) {
        capped = true;
        continue;
      }
      const config = configForCurrentDay(category, current.ledger, normalized, at);
      if (config) {
        Object.defineProperty(configs, category, {
          value: config,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      } else {
        capped = true;
      }
    }
  }

  if (!authority.ok || !authority.state) {
    return { ...emptyResolution('unavailable', true), configs: {} };
  }
  const noneReason: RewardEarningReason = capped ? 'cap-reached' : 'unconfigured';

  if (!focusEventsAvailable || !idleEventsAvailable) {
    return { ...emptyResolution('unavailable', true), configs };
  }
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return { ...emptyResolution('unavailable', true), configs };
  }
  if (!settings.enabled) return { ...emptyResolution('disabled'), configs };

  let lock;
  try {
    lock = await getLockStatus(at);
  } catch {
    return { ...emptyResolution('unavailable', true), configs };
  }
  if (!lock.settingsLocked) return { ...emptyResolution('not-locked'), configs };
  if (lock.breakActive) return { ...emptyResolution('break', true), configs };

  try {
    const cycle = await getFocusCycleResponse();
    if (cycle.program) return { ...emptyResolution('focus-cycle', true), configs };
  } catch {
    // The focus scheduler is optional evidence. A read failure must not turn
    // an otherwise productive segment into free reward after a restart.
    return { ...emptyResolution('unavailable', true), configs };
  }

  if (Object.keys(configs).length === 0) {
    return { ...emptyResolution(noneReason), configs };
  }

  try {
    if (!api.idle?.queryState || !api.windows?.getLastFocused) {
      return { ...emptyResolution('unavailable', true), configs };
    }
    const idleState = await api.idle.queryState(IDLE_SECONDS);
    if (idleState !== 'active') return { ...emptyResolution('idle', true), configs };
  } catch {
    return { ...emptyResolution('unavailable', true), configs };
  }

  let status;
  try {
    const window = await api.windows.getLastFocused();
    if (!window.focused || window.id === undefined) {
      return { ...emptyResolution('unfocused'), configs };
    }
    const tabs = await api.tabs.query({ active: true, windowId: window.id });
    const tab = tabs.find((candidate) => candidate.active);
    if (!tab?.url || tab.id === undefined || !/^https?:/i.test(tab.url)) {
      return { ...emptyResolution('not-productive'), configs };
    }
    status = await getTabStatus(tab.id, tab.url);
  } catch {
    return { ...emptyResolution('unavailable', true), configs };
  }

  if (!status || !rewardVerdictEligible(status, settings.blockThreshold)) {
    return { ...emptyResolution('not-productive'), configs };
  }
  if (status.label) {
    try {
      if (await allowanceReliefForCategory(status.label)) {
        return { ...emptyResolution('relief'), configs };
      }
    } catch {
      return { ...emptyResolution('unavailable'), configs };
    }
  }
  return {
    categories: Object.keys(configs),
    configs,
    reason: 'earning',
    discardPrevious: false,
  };
}

function requestCheckpoint(): void {
  tracker?.checkpoint().catch((error) => {
    console.warn('[SmartBlocker] reward checkpoint failed:', error);
  });
}

/** MV3 startup entry point: every browser listener is attached synchronously. */
export function initRewardAccrual(): void {
  try {
    focusEventsAvailable = Boolean(api.windows?.onFocusChanged?.addListener);
    if (focusEventsAvailable) api.windows.onFocusChanged.addListener(requestCheckpoint);
  } catch {
    focusEventsAvailable = false;
  }
  try {
    idleEventsAvailable = Boolean(api.idle?.onStateChanged?.addListener);
    if (idleEventsAvailable) api.idle.onStateChanged.addListener(requestCheckpoint);
  } catch {
    idleEventsAvailable = false;
  }

  tracker = new RewardAccrualTracker(
    api.storage.local,
    resolveRewardTarget,
    (award) =>
      submitAllowanceCommand({
        kind: 'reward',
        operationId: award.operationId,
        category: award.category,
        grantId: award.operationId,
        nowMs: award.nowMs,
        dayKey: award.dayKey,
        earnedMs: award.earnedMs,
      }),
  );

  api.tabs.onActivated.addListener(requestCheckpoint);
  api.tabs.onRemoved.addListener(requestCheckpoint);
  api.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) requestCheckpoint();
  });
  api.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) requestCheckpoint();
  });
  api.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) requestCheckpoint();
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.lockState || changes.settings)) requestCheckpoint();
    if (area === 'session') {
      for (const key of Object.keys(changes)) {
        if (key.startsWith('tabStatus:')) {
          requestCheckpoint();
          return;
        }
      }
    }
  });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) requestCheckpoint();
  });
  void api.alarms.create(HEARTBEAT_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });

  // Recovery is deliberate: the persisted pre-restart gap is never charged.
  requestCheckpoint();
}

export function getRewardAccrualStatus(): Promise<RewardAccrualStatus> {
  return (
    tracker?.status() ??
    Promise.resolve({
      reason: 'unavailable',
      earning: false,
      checkpointAtMs: null,
      progress: [],
    })
  );
}

export const __rewardTrackerConfig = {
  storageKey: REWARD_ACCRUAL_STORAGE_KEY,
  defaults: DEFAULT_ALLOWANCE_CONFIG,
};
