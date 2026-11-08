// Serialized persistence and recovery around the pure usage reducer. This
// module deliberately has no chrome/browser import, so its restart and write
// behavior can be tested with an in-memory StorageArea under Node.
import {
  buildUsageStatsExport,
  emptyUsageStatsState,
  recordUsageOverride,
  recordUsagePageSilenced,
  resetUsageCheckpoint,
  sanitizeUsageStatsState,
  transitionUsageCheckpoint,
  usageHostnameFromUrl,
  USAGE_STATS_STORAGE_KEY,
  USAGE_STATS_WRITE_BATCH_MS,
  type UsageStatsExport,
  type UsageStatsState,
  type UsageTarget,
} from '../shared/usage-stats';

export interface UsageStatsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface UsageTargetResolution {
  target: UsageTarget | null;
  /** True for idle/API loss: do not charge the uncertain preceding interval. */
  discardPrevious: boolean;
}

export type ResolveUsageTarget = () =>
  | UsageTargetResolution
  | Promise<UsageTargetResolution>;

interface CheckpointOptions {
  at?: number;
  discardPrevious?: boolean;
}

interface UsageEventInput {
  url: string;
  category: string;
}

interface SilencedEventInput extends UsageEventInput {
  decisionId: string;
}

export class UsageStatsTracker {
  storage: UsageStatsStorage;
  resolveTarget: ResolveUsageTarget;
  now: () => number;
  state: UsageStatsState | null = null;
  hasLiveCheckpoint = false;
  dirty = false;
  writeTimer: ReturnType<typeof setTimeout> | undefined;
  queue: Promise<void> = Promise.resolve();

  constructor(storage: UsageStatsStorage, resolveTarget: ResolveUsageTarget, now: () => number = Date.now) {
    this.storage = storage;
    this.resolveTarget = resolveTarget;
    this.now = now;
  }

  enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async ensureLoaded(): Promise<UsageStatsState> {
    if (this.state) return this.state;
    // A read failure is allowed to reject the operation: starting empty and
    // writing later would silently overwrite previously persisted aggregates.
    const stored = await this.storage.get(USAGE_STATS_STORAGE_KEY);
    this.state = sanitizeUsageStatsState(stored[USAGE_STATS_STORAGE_KEY]);
    // The first observation of every tracker instance is recovery-only. This
    // prevents both browser/SW shutdown gaps and overlapping old/new workers
    // from charging or double-charging the persisted segment.
    this.hasLiveCheckpoint = false;
    return this.state;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.enqueue(() => this.flushInternal()).catch((error) => {
        console.warn('[SmartBlocker] usage stats batch write failed:', error);
      });
    }, USAGE_STATS_WRITE_BATCH_MS);
  }

  async flushInternal(): Promise<void> {
    if (!this.dirty || !this.state) return;
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    try {
      // Aggregates and their checkpoint share one storage value/set: a worker
      // dying between two writes cannot commit time without advancing the
      // checkpoint, or advance the checkpoint without committing its time.
      await this.storage.set({ [USAGE_STATS_STORAGE_KEY]: this.state });
      this.dirty = false;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  async checkpointInternal(options: CheckpointOptions = {}): Promise<void> {
    const state = await this.ensureLoaded();
    const at = options.at ?? this.now();
    const resolution = await this.resolveTarget();
    this.state = transitionUsageCheckpoint(
      state,
      at,
      resolution.target,
      !this.hasLiveCheckpoint || options.discardPrevious === true || resolution.discardPrevious,
    );
    this.hasLiveCheckpoint = true;
    this.dirty = true;
    this.markDirty();
  }

  /** Observe the current focus/idle/tab boundary, closing the prior segment. */
  checkpoint(options: CheckpointOptions = {}): Promise<void> {
    // Capture the event's boundary when it is observed, not when earlier queue
    // work finishes. A slow storage read or verdict lookup must not stretch the
    // preceding active segment by the queueing delay.
    const observed = options.at === undefined ? { ...options, at: this.now() } : options;
    return this.enqueue(() => this.checkpointInternal(observed));
  }

  async recordSilencedInternal(input: SilencedEventInput, at: number): Promise<boolean> {
    const hostname = usageHostnameFromUrl(input.url);
    if (!hostname || !input.decisionId) return false;
    // Every counter event also settles time against the OLD target first.
    await this.checkpointInternal({ at });
    const previous = this.state as UsageStatsState;
    this.state = recordUsagePageSilenced(previous, {
      at,
      hostname,
      category: input.category,
      decisionId: input.decisionId,
    });
    if (this.state !== previous) this.markDirty();
    return this.state !== previous;
  }

  recordSilenced(input: SilencedEventInput, at: number = this.now()): Promise<boolean> {
    return this.enqueue(() => this.recordSilencedInternal(input, at));
  }

  async recordOverrideInternal(input: UsageEventInput, at: number): Promise<boolean> {
    const hostname = usageHostnameFromUrl(input.url);
    if (!hostname) return false;
    await this.checkpointInternal({ at });
    const previous = this.state as UsageStatsState;
    this.state = recordUsageOverride(previous, {
      at,
      hostname,
      category: input.category,
    });
    if (this.state !== previous) this.markDirty();
    return this.state !== previous;
  }

  recordOverride(input: UsageEventInput, at: number = this.now()): Promise<boolean> {
    return this.enqueue(() => this.recordOverrideInternal(input, at));
  }

  async snapshotInternal(at: number): Promise<UsageStatsExport> {
    await this.checkpointInternal({ at });
    await this.flushInternal();
    return buildUsageStatsExport(this.state as UsageStatsState, at);
  }

  snapshot(at: number = this.now()): Promise<UsageStatsExport> {
    return this.enqueue(() => this.snapshotInternal(at));
  }

  async clearInternal(at: number): Promise<UsageStatsExport> {
    await this.ensureLoaded();
    // Resolve where collection should resume, but deliberately do not settle
    // the pre-clear segment into the fresh generation. Commit the durable
    // removal before replacing in-memory state: if removal fails, the old data
    // remains both visible and retryable instead of disappearing only from UI.
    const resolution = await this.resolveTarget();
    await this.storage.remove(USAGE_STATS_STORAGE_KEY);
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    this.state = resetUsageCheckpoint(emptyUsageStatsState(), at, resolution.target);
    this.hasLiveCheckpoint = true;
    this.dirty = false;
    return buildUsageStatsExport(this.state, at);
  }

  clear(at: number = this.now()): Promise<UsageStatsExport> {
    return this.enqueue(() => this.clearInternal(at));
  }

  /** Test teardown; production lives for the service worker's lifetime. */
  dispose(): void {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }
}
