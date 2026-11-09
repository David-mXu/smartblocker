export type FocusCycleMode = 'focus' | 'pomodoro';
export type FocusCycleStage = 'work' | 'break';

export interface PendingCycleCommand {
  kind: 'reward' | 'pomodoro-start';
  operationId: string;
  nowMs: number;
  dayKey: string;
  earnedMs?: number;
  durationMs?: number;
  grantId: string;
}

export interface FocusCycleProgram {
  version: 1;
  id: string;
  category: string;
  mode: FocusCycleMode;
  stage: FocusCycleStage;
  cycle: number;
  totalCycles: number;
  workDurationMs: number;
  breakDurationMs: number;
  stageEndsAtMs: number;
  pendingCommand: PendingCycleCommand | null;
}

const MAX_TIME = Number.MAX_SAFE_INTEGER;
const MAX_DURATION = 24 * 60 * 60 * 1000;
function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}
function safeDuration(value: unknown): value is number {
  return safeTime(value) && value > 0 && value <= MAX_DURATION;
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
function safeDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Untrusted persistent program parsing; no timers or rewards are derived from
 * arbitrary objects beyond this one fixed, bounded scheduler contract. */
export function parseFocusCycleProgram(value: unknown): FocusCycleProgram | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Partial<FocusCycleProgram>;
  if (
    p.version !== 1 || !safeId(p.id) || typeof p.category !== 'string' ||
    p.category.length === 0 || p.category.length > 64 || p.category.trim() !== p.category ||
    (p.mode !== 'focus' && p.mode !== 'pomodoro') ||
    (p.mode === 'focus' && p.stage !== 'work') ||
    (p.stage !== 'work' && p.stage !== 'break') ||
    !Number.isInteger(p.cycle) || (p.cycle as number) < 1 || (p.cycle as number) > 4 ||
    !Number.isInteger(p.totalCycles) || (p.totalCycles as number) < 1 || (p.totalCycles as number) > 4 ||
    (p.cycle as number) > (p.totalCycles as number) ||
    (p.mode === 'focus' && p.totalCycles !== 1) ||
    !safeDuration(p.workDurationMs) || !safeDuration(p.breakDurationMs) || !safeTime(p.stageEndsAtMs)
  ) {
    return null;
  }
  const pending = p.pendingCommand;
  if (pending !== null && pending !== undefined) {
    if (
      (pending.kind !== 'reward' && pending.kind !== 'pomodoro-start') ||
      !safeId(pending.operationId) || !safeId(pending.grantId) || !safeTime(pending.nowMs) || !safeDay(pending.dayKey) ||
      (pending.kind === 'reward' && pending.earnedMs !== p.workDurationMs) ||
      (pending.kind === 'pomodoro-start' &&
        (!safeDuration(pending.durationMs) || pending.durationMs > p.breakDurationMs))
    ) {
      return null;
    }
    if (pending.kind === 'reward' && pending.earnedMs === undefined) return null;
    if (pending.kind === 'pomodoro-start' && pending.durationMs === undefined) return null;
  }
  return { ...(p as FocusCycleProgram), pendingCommand: pending ? { ...pending } : null };
}

export function normalizeCycleDurations(workMs: number, breakMs: number, cycles: number) {
  if (!Number.isFinite(workMs) || workMs <= 0 || !Number.isFinite(breakMs) || breakMs <= 0) {
    throw new Error('Focus and break durations must be positive.');
  }
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 4) {
    throw new Error('Choose between 1 and 4 Pomodoro cycles.');
  }
  return {
    workDurationMs: Math.min(MAX_DURATION, Math.max(1, Math.floor(workMs))),
    breakDurationMs: Math.min(MAX_DURATION, Math.max(1, Math.floor(breakMs))),
    totalCycles: cycles,
  };
}
