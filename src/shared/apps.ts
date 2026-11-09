// App-name normalization shared by the desktop companion UI, the profiles
// app-blocklist association, and the Native Messaging bridge. The companion
// matches lowercase exe stems ("steam", not "Steam.exe"), so everything a
// user types or pastes is reduced to that form before saving.

export type AppNameResult = { ok: true; value: string } | { ok: false; error: string };

const STEM_RE = /^[a-z0-9][a-z0-9 ._+-]{0,63}$/;

/** `"C:\Program Files\Steam\Steam.exe"` → `steam`. */
export function normalizeAppName(input: string): AppNameResult {
  let raw = input.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!raw) return { ok: false, error: 'Enter an app name, like steam' };
  raw = raw.split(/[\\/]/).pop() ?? raw;
  raw = raw.toLowerCase().replace(/\.exe$/, '').trim();
  if (!STEM_RE.test(raw)) {
    return { ok: false, error: `"${input.trim()}" doesn't look like an app name` };
  }
  return { ok: true, value: raw };
}

/** Split a pasted list (commas / new lines) into entries. */
export function splitAppNames(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Bound used by profile snapshots and the companion bridge. */
export const MAX_APP_BLOCKLIST = 100;

/**
 * Normalize an untrusted app list: trim/normalize each name, drop invalid
 * entries, dedupe case-insensitively, and bound the count. Used on storage
 * reads and on every bridge/protocol write so neither side can grow the list
 * without limit.
 */
export function normalizeAppBlocklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizeAppName(item);
    if (!normalized.ok) continue;
    if (seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    out.push(normalized.value);
    if (out.length >= MAX_APP_BLOCKLIST) break;
  }
  return out;
}

export function appBlocklistKey(apps: readonly string[]): string {
  return apps.join('\u0000');
}

export function appBlocklistEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const FRIENDLY: Record<string, string> = {
  '1password': '1Password',
  'battle.net': 'Battle.net',
  brave: 'Brave',
  chrome: 'Chrome',
  code: 'VS Code',
  discord: 'Discord',
  epicgameslauncher: 'Epic Games Launcher',
  firefox: 'Firefox',
  leagueclient: 'League of Legends',
  'ms-teams': 'Microsoft Teams',
  msedge: 'Edge',
  notion: 'Notion',
  obs64: 'OBS Studio',
  onedrive: 'OneDrive',
  opera: 'Opera',
  robloxplayerbeta: 'Roblox',
  slack: 'Slack',
  spotify: 'Spotify',
  steam: 'Steam',
  steamwebhelper: 'Steam (web helper)',
  telegram: 'Telegram',
  vivaldi: 'Vivaldi',
  whatsapp: 'WhatsApp',
  windowsterminal: 'Windows Terminal',
  zoom: 'Zoom',
  'smartblocker-daemon': 'SmartBlocker',
};

/** Human name for prose ("Closed Steam"); falls back to a capitalized stem. */
export function friendlyAppName(stem: string): string {
  const key = stem.toLowerCase().replace(/\.exe$/, '');
  return FRIENDLY[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** "Steam, Discord + 1 more". */
export function summarizeApps(stems: string[], show = 2): string {
  const names = stems.slice(0, show).map(friendlyAppName);
  const rest = stems.length - names.length;
  return rest > 0 ? `${names.join(', ')} + ${rest} more` : names.join(', ');
}
