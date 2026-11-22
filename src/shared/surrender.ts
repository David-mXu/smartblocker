// Pure typed-surrender math for the opt-in non-locked override wall.
// No browser APIs, storage, or non-erasable TypeScript syntax: Node unit tests
// import this file directly under type stripping. The injected block screen
// mirrors these tiny calculations because executeScript serializes its function
// and cannot close over module imports.

export const SURRENDER_DELAY_MS = 15_000;
/** Cool-down tier: 10 seconds, no typing (validated by Android 17's Pause
 *  Point and the "delay, not moralizing" evidence). */
export const PAUSE_OVERRIDE_MS = 10_000;

export type OverrideFrictionMode = 'off' | 'pause' | 'phrase';

/** Sanitize a stored/imported mode. Unknown values fall back to 'off'. */
export function normalizeOverrideFriction(value: unknown): OverrideFrictionMode {
  return value === 'pause' || value === 'phrase' ? value : 'off';
}

/** True once the pause tier's cool-down has elapsed. */
export function pauseElapsed(now: number, armedAt: number): boolean {
  return now >= surrenderDeadline(armedAt, PAUSE_OVERRIDE_MS);
}
export const SURRENDER_PHRASE =
  'I am choosing to open this page for a good reason, and I will return to my task.';

/** Epoch ms at which a surrender attempt armed at `now` accepts input. */
export function surrenderDeadline(now: number, delayMs: number): number {
  return now + delayMs;
}

/** Exact phrase comparison; only surrounding whitespace is ignored. */
export function isPhraseMatch(input: string, phrase: string): boolean {
  return input.trim() === phrase;
}

/** Both gates must pass. The deadline start is inclusive. */
export function canSubmit(now: number, armedAt: number, phraseInput: string): boolean {
  return (
    now >= surrenderDeadline(armedAt, SURRENDER_DELAY_MS) &&
    isPhraseMatch(phraseInput, SURRENDER_PHRASE)
  );
}
