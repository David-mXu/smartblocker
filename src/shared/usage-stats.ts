// Usage stats store: per-day, per-hostname visit counts + focused time,
// powering the options page's Habits dashboard and suggestions engine.
//
// Privacy stance matches feedback.ts: hostname only — never full URLs, never
// page titles. Everything stays in storage.local; usage data is NEVER part of
// the opt-in feedback upload (see PRIVACY.md). Written only when the opt-in
// `trackUsage` setting is on (default OFF).
//
// Mirrors the settings.ts/feedback.ts pattern: one in-memory cache
// invalidated via storage.onChanged so long-lived contexts stay coherent.
import { api } from './api';

/** Pseudo-label for whitelisted domains — they're never classified. */
export const WHITELISTED_LABEL = 'whitelisted';
/** Pseudo-label for deterministic blocklist hits — the ML classifier is
 *  skipped, and per-rule labels would fragment the dashboard. */
export const BLOCKLISTED_LABEL = 'blocklisted';

export interface DomainDayStats {
  visits: number;
  focusMs: number;
  /** Last classified category for this domain that day (or `whitelisted`). */
  label: string;
}

/** hostname -> stats for one calendar day. */
export type UsageDay = Record<string, DomainDayStats>;
/** 'YYYY-MM-DD' (local time) -> that day's per-domain stats. */
export type UsageStats = Record<string, UsageDay>;

const STORAGE_KEY = 'usageStats';
const RETENTION_DAYS = 90;

let cache: UsageStats | null = null;
// Mutations are frequent (every navigation + focus change), so serialize the
// read-modify-write cycles; interleaved awaits would otherwise drop updates.
let writeChain: Promise<void> = Promise.resolve();

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) cache = null;
});

/** Local-time calendar day, so "today" matches what the user's clock says. */
export function dayKey(ts = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function load(): Promise<UsageStats> {
  if (cache !== null) return cache;
  const stored = await api.storage.local.get(STORAGE_KEY);
  cache = (stored[STORAGE_KEY] as UsageStats | undefined) ?? {};
  return cache;
}

async function save(stats: UsageStats): Promise<void> {
  // Prune days older than the retention window on every write.
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  for (const day of Object.keys(stats)) {
    if (day < cutoff) delete stats[day];
  }
  cache = stats;
  await api.storage.local.set({ [STORAGE_KEY]: stats });
}

function mutate(fn: (stats: UsageStats) => void): Promise<void> {
  writeChain = writeChain.then(async () => {
    const stats = await load();
    fn(stats);
    await save(stats);
  });
  return writeChain;
}

function bucket(stats: UsageStats, domain: string, label: string): DomainDayStats {
  const day = (stats[dayKey()] ??= {});
  const b = (day[domain] ??= { visits: 0, focusMs: 0, label });
  b.label = label; // last classified label wins for the day
  return b;
}

/** Count one navigation to `domain` classified as `label`. */
export async function recordVisit(domain: string, label: string): Promise<void> {
  if (!domain) return;
  await mutate((stats) => {
    bucket(stats, domain, label).visits += 1;
  });
}

/** Attribute `ms` of focused (active tab, non-idle) time to `domain`. */
export async function addFocusMs(domain: string, label: string, ms: number): Promise<void> {
  if (!domain || ms <= 0) return;
  await mutate((stats) => {
    bucket(stats, domain, label).focusMs += ms;
  });
}

/** Stats for the last `days` calendar days (today inclusive). */
export async function getUsage(days: number): Promise<UsageStats> {
  const all = await load();
  const cutoff = dayKey(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const out: UsageStats = {};
  for (const [day, entry] of Object.entries(all)) {
    if (day >= cutoff) out[day] = entry;
  }
  return out;
}

export async function clearUsage(): Promise<void> {
  await mutate((stats) => {
    for (const day of Object.keys(stats)) delete stats[day];
  });
}
