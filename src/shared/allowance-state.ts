// Pure collection/command boundary for item 10. The daemon and the
// extension-only fallback apply the SAME commands; neither accepts a browser-
// supplied replacement balance as an ordinary intent.

import {
  addReward,
  cancelAllowanceGrant,
  closeOpening,
  createEmptyAllowanceLedger,
  normalizeAllowanceConfig,
  normalizeAllowanceLedger,
  recordOpeningActivity,
  requestAllowance,
  startOpening,
  startPomodoro,
  type AllowanceConfig,
  type AllowanceGrant,
  type AllowanceLedger,
  type AllowanceRefusalReason,
} from './allowance-math.ts';

export const ALLOWANCE_STATE_VERSION = 1;
export const MAX_ALLOWANCE_CATEGORIES = 64;

export interface AllowanceCategoryState {
  config: AllowanceConfig;
  ledger: AllowanceLedger;
}

export interface AllowanceOperationReceipt {
  operationId: string;
  fingerprint: string;
  revision: number;
}

export interface AllowanceAuthorityState {
  version: typeof ALLOWANCE_STATE_VERSION;
  revision: number;
  categories: Record<string, AllowanceCategoryState>;
  /** Last 64 acknowledged commands, persisted atomically with their result. */
  receipts: AllowanceOperationReceipt[];
}

interface AllowanceObservationInput {
  operationId: string;
  category: string;
  grantId: string;
  nowMs: number;
  dayKey: string;
}

export type AllowanceCommand =
  | ({ kind: 'configure'; config: AllowanceConfig } & Pick<AllowanceObservationInput, 'operationId' | 'category'>)
  | ({ kind: 'request'; durationMs: number } & AllowanceObservationInput)
  | ({ kind: 'cancel' } & AllowanceObservationInput)
  | ({ kind: 'reward'; earnedMs: number } & AllowanceObservationInput)
  | ({ kind: 'opening-start' } & AllowanceObservationInput)
  | ({ kind: 'opening-activity' } & AllowanceObservationInput)
  | ({ kind: 'opening-close' } & AllowanceObservationInput)
  | ({ kind: 'pomodoro-start'; durationMs: number } & AllowanceObservationInput);

export type AllowanceCommandRefusal =
  | AllowanceRefusalReason
  | 'invalid-operation'
  | 'invalid-category'
  | 'category-limit'
  | 'version'
  | 'revision'
  | 'duplicate-operation'
  | 'locked'
  | 'persistence';

export type AllowanceCommandResult =
  | {
      ok: true;
      state: AllowanceAuthorityState;
      kind: AllowanceCommand['kind'];
      category: string;
      grant: AllowanceGrant | null;
      /** True only when a matching persisted idempotency receipt was replayed. */
      duplicate?: boolean;
    }
  | {
      ok: false;
      state: AllowanceAuthorityState;
      reason: AllowanceCommandRefusal;
    };

export function emptyAllowanceAuthorityState(revision = 0): AllowanceAuthorityState {
  if (!Number.isSafeInteger(revision) || revision < 0) revision = 0;
  return { version: ALLOWANCE_STATE_VERSION, revision, categories: {}, receipts: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validAllowanceCategory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    value.trim() === value
  );
}

function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,64}$/.test(value);
}

function normalizeCategory(value: unknown): AllowanceCategoryState | null {
  if (!isRecord(value) || !validDayKey(value.ledger)) return null;
  return {
    config: normalizeAllowanceConfig(value.config),
    ledger: value.ledger as unknown as AllowanceLedger,
  };
}

function validDayKey(value: unknown): boolean {
  return isRecord(value) && typeof value.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.dayKey);
}

/** Only authority snapshots with valid top-level bounds enter the reducer.
 * Category grants themselves are sanitized at the observation time by the
 * primitive, which deliberately discards unsafe live relief without changing
 * already-spent counters. */
export function normalizeAllowanceAuthorityState(raw: unknown): AllowanceAuthorityState | null {
  if (!isRecord(raw) || raw.version !== ALLOWANCE_STATE_VERSION) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (!isRecord(raw.categories) || Object.keys(raw.categories).length > MAX_ALLOWANCE_CATEGORIES) {
    return null;
  }
  const categories: Record<string, AllowanceCategoryState> = {};
  for (const [category, value] of Object.entries(raw.categories)) {
    if (!validAllowanceCategory(category)) return null;
    const clean = normalizeCategory(value);
    if (!clean) return null;
    categories[category] = clean;
  }
  if (raw.receipts !== undefined && !Array.isArray(raw.receipts)) return null;
  const rawReceipts = (raw.receipts ?? []) as unknown[];
  if (rawReceipts.length > 64) return null;
  const seen = new Set<string>();
  const receipts: AllowanceOperationReceipt[] = [];
  for (const value of rawReceipts) {
    if (
      !isRecord(value) ||
      !validOperationId(value.operationId) ||
      typeof value.fingerprint !== 'string' ||
      value.fingerprint.length === 0 ||
      value.fingerprint.length > 4096 ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) <= 0 ||
      (value.revision as number) > (raw.revision as number) ||
      seen.has(value.operationId as string)
    ) {
      return null;
    }
    seen.add(value.operationId as string);
    receipts.push({
      operationId: value.operationId as string,
      fingerprint: value.fingerprint,
      revision: value.revision as number,
    });
  }
  return {
    version: ALLOWANCE_STATE_VERSION,
    revision: raw.revision as number,
    categories,
    receipts,
  };
}

