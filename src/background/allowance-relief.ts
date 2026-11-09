import {
  classifierReliefAllowed,
  type CategoryScheduleEffect,
} from '../shared/category-schedule-math';
import type { AllowanceGrant } from '../shared/allowance-math';
import type { LockStatus } from '../shared/lock-math';

export interface AllowanceReliefDependencies {
  reliefForCategory: (label: string) => Promise<AllowanceGrant | null>;
  recordActivity: (label: string) => Promise<void>;
  warn?: (message: string, error: unknown) => void;
}

/** Item10 relief weakens only a real classifier verdict. Hard locks and active
 * scoped schedule blocks return before any authority read, so neither relief
 * nor activity observation can run for a page they still own. A relieved page
 * is also activity: limited openings must not idle out while the user is using
 * the category they were granted. Observation errors preserve the class verdict
 * instead of failing open or closed. */
export async function applyAllowanceRelief(
  label: string,
  blocked: boolean,
  lock: Pick<LockStatus, 'forceBlocking' | 'reasons'>,
  scheduleEffect: CategoryScheduleEffect,
  dependencies: AllowanceReliefDependencies,
): Promise<boolean> {
  if (!classifierReliefAllowed(lock, scheduleEffect)) return blocked;
  let next = blocked;
  try {
    if (next && (await dependencies.reliefForCategory(label))) next = false;
    if (!next) await dependencies.recordActivity(label);
  } catch (error) {
    (dependencies.warn ?? ((message, cause) => console.warn(message, cause)))(
      '[SmartBlocker] allowance relief/observation failed:',
      error,
    );
  }
  return next;
}
