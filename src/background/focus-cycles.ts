import { api } from '../shared/api';
import { allowanceLocalDayKey } from '../shared/allowance-store';
import {
  normalizeCycleDurations,
  parseFocusCycleProgram,
  type FocusCycleMode,
  type FocusCycleProgram,
  type PendingCycleCommand,
} from '../shared/focus-cycle-types';
import type { FocusCycleResponse } from '../shared/messages';
import { getAllowanceResponse, submitAllowanceCommand } from './allowance';

const STORAGE_KEY = 'focusCycleProgram';
const ALARM = 'focus-cycle-boundary';
let program: FocusCycleProgram | null = null;
let ticking: Promise<void> | null = null;
let startingEpoch: number | null = null;
let operationEpoch = 0;
let lastIssue: string | null = null;

function id(): string { return crypto.randomUUID().replaceAll('-', ''); }
function clone(state: FocusCycleProgram): FocusCycleProgram {
  return { ...state, pendingCommand: state.pendingCommand ? { ...state.pendingCommand } : null };
}
/** Avoids control-flow narrowing of the module variable across async work. */
function currentProgramId(): string | null {
  return program ? program.id : null;
}
async function store(next: FocusCycleProgram | null): Promise<void> {
  if (next) {
    if (!parseFocusCycleProgram(next)) throw new Error('Invalid focus cycle state.');
    program = clone(next);
    await api.storage.local.set({ [STORAGE_KEY]: clone(next) });
  } else {
    program = null;
    await api.storage.local.remove(STORAGE_KEY);
  }
}
async function getProgram(): Promise<FocusCycleProgram | null> {
  if (program) return clone(program);
  const stored = await api.storage.local.get(STORAGE_KEY);
  program = parseFocusCycleProgram(stored[STORAGE_KEY]);
  return program ? clone(program) : null;
}
function issue(error: unknown): void {
  lastIssue = error instanceof Error ? error.message : String(error);
  console.warn('[SmartBlocker] focus cycle command failed:', lastIssue);
}
async function arm(state: FocusCycleProgram | null, now = Date.now(), retry = false): Promise<void> {
  if (!state) {
    await api.alarms.clear(ALARM);
  } else {
    await api.alarms.create(ALARM, { when: retry ? now + 5_000 : Math.max(now, state.stageEndsAtMs) });
  }
}
function response(ok: boolean, error?: string): FocusCycleResponse {
  return { ok, program: program ? clone(program) : null, error };
}
export async function getFocusCycleResponse(): Promise<FocusCycleResponse> {
  await getProgram();
  return response(true, lastIssue ?? undefined);
}

export async function startFocusCycle(input: {
  category: string; mode: FocusCycleMode; workMinutes: number; breakMinutes: number; cycles: number;
}): Promise<FocusCycleResponse> {
  if (startingEpoch !== null || program) return response(false, 'A focus or Pomodoro cycle is already active.');
  const epoch = ++operationEpoch;
  startingEpoch = epoch;
  // Only a program actually installed by this attempt may be cleared by its
  // failure path. A cancelled attempt that resumes after a newer successful
  // start must never wipe that newer program.
  let installedId: string | null = null;
  try {
    if (await getProgram()) return response(false, 'A focus or Pomodoro cycle is already active.');
    const authority = await getAllowanceResponse();
    if (epoch !== operationEpoch) return response(false, 'The start was cancelled.');
    if (!authority.ok || !authority.state?.categories[input.category]) {
      return response(false, 'Configure this category before starting a focus cycle.');
    }
    const normalized = normalizeCycleDurations(input.workMinutes * 60_000, input.breakMinutes * 60_000, input.cycles);
    const now = Date.now();
    const next: FocusCycleProgram = {
      version: 1, id: id(), category: input.category, mode: input.mode, stage: 'work',
      cycle: 1, totalCycles: input.mode === 'focus' ? 1 : normalized.totalCycles,
      workDurationMs: normalized.workDurationMs,
      breakDurationMs: normalized.breakDurationMs,
      stageEndsAtMs: now + normalized.workDurationMs,
      pendingCommand: {
        kind: 'reward', operationId: id(), nowMs: now + normalized.workDurationMs,
        dayKey: allowanceLocalDayKey(new Date(now + normalized.workDurationMs)),
        earnedMs: normalized.workDurationMs, grantId: id(),
      },
    };
    installedId = next.id;
    await store(next);
    if (epoch !== operationEpoch) {
      if (currentProgramId() === installedId) await store(null);
      return response(false, 'The start was cancelled.');
    }
    lastIssue = null;
    await arm(next, now);
    if (epoch !== operationEpoch) {
      if (currentProgramId() === installedId) await store(null);
      return response(false, 'The start was cancelled.');
    }
    return response(true);
  } catch (error) {
    if (epoch === operationEpoch && installedId !== null && currentProgramId() === installedId) {
      await store(null);
    }
    return response(false, error instanceof Error ? error.message : String(error));
  } finally {
    if (startingEpoch === epoch) startingEpoch = null;
  }
}