export function cloneAllowanceAuthorityState(state: AllowanceAuthorityState): AllowanceAuthorityState {
  return {
    version: ALLOWANCE_STATE_VERSION,
    revision: state.revision,
    categories: Object.fromEntries(
      Object.entries(state.categories).map(([category, value]) => [
        category,
        {
          config: { ...value.config },
          ledger: { ...value.ledger, grant: value.ledger.grant ? { ...value.ledger.grant } : null },
        },
      ]),
    ),
    receipts: state.receipts.map((receipt) => ({ ...receipt })),
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Stable content identity for reconciliation. Revision numbers alone cannot
 * distinguish two peers that each applied a different command at the same
 * revision, so the complete normalized snapshot (including receipt history)
 * is compared deterministically. */
export function allowanceStateIdentity(raw: unknown): string | null {
  const state = normalizeAllowanceAuthorityState(raw);
  return state ? canonicalJson(state) : null;
}

/** True when this snapshot contains an acknowledged operation absent from the
 * other snapshot. At an equal revision that means this side holds a local
 * transition the other side never saw; replacing it would silently discard
 * offline allowance consumption. */
export function allowanceStateHasLocalOnlyReceipts(rawLocal: unknown, rawOther: unknown): boolean {
  const local = normalizeAllowanceAuthorityState(rawLocal);
  const other = normalizeAllowanceAuthorityState(rawOther);
  if (!local || !other) return false;
  const known = new Set(other.receipts.map((receipt) => receipt.operationId));
  return local.receipts.some((receipt) => !known.has(receipt.operationId));
}

/** A persisted, acknowledged command-id prefix per category/day lets fallback
 * storage de-duplicate retries without keeping an unlimited operation log.
 * The daemon may additionally keep its own short idempotency receipt cache. */
export function allowanceOperationKey(command: AllowanceCommand): string | null {
  const at = command as Partial<AllowanceObservationInput>;
  return typeof at.dayKey === 'string' && validOperationId(command.operationId)
    ? `${command.category}:${at.dayKey}:${command.operationId}`
    : null;
}

function fingerprintAllowanceCommand(command: AllowanceCommand): string {
  const raw = command as unknown as Record<string, unknown>;
  return JSON.stringify([
    command.kind,
    command.operationId,
    command.category,
    raw.grantId ?? null,
    raw.nowMs ?? null,
    raw.dayKey ?? null,
    raw.durationMs ?? null,
    raw.earnedMs ?? null,
    command.kind === 'configure' ? normalizeAllowanceConfig(command.config) : null,
  ]);
}

function refusal(
  state: AllowanceAuthorityState,
  reason: AllowanceCommandRefusal,
): AllowanceCommandResult {
  return { ok: false, state, reason };
}

function observation(command: AllowanceCommand): AllowanceObservationInput {
  return command as AllowanceObservationInput;
}

/** Apply one authenticated command without assigning its revision. That is
 * the persistence owner's job after the whole transition is valid. */
export function applyAllowanceCommand(
  rawState: unknown,
  command: AllowanceCommand,
  expectedRevision?: number,
): AllowanceCommandResult {
  const normalized = normalizeAllowanceAuthorityState(rawState);
  if (!normalized) return refusal(emptyAllowanceAuthorityState(), 'version');
  const state = cloneAllowanceAuthorityState(normalized);
  if (!validOperationId(command.operationId)) return refusal(state, 'invalid-operation');
  if (!validAllowanceCategory(command.category)) return refusal(state, 'invalid-category');
  const fingerprint = fingerprintAllowanceCommand(command);
  const prior = state.receipts.find((receipt) => receipt.operationId === command.operationId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return refusal(state, 'duplicate-operation');
    return {
      ok: true,
      state,
      kind: command.kind,
      category: command.category,
      grant: null,
      duplicate: true,
    };
  }
  if (expectedRevision !== undefined && state.revision !== expectedRevision) {
    return refusal(state, 'revision');
  }
  if (allowanceOperationKey(command) === null && command.kind !== 'configure') {
    return refusal(state, 'invalid-operation');
  }

  if (command.kind === 'configure') {
    const config = normalizeAllowanceConfig(command.config);
    const existing = state.categories[command.category];
    if (!existing && Object.keys(state.categories).length >= MAX_ALLOWANCE_CATEGORIES) {
      return refusal(state, 'category-limit');
    }
    // Configuration normalization is deterministic. Advancing time happens on
    // actual observations, so config edits cannot manufacture elapsed usage.
    state.categories[command.category] = {
      config,
      ledger: existing?.ledger ?? createEmptyAllowanceLedger({ nowMs: 0, dayKey: '1970-01-01' }),
    };
    return { ok: true, state, kind: command.kind, category: command.category, grant: null };
  }

  const action = observation(command);
  const current = state.categories[command.category];
  if (!current) return refusal(state, 'invalid-category');
  const at = { nowMs: action.nowMs, dayKey: action.dayKey };
  const normalizedLedger = normalizeAllowanceLedger(current.ledger, current.config, at);
  const makeAction = { grantId: action.grantId, ...at };
  let result;
  switch (command.kind) {
    case 'request':
      result = requestAllowance(normalizedLedger, current.config, { ...makeAction, durationMs: command.durationMs });
      break;
    case 'cancel':
      result = cancelAllowanceGrant(normalizedLedger, current.config, makeAction);
      break;
    case 'reward':
      result = addReward(normalizedLedger, current.config, { ...at, earnedMs: command.earnedMs });
      break;
    case 'opening-start':
      result = startOpening(normalizedLedger, current.config, makeAction);
      break;
    case 'opening-activity':
      result = recordOpeningActivity(normalizedLedger, current.config, makeAction);
      break;
    case 'opening-close':
      result = closeOpening(normalizedLedger, current.config, makeAction);
      break;
    case 'pomodoro-start':
      result = startPomodoro(normalizedLedger, current.config, { ...makeAction, durationMs: command.durationMs });
      break;
    default:
      return refusal(state, 'invalid-operation');
  }
  if (!result.ok) return refusal(state, result.reason);
  state.categories[command.category] = { config: current.config, ledger: result.ledger };
  return { ok: true, state, kind: command.kind, category: command.category, grant: result.grant };
}

/** Revision assignment is deliberately separate from command validation so a
 * daemon/fallback can persist first and publish exactly the acknowledged
 * revision. The returned object never aliases the accepted command result. */
export function commitAllowanceCommandRevision(
  state: AllowanceAuthorityState,
  revision: number,
  command?: AllowanceCommand,
): AllowanceAuthorityState {
  if (!Number.isSafeInteger(revision) || revision <= state.revision) {
    throw new Error('Allowance revisions must increase within the JavaScript safe-integer range.');
  }
  const next = cloneAllowanceAuthorityState(state);
  next.revision = revision;
  if (command) {
    next.receipts.push({
      operationId: command.operationId as string,
      fingerprint: fingerprintAllowanceCommand(command),
      revision,
    });
    next.receipts = next.receipts.slice(-64);
  }
  return next;
}

/** The next moment when authority could change an existing relief decision.
 * This is read-only: it never changes counters or grants and returns no expired
 * candidate, so a stalled worker cannot mistake a deadline for live relief. */
export function nextAllowanceBoundary(rawState: unknown, nowMs: number): number | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const state = normalizeAllowanceAuthorityState(rawState);
  if (!state) return null;
  const future = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > nowMs;
  const local = new Date(nowMs);
  let next: number | null = new Date(
    local.getFullYear(), local.getMonth(), local.getDate() + 1,
  ).getTime();
  for (const { config, ledger } of Object.values(state.categories)) {
    const grant = ledger.grant;
    if (!grant || grant.status === 'ended' || grant.status === 'idle-closed') continue;
    const candidates: unknown[] = [];
    if (grant.kind === 'allowance' && grant.status === 'pending') candidates.push(grant.notBeforeMs);
    candidates.push(grant.endsAtMs);
    if (grant.kind === 'opening') {
      candidates.push(Math.max(grant.notBeforeMs, grant.lastActivityAtMs ?? grant.notBeforeMs) + (config.openingInactivityMs ?? 120_000));
    }
    for (const candidate of candidates) {
      if (future(candidate) && (next === null || candidate < next)) next = candidate;
    }
  }
  return next;
}

/** Read-only blocker relief. Only a live grant for the page's PRIMARY category
 * can relax a classifier decision; reads never edit or prematurely settle the
 * persisted spent counter, so repeated visits cannot prolong or double-charge. */
export function activeAllowanceRelief(
  rawState: unknown,
  category: string,
  at: { nowMs: number; dayKey: string },
): AllowanceGrant | null {
  const current = deriveAllowanceCategory(rawState, category, at);
  const grant = current?.ledger.grant;
  if (!grant || grant.status !== 'active') return null;
  return { ...grant };
}

export function deriveAllowanceCategory(
  rawState: unknown,
  category: string,
  at: { nowMs: number; dayKey: string },
): { config: AllowanceConfig; ledger: AllowanceLedger } | null {
  const state = normalizeAllowanceAuthorityState(rawState);
  const current = state?.categories[category];
  if (!current) return null;
  return {
    config: current.config,
    ledger: normalizeAllowanceLedger(current.ledger, current.config, at),
  };
}
