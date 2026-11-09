import { activeAllowanceRelief, type AllowanceCommand } from '../shared/allowance-state';
import type { AllowanceResponse } from '../shared/messages';
import { getLiveAllowanceAuthority, isAllowanceAuthorityInitializing, submitCompanionAllowanceCommand } from './companion';
import {
  allowanceLocalDayKey,
  getLocalAllowanceAuthority,
  submitLocalAllowanceCommand,
} from '../shared/allowance-store';

const lastOpeningActivity = new Map<string, number>();
const OPENING_ACTIVITY_INTERVAL_MS = 5_000;

/** Extension fallback entry point. The daemon dispatcher replaces this source
 * selection only after a real additive authority observation exists; an older
 * companion or a disconnected port can never masquerade as synchronization. */
export async function getAllowanceResponse(): Promise<AllowanceResponse> {
  if (isAllowanceAuthorityInitializing()) {
    return { ok: true, source: 'pending', state: await getLocalAllowanceAuthority() };
  }
  const daemon = getLiveAllowanceAuthority();
  if (daemon) return { ok: true, source: 'daemon', state: daemon };
  return { ok: true, source: 'fallback', state: await getLocalAllowanceAuthority() };
}

export async function submitAllowanceCommand(
  command: AllowanceCommand,
): Promise<AllowanceResponse> {
  const daemon = await submitCompanionAllowanceCommand(command);
  if (daemon) return daemon;
  const applied = await submitLocalAllowanceCommand(command);
  return {
    ok: applied.ok,
    source: 'fallback',
    state: applied.state,
    duplicate: applied.ok ? applied.duplicate : undefined,
    reason: applied.ok ? undefined : applied.reason,
  };
}

export async function allowanceReliefForCategory(category: string) {
  const nowMs = Date.now();
  const daemon = getLiveAllowanceAuthority();
  const state = daemon ?? await getLocalAllowanceAuthority();
  return activeAllowanceRelief(state, category, {
    nowMs,
    dayKey: allowanceLocalDayKey(new Date(nowMs)),
  });
}

/** A matching active opening observes real classified activity, throttled to
 * one command every five seconds per grant. Only the authorized command path
 * can advance its durable lastActivity timestamp. */
export async function recordAllowanceActivity(category: string): Promise<void> {
  const relief = await allowanceReliefForCategory(category);
  if (relief?.kind !== 'opening') return;
  const now = Date.now();
  const previous = lastOpeningActivity.get(relief.id) ?? 0;
  if (now - previous < OPENING_ACTIVITY_INTERVAL_MS) return;
  lastOpeningActivity.set(relief.id, now);
  await submitAllowanceCommand({
    kind: 'opening-activity',
    operationId: crypto.randomUUID().replaceAll('-', ''),
    category,
    grantId: relief.id,
    nowMs: now,
    dayKey: allowanceLocalDayKey(new Date(now)),
  });
}
