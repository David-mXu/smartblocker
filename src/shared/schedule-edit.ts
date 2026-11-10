// Pure copy helpers for the schedule editor. Duplication is deliberately a
// plain value copy with a fresh identity: no evaluation fields are interpreted
// or re-derived here, so the copy stays exactly as valid as its source.
// Erasable syntax only (Node type-stripping tests import this directly).

import {
  MAX_SCHEDULE_LABEL_LENGTH,
  type ScheduleRule,
} from './lock-math.ts';

export const SCHEDULE_COPY_SUFFIX = ' (copy)';

export interface DuplicateScheduleOptions {
  /** Used when the source has no label ("Focus hours", "Category schedule"). */
  fallbackLabel?: string;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID(). */
  idFactory?: () => string;
}

function fitWithSuffix(stem: string, suffix: string, fallback: string): string {
  const room = Math.max(1, MAX_SCHEDULE_LABEL_LENGTH - suffix.length);
  const trimmed = (stem || fallback).slice(0, room).trimEnd();
  return `${trimmed || fallback.slice(0, room)}${suffix}`;
}

/** "Deep work" → "Deep work (copy)", then "(copy 2)", "(copy 3)"… */
export function nextScheduleCopyLabel(
  label: string | null | undefined,
  fallbackLabel = 'Schedule',
): string {
  const base = (typeof label === 'string' ? label.trim() : '') || fallbackLabel;
  const numbered = base.match(/^(.*) \(copy(?: (\d+))?\)$/);
  if (numbered) {
    const next = numbered[2] ? Number(numbered[2]) + 1 : 2;
    return fitWithSuffix(numbered[1], ` (copy ${next})`, fallbackLabel);
  }
  return fitWithSuffix(base, SCHEDULE_COPY_SUFFIX, fallbackLabel);
}

/** Copy a rule with a fresh id, a display-only "(copy)" label, and cloned
 *  arrays. start/end/lead/tz values are preserved exactly: the source is a
 *  validated rule, and duplication must not silently clamp a user's window. */
export function duplicateScheduleRule<T extends ScheduleRule>(
  rule: T,
  options: DuplicateScheduleOptions = {},
): T {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const copy = {
    ...rule,
    id: idFactory(),
    label: nextScheduleCopyLabel(rule.label, options.fallbackLabel ?? 'Schedule'),
    days: [...rule.days],
  } as T;
  const categories = (rule as ScheduleRule & { categories?: string[] }).categories;
  if (Array.isArray(categories)) {
    (copy as ScheduleRule & { categories?: string[] }).categories = [...categories];
  }
  return copy;
}
