/**
 * User-facing category wording, shared by popup, options and the welcome
 * wizard. Labels are STORED lowercase (they are fed to the classifier
 * verbatim), so display fixes acronyms and, at the start of a line, applies
 * sentence case. Internal "neutral: " prefixes never reach the UI.
 */

export const NEUTRAL_LABEL_PREFIX = 'neutral: ';

const ACRONYMS: Record<string, string> = { tv: 'TV', ai: 'AI', diy: 'DIY', nba: 'NBA', nfl: 'NFL', f1: 'F1' };

/** Mid-sentence form: "movies and tv shows" → "movies and TV shows". */
export function inlineLabel(label: string): string {
  const raw = label.startsWith(NEUTRAL_LABEL_PREFIX) ? label.slice(NEUTRAL_LABEL_PREFIX.length) : label;
  return raw
    .split(' ')
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ');
}

/** Line-start form: "movies and tv shows" → "Movies and TV shows". */
export function displayLabel(label: string): string {
  const text = inlineLabel(label);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
