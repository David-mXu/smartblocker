// Suggestions engine: turns local usage stats + feedback into whitelist /
// blocklist proposals the user explicitly accepts on the options page.
//
// Design rule (see ROADMAP Phase 2.9): implicit signals NEVER feed the
// centroids directly — visit frequency is anti-correlated with productivity
// for a distraction blocker's target user, and auto-learning from it would
// teach the model to accept bad habits. A suggestion only takes effect when
// the user applies it, and then only through the existing settings plumbing.
//
// Pure computation over the stores; no background job — the options page
// calls getSuggestions() on load.
import { api } from './api';
import { getFeedback } from './feedback';
import { NEUTRAL_PREFIX } from './prototypes';
import type { Settings } from './settings';
import { isWhitelisted, matchedBlocklistEntry } from './titles';
import { BLOCKLISTED_LABEL, WHITELISTED_LABEL, getUsage } from './usage-stats';

export interface Suggestion {
  kind: 'blocklist' | 'whitelist';
  domain: string;
  /** Human-readable evidence, e.g. "31 visits · 48 min focused this week — usually video games". */
  reason: string;
}

const WINDOW_DAYS = 7;
/** Blocklist evidence bar: this many visits OR this much focus in the window. */
const MIN_DISTRACTION_VISITS = 10;
const MIN_DISTRACTION_FOCUS_MS = 20 * 60 * 1000;
/** Whitelist evidence bar: repeated overrides, or heavy focus on a neutral domain. */
const MIN_OVERRIDES = 3;
const MIN_NEUTRAL_FOCUS_MS = 60 * 60 * 1000;
const MAX_PER_KIND = 5;

const DISMISSED_KEY = 'dismissedSuggestions';

function suggestionKey(kind: Suggestion['kind'], domain: string): string {
  return `${kind}:${domain}`;
}

async function getDismissed(): Promise<Set<string>> {
  const stored = await api.storage.local.get(DISMISSED_KEY);
  return new Set((stored[DISMISSED_KEY] as string[] | undefined) ?? []);
}

/** Persist a declined suggestion so it never nags again. */
export async function dismissSuggestion(kind: Suggestion['kind'], domain: string): Promise<void> {
  const dismissed = await getDismissed();
  dismissed.add(suggestionKey(kind, domain));
  await api.storage.local.set({ [DISMISSED_KEY]: [...dismissed] });
}

interface DomainRollup {
  visits: number;
  focusMs: number;
  /** Most-visited label across the window's days. */
  label: string;
}

async function rollupByDomain(): Promise<Map<string, DomainRollup>> {
  const usage = await getUsage(WINDOW_DAYS);
  const out = new Map<string, DomainRollup>();
  const labelWeight = new Map<string, Map<string, number>>();
  for (const day of Object.values(usage)) {
    for (const [domain, s] of Object.entries(day)) {
      const r = out.get(domain) ?? { visits: 0, focusMs: 0, label: s.label };
      r.visits += s.visits;
      r.focusMs += s.focusMs;
      out.set(domain, r);
      const weights = labelWeight.get(domain) ?? new Map<string, number>();
      weights.set(s.label, (weights.get(s.label) ?? 0) + s.visits + 1);
      labelWeight.set(domain, weights);
    }
  }
  for (const [domain, r] of out) {
    const weights = labelWeight.get(domain)!;
    r.label = [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.set(domain, r);
  }
  return out;
}

function minutes(ms: number): number {
  return Math.round(ms / 60000);
}

export async function getSuggestions(settings: Settings): Promise<Suggestion[]> {
  const [rollup, feedback, dismissed] = await Promise.all([
    rollupByDomain(),
    getFeedback(),
    getDismissed(),
  ]);

  const alreadyWhitelisted = (domain: string) =>
    isWhitelisted(`https://${domain}/`, settings.whitelist);
  const alreadyBlocklisted = (domain: string) =>
    matchedBlocklistEntry(`https://${domain}/`, null, settings.blocklist) !== null;

  const blocklist: Suggestion[] = [];
  const whitelist: Suggestion[] = [];

  // Distraction magnets: domains dominated by a blocked category with real
  // volume behind them — candidates for a deterministic blocklist rule.
  for (const [domain, r] of rollup) {
    if (r.label === WHITELISTED_LABEL || r.label === BLOCKLISTED_LABEL) continue;
    if (!settings.blockedLabels.includes(r.label)) continue;
    if (r.visits < MIN_DISTRACTION_VISITS && r.focusMs < MIN_DISTRACTION_FOCUS_MS) continue;
    if (alreadyBlocklisted(domain) || alreadyWhitelisted(domain)) continue;
    blocklist.push({
      kind: 'blocklist',
      domain,
      reason: `${r.visits} visits · ${minutes(r.focusMs)} min focused this week — usually ${r.label}`,
    });
  }

  // Repeated "this is actually productive" overrides: the user keeps rescuing
  // this domain from the classifier, so exempt it outright.
  const overridesByDomain = new Map<string, number>();
  for (const rec of feedback) {
    if (rec.kind === 'false_positive' && rec.domain) {
      overridesByDomain.set(rec.domain, (overridesByDomain.get(rec.domain) ?? 0) + 1);
    }
  }
  for (const [domain, n] of overridesByDomain) {
    if (n < MIN_OVERRIDES || alreadyWhitelisted(domain)) continue;
    whitelist.push({
      kind: 'whitelist',
      domain,
      reason: `you marked pages here "actually productive" ${n} times`,
    });
  }

  // Heavy focus on neutral-classified domains: clearly work for this user, so
  // skip classifying it at all (faster, and immune to future misfires).
  for (const [domain, r] of rollup) {
    if (!r.label.startsWith(NEUTRAL_PREFIX)) continue;
    if (r.focusMs < MIN_NEUTRAL_FOCUS_MS) continue;
    if (alreadyWhitelisted(domain) || whitelist.some((s) => s.domain === domain)) continue;
    whitelist.push({
      kind: 'whitelist',
      domain,
      reason: `${minutes(r.focusMs)} min of focused, productive-looking use this week`,
    });
  }

  const strongest = (a: Suggestion, b: Suggestion) => {
    const w = (s: Suggestion) => rollup.get(s.domain)?.focusMs ?? 0;
    return w(b) - w(a);
  };
  return [
    ...blocklist.sort(strongest).slice(0, MAX_PER_KIND),
    ...whitelist.sort(strongest).slice(0, MAX_PER_KIND),
  ].filter((s) => !dismissed.has(suggestionKey(s.kind, s.domain)));
}