/** Future cycles stop. A started fixed grant retains its own persisted clock. */
export async function cancelFocusCycle(): Promise<FocusCycleResponse> {
  operationEpoch++;
  startingEpoch = null;
  await store(null);
  await api.alarms.clear(ALARM);
  lastIssue = null;
  return response(true);
}

async function rewardWork(): Promise<void> {
  const current = program;
  const pending = current?.pendingCommand;
  if (!current || !pending || pending.kind !== 'reward') return;
  const epoch = operationEpoch;
  const result = await submitAllowanceCommand({
    kind: 'reward', operationId: pending.operationId, category: current.category,
    grantId: pending.grantId, nowMs: pending.nowMs, dayKey: pending.dayKey,
    earnedMs: pending.earnedMs ?? current.workDurationMs,
  });
  if (!result.ok && (result.reason === 'clock-rollback' || result.reason === 'day-rollback')) {
    // This stage ended without our command having reached authority. A later
    // observation makes replay illegal: abandon the reward, do not invent one.
    await advanceAfterBreak(Date.now());
    return;
  }
  if (!result.ok) throw new Error(result.error ?? result.reason ?? 'Reward was refused.');
  if (epoch !== operationEpoch || program?.id !== current.id) return;
  await store({ ...current, pendingCommand: null });
}

async function startBreak(now: number): Promise<void> {
  const current = program;
  const epoch = operationEpoch;
  if (!current) return;
  if (current.stage === 'work' && now >= current.stageEndsAtMs + current.breakDurationMs) {
    await advanceAfterBreak(now);
    return;
  }
  let pending: PendingCycleCommand | null = current.pendingCommand;
  if (!pending || pending.kind !== 'pomodoro-start') {
    const breakEndsAt = current.stageEndsAtMs + current.breakDurationMs;
    pending = {
      kind: 'pomodoro-start', operationId: id(), nowMs: now,
      dayKey: allowanceLocalDayKey(new Date(now)),
      durationMs: breakEndsAt - now, grantId: id(),
    };
  }
  if (pending.durationMs === undefined) throw new Error('Pomodoro duration is missing.');
  await store({ ...current, stage: 'break', stageEndsAtMs: pending.nowMs + pending.durationMs, pendingCommand: pending });
  const result = await submitAllowanceCommand({
    kind: 'pomodoro-start', operationId: pending.operationId, category: current.category,
    grantId: pending.grantId, nowMs: pending.nowMs, dayKey: pending.dayKey,
    durationMs: pending.durationMs,
  });
  if (!result.ok && (result.reason === 'clock-rollback' || result.reason === 'day-rollback')) {
    // The opportunity had already ended/rolled back before command settlement.
    // Skip this fixed break; do not compound it into a later legal overlap.
    await advanceAfterBreak(now);
    return;
  }
  if (!result.ok) throw new Error(result.error ?? result.reason ?? 'Pomodoro relief was refused.');
  if (epoch !== operationEpoch || program?.id !== current.id) return;
  await store({ ...(program as FocusCycleProgram), pendingCommand: null });
}

async function advanceAfterBreak(now: number): Promise<void> {
  const current = program;
  if (!current) return;
  if (current.mode === 'focus' || current.cycle >= current.totalCycles) {
    await store(null);
    return;
  }
  const nextWorkEnd = now + current.workDurationMs;
  await store({
    ...current, stage: 'work', cycle: current.cycle + 1, stageEndsAtMs: nextWorkEnd,
    pendingCommand: {
      kind: 'reward', operationId: id(), nowMs: nextWorkEnd,
      dayKey: allowanceLocalDayKey(new Date(nextWorkEnd)),
      earnedMs: current.workDurationMs, grantId: id(),
    },
  });
}

async function runTick(): Promise<void> {
  const epoch = operationEpoch;
  const current = await getProgram();
  if (!current) {
    await arm(null);
    return;
  }
  const now = Date.now();
  if (now < current.stageEndsAtMs) {
    await arm(current, now);
    return;
  }
  if (current.stage === 'work') {
    await rewardWork();
    if (epoch !== operationEpoch || !program || program.id !== current.id) return;
    if (current.mode === 'focus') {
      await store(null);
      await arm(null, now);
      return;
    }
    await startBreak(now);
  } else if (current.pendingCommand) {
    await startBreak(now);
  }
  if (!program || program.id !== current.id) return;
  // startBreak stores a NEW stage. Its older work snapshot must not make the
  // scheduler immediately advance again before the fixed break has ended.
  if (epoch !== operationEpoch) return;
  const latest = program;
  if (latest?.mode === 'pomodoro' && latest.stage === 'break' && now >= latest.stageEndsAtMs) {
    await advanceAfterBreak(now);
  }
  await arm(program, now);
}

async function tick(): Promise<void> {
  if (ticking) return ticking;
  ticking = runTick().catch(async (error) => {
    issue(error);
    await arm(program, Date.now(), true);
  }).finally(() => {
    ticking = null;
  });
  return ticking;
}

export function initFocusCycleScheduler(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void tick();
  });
  void tick();
}

export type { FocusCycleProgram, FocusCycleMode };
export const __runFocusCycleForTest = tick;
