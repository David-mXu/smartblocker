// Pure auto-resume time math — the "autostart-resume" feature (Phase 5
// batch 1; Cold Turkey "Autostart Blocks", see docs/audits/2026-11-07-
// cold-turkey-blocker-landscape-audit.md §1.3): optionally re-enable blocking
// after the user turned the master toggle off, closing the "I forgot to turn
// it back on" relapse path.
//
// Like lock-math.ts: no browser APIs, no storage, no non-erasable TS syntax
// (enums, parameter properties) — scripts/resume-test.mjs imports this file
// directly under Node type stripping. The ONE import below carries an
// explicit ".ts" extension for exactly that reason: Node resolves
// './lock-math.ts'
// but not the extensionless './lock-math' (tsconfig gained
// `allowImportingTsExtensions` for exactly this; Vite resolves both forms).
// Only PUBLIC lock-math exports are consumed — the schedule evaluation
// (overnight windows, timezone pins) stays single-sourced in lock-math.ts.
import { nextWindowStart } from './lock-math.ts';
import type { ScheduleRule } from './lock-math.ts';

/** How an armed resume fires when the master toggle is off. */
export type ResumeMode = 'off' | 'startup' | 'schedule' | 'time';

export interface ResumePlan {
  mode: ResumeMode;
  /** Epoch ms, meaningful only under mode === 'time'. */
  resumeAt: number | null;
}

/** 'time'-mode resume instants are never scheduled more than 24h ahead —
 *  the feature closes a same-day relapse path, not a long-range one, and an
 *  unbounded horizon would turn a forgotten resume into a surprise. */
export const MAX_RESUME_AHEAD_MS = 24 * 3_600_000;

/** chrome.alarms entry used for time/schedule resumes (one-shot). */
export const RESUME_ALARM_NAME = 'resume-at';

/** Coerce a stored (or devtools-edited) value into a valid mode. Unknown
 *  values degrade to 'off' (inert) rather than throwing or guessing. */
export function normalizeResumeMode(raw: unknown): ResumeMode {
  return raw === 'startup' || raw === 'schedule' || raw === 'time' ? raw : 'off';
}

/** Validate + clamp a candidate 'time'-mode instant against `now`: anything
 *  that is not a positive finite number becomes null (disarm, never guess a
 *  time), anything beyond the 24h horizon is pinned to the horizon. Applied
 *  centrally at write time (settings.ts setSettings) and re-applied by
 *  nextResumeAt so a storage-tampered value still cannot bypass the cap. */
export function clampResumeAt(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), now + MAX_RESUME_AHEAD_MS);
}

/** The next scheduled-block START instant strictly after `now`, or null when
 *  the rules never start one (empty list / no future windows — the "no
 *  schedule" case, where a schedule-mode plan is inert by construction).
 *
 *  Deliberately ignores a rule's settings-lock lead time: "resume when
 *  focus hours begin" means the real window start, not the earlier lead
 *  freeze (which does not force blocking). `nextWindowStart` shares the
 *  exact overnight/timezone-pin evaluation with lock-math. */
export function nextScheduleStart(rules: ScheduleRule[], now: number): number | null {
  return nextWindowStart(rules, now);
}

/** The epoch ms at which an armed resume plan should fire, or null when the
 *  plan has no clock trigger:
 *  - 'off' (or unknown): never fires.
 *  - 'startup': event-driven (browser-session start), no clock time — the
 *    background registers the startup listeners itself.
 *  - 'time': the clamped `resumeAt`; a past instant clamps to `now`, which
 *    encodes missed-while-asleep semantics (fire at the first opportunity).
 *  - 'schedule': the next scheduled-block START from the lockState rules;
 *    null when there are no schedules.
 *  Pass the CURRENT lockState schedules; callers pass Date.now(). */
export function nextResumeAt(plan: ResumePlan, rules: ScheduleRule[], now: number): number | null {
  const mode = normalizeResumeMode(plan.mode);
  if (mode === 'time') {
    const t = clampResumeAt(plan.resumeAt, now);
    if (t === null) return null;
    return t <= now ? now : t;
  }
  if (mode === 'schedule') return nextScheduleStart(rules, now);
  return null;
}
