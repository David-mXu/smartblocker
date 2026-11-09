// Pure category-scoped schedule policy. Legacy LockState.schedules remains the
// separate global forced-lock mechanism; this module never reads or writes it.
// Keep syntax erasable so the focused test script can import this file directly.

import {
  currentWindowEnd,
  type CategoryScheduleRule,
  type LockStatus,
} from './lock-math.ts';
import { shouldBlockClassifierVerdict } from './prototypes.ts';

export { validateCategoryScheduleRule } from './lock-math.ts';
export type { CategoryScheduleRule } from './lock-math.ts';

export interface CategoryScheduleVerdict {
  label: string;
  score: number;
  all?: { labels: string[]; scores: number[] };
}

export type CategoryScheduleEffect = 'active-block' | 'inactive-rescue' | 'none';

/** Item10 relaxation is a separate, weaker decision than ordinary classifier
 * blocking. It may never override hard locks or an active scoped schedule. */
export function classifierReliefAllowed(
  lock: Pick<LockStatus, 'forceBlocking' | 'reasons'>,
  effect: CategoryScheduleEffect,
): boolean {
  return !lock.forceBlocking && !lock.reasons.includes('password') && effect !== 'active-block';
}

export interface CategoryScheduleGateResult {
  blocked: boolean;
  /** The schedule branch that owned the decision, not necessarily a change. */
  effect: CategoryScheduleEffect;
  /** Complete active set for active-block, or matching inactive set for rescue. */
  categories: string[];
}

/** Category schema and validation live beside the base schedule schema in
 * lock-math.ts, so lock-state sanitization needs no import cycle. */

function uniqueCategories(rules: readonly CategoryScheduleRule[]): string[] {
  const categories = new Set<string>();
  for (const rule of rules) {
    for (const category of rule.categories) categories.add(category);
  }
  return [...categories];
}

/**
 * Apply category schedules to the normal CLASSIFIER decision for a top label.
 * Deterministic rules, master/break/allowance state, forced blocking, and
 * classifier-error policy deliberately remain the caller's responsibility.
 *
 * A matching active rule takes precedence over every inactive rule. It blocks
 * only when the ordinary classifier predicate accepts the verdict, using every
 * category in every active rule for the normal top-2 effective-mass behavior.
 * An already-normal blocked decision stays blocked under this branch. With no
 * matching active rule, any configured rule for the label rescues the normal
 * classifier block. Labels absent from every rule are returned unchanged.
 *
 * `effect` identifies the owning schedule branch even when its outcome equals
 * the input decision (including an active gate below the confidence threshold).
 * Inputs are only read; all returned category arrays are newly allocated.
 */
export function evaluateCategoryScheduleGate(
  verdict: CategoryScheduleVerdict,
  normallyBlocked: boolean,
  blockThreshold: number,
  rules: readonly CategoryScheduleRule[],
  now: Date,
): CategoryScheduleGateResult {
  const configuredRules = rules.filter((rule) => rule.categories.includes(verdict.label));
  if (configuredRules.length === 0) {
    return { blocked: normallyBlocked, effect: 'none', categories: [] };
  }

  // Reuse the one schedule engine so overnight and pinned-offset behavior stay
  // identical to legacy schedule windows. A one-element copy keeps this API
  // readonly without changing currentWindowEnd's established signature.
  const activeRules = rules.filter(
    (rule) => currentWindowEnd([rule], now) !== null,
  );

  if (activeRules.some((rule) => rule.categories.includes(verdict.label))) {
    const categories = uniqueCategories(activeRules);
    const activeBlocked = shouldBlockClassifierVerdict(
      verdict,
      categories,
      blockThreshold,
    );
    return {
      blocked: normallyBlocked || activeBlocked,
      effect: 'active-block',
      categories,
    };
  }

  return {
    blocked: false,
    effect: 'inactive-rescue',
    categories: uniqueCategories(configuredRules),
  };
}
