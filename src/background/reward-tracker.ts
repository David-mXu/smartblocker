// Browser-independent persistence and retry orchestration for reward accrual.
// No chrome/browser import: scripts/reward-accrual-test.mjs drives this class
// with an in-memory storage, a controlled clock, and an authoritative submit
// stub. Production wiring lives in background/reward-accrual.ts.
import type { AllowanceResponse } from '../shared/messages';
import {
  localRewardDayKey,
  pendingRewardAwards,
  rewardAccrualStatus,
  sanitizeRewardAccrualState,
  settleRewardAward,
  transitionRewardCheckpoint,
  REWARD_ACCRUAL_STORAGE_KEY,
  type PendingRewardAward,
  type RewardAccrualState,
  type RewardAccrualStatus,
  type RewardEarningConfig,
  type RewardEarningReason,
} from '../shared/reward-accrual';

export interface RewardAccrualStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface RewardResolution {
  categories: string[];
  configs: Record<string, RewardEarningConfig>;
  reason: RewardEarningReason;
  discardPrevious: boolean;
}

export type ResolveRewardTarget = (at: number) => RewardResolution | Promise<RewardResolution>;
export type SubmitRewardAward = (award: PendingRewardAward) => Promise<AllowanceResponse>;

export function isTerminalRewardRefusal(response: AllowanceResponse): boolean {
  if (response.ok) return false;
  return [
    'invalid-reward',
    'invalid-time',
    'invalid-day',
    'day-rollback',
    'clock-rollback',
    'invalid-category',
    'invalid-operation',
    'duplicate-operation',
    'version',
  ].includes(response.reason ?? '');
}

export class RewardAccrualTracker {
  storage: RewardAccrualStorage;
  resolveTarget: ResolveRewardTarget;
  submit: SubmitRewardAward;
  now: () => number;
  state: RewardAccrualState | null = null;
  hasLiveCheckpoint = false;
  queue: Promise<void> = Promise.resolve();
  lastStatus: RewardAccrualStatus | null = null;
  lastConfigs: Record<string, RewardEarningConfig> = {};

  constructor(
    storage: RewardAccrualStorage,
    resolveTarget: ResolveRewardTarget,
    submit: SubmitRewardAward,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.resolveTarget = resolveTarget;
    this.submit = submit;
    this.now = now;
  }

  /** Recovery-only first observation after every worker restart. */
  async ensureLoaded(): Promise<RewardAccrualState> {
    if (this.state) return this.state;
    const stored = await this.storage.get(REWARD_ACCRUAL_STORAGE_KEY);
    const deviceId = crypto.randomUUID().replaceAll('-', '');
    this.state = sanitizeRewardAccrualState(stored[REWARD_ACCRUAL_STORAGE_KEY], deviceId);
    this.hasLiveCheckpoint = false;
    return this.state;
  }

  async persistInternal(): Promise<void> {
    if (!this.state) return;
    await this.storage.set({ [REWARD_ACCRUAL_STORAGE_KEY]: this.state });
  }

  async settlePendingInternal(): Promise<boolean> {
    if (!this.state) return false;
    let changed = false;
    for (const award of pendingRewardAwards(this.state)) {
      let response: AllowanceResponse;
      try {
        response = await this.submit(award);
      } catch {
        // Keep the exact persisted intent; the next checkpoint retries.
        continue;
      }
      if (response.ok || isTerminalRewardRefusal(response)) {
        // A terminal refusal consumes the work too: accepting the next
        // checkpoint must not re-offer the same minutes under a fresh id.
        this.state = settleRewardAward(this.state, award.operationId);
        changed = true;
      }
    }
    return changed;
  }

  async checkpointInternal(at: number): Promise<void> {
    const state = await this.ensureLoaded();
    const resolution = await this.resolveTarget(at);
    this.lastConfigs = resolution.configs;
    const transition = transitionRewardCheckpoint(state, {
      atMs: at,
      dayKey: localRewardDayKey(at),
      categories: resolution.categories,
      configs: resolution.configs,
      discardPrevious: !this.hasLiveCheckpoint || resolution.discardPrevious,
    });
    this.state = transition.state;
    this.hasLiveCheckpoint = true;
    this.lastStatus = rewardAccrualStatus(this.state, resolution.reason, resolution.configs);
    // Persist the boundary AND every new pending intent before any command
    // submit. A worker death can therefore only undercount, never duplicate.
    await this.persistInternal();
    if (await this.settlePendingInternal()) await this.persistInternal();
    this.lastStatus = rewardAccrualStatus(this.state, resolution.reason, resolution.configs);
  }

  checkpoint(at: number = this.now()): Promise<void> {
    const observed = Number.isFinite(at) && at > 0 ? at : this.now();
    const result = this.queue.then(() => this.checkpointInternal(observed));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async statusInternal(): Promise<RewardAccrualStatus> {
    const state = await this.ensureLoaded();
    return this.lastStatus ?? rewardAccrualStatus(state, 'unknown', this.lastConfigs);
  }

  status(): Promise<RewardAccrualStatus> {
    const result = this.queue.then(() => this.statusInternal());
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
