// Pure break-setting clamps and random-text proof helpers. No storage or
// lock imports: incorrect proof can never touch lock state through this module.

export type BreakMode = 'off' | 'delay' | 'random-text';

export const BREAK_DELAY_MINUTES_MIN = 0;
export const BREAK_DELAY_MINUTES_MAX = 60;
export const BREAK_DELAY_MINUTES_DEFAULT = 1;
export const BREAK_DURATION_MINUTES_MIN = 1;
export const BREAK_DURATION_MINUTES_MAX = 24 * 60;
export const BREAK_DURATION_MINUTES_DEFAULT = 10;
export const BREAK_TEXT_LENGTH_MIN = 10;
export const BREAK_TEXT_LENGTH_MAX = 1000;
export const BREAK_TEXT_LENGTH_DEFAULT = 100;

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function normalizeBreakMode(value: unknown): BreakMode {
  return value === 'delay' || value === 'random-text' ? value : 'off';
}

export function clampBreakDelayMinutes(value: unknown): number {
  return clampInteger(
    value,
    BREAK_DELAY_MINUTES_MIN,
    BREAK_DELAY_MINUTES_MAX,
    BREAK_DELAY_MINUTES_DEFAULT,
  );
}

export function clampBreakDurationMinutes(value: unknown): number {
  return clampInteger(
    value,
    BREAK_DURATION_MINUTES_MIN,
    BREAK_DURATION_MINUTES_MAX,
    BREAK_DURATION_MINUTES_DEFAULT,
  );
}

export function clampBreakTextLength(value: unknown): number {
  return clampInteger(value, BREAK_TEXT_LENGTH_MIN, BREAK_TEXT_LENGTH_MAX, BREAK_TEXT_LENGTH_DEFAULT);
}

// 32 symbols, so each random byte maps without modulo bias. Excludes 0/O/1/I.
const TEXT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generic CSPRNG proof text. Callers apply their own feature's length clamp;
 *  this keeps lock challenges (1–5,000) independent of break clamps. */
export function generateRandomText(length: number): string {
  if (!Number.isInteger(length) || length < 1) throw new Error('Text length must be positive.');
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const symbols = Array.from(bytes, (byte) => TEXT_ALPHABET[byte % TEXT_ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += 5) groups.push(symbols.slice(i, i + 5).join(''));
  return groups.join(' ');
}

/** CSPRNG uppercase text in groups of five. Length counts symbols, not spaces. */
export function generateBreakText(length: number): string {
  return generateRandomText(clampBreakTextLength(length));
}

/** Spaces are presentational and uppercase input avoids keyboard layout
 *  friction; every other typo still fails verification. */
export function normalizeRandomText(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '');
}

export function normalizeBreakText(value: string): string {
  return normalizeRandomText(value);
}

export function verifyRandomText(expected: string, actual: string): boolean {
  const a = normalizeRandomText(expected);
  const b = normalizeRandomText(actual);
  if (a.length !== b.length) return false;
  // Do not short-circuit on the first mismatch; the proof is not secret, but
  // this avoids teaching callers which prefix matched.
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function verifyBreakText(expected: string, actual: string): boolean {
  return verifyRandomText(expected, actual);
}
