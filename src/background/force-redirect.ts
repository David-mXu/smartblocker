// P2 hardening (red-team 2026-11-05 findings #1/#4): under a FORCE-BLOCKING
// lock (Frozen Turkey or an active schedule window — lock.forceBlocking), a
// blocked MAIN FRAME is not fought over inside the page's own DOM. Instead a
// declarativeNetRequest session rule redirects the tab's request for the
// offending URL to the extension-owned src/blocked/blocked.html page. After
// the redirect the tab's top-level document is a chrome-extension:// page with
// ZERO attacker-controlled DOM — no overlay to remove, no button to synth-
// click (the site's own JavaScript never runs again for that document).
//
// Why tabIds + anchored urlFilter (the chosen condition):
//   - tabIds: [tabId] scopes the rule to exactly the tab whose verdict was
//     BLOCKED — the same URL in another tab must get its own verdict (and its
//     own rule), never a stolen redirect.
//   - urlFilter wrapped in '|' both ends is DNR's exact-match idiom (no
//     wildcards, no substrings). The committed URL is canonicalized through
//     new URL().href first (punycode host, percent-encoded path/query) because
//     Chrome matches urlFilter against the canonical request URL, and the
//     pattern must be pure ASCII.
//   - Residual, documented: if the committed URL literally contains '*', '^'
//     or '|' (the last is %-encoded by URL, the first two may survive), the
//     pattern gains wildcard/separator semantics — but confinement properties
//     (same tabIds, host portion fully literal, anchored both ends) mean the
//     broadened match can only ever hit MORE of the same hostile host's own
//     pages in the SAME tab. That is the fail-safe direction: a page tricking
//     its own rule into blocking more of itself changes nothing.
//   - resourceTypes: ['main_frame'] — DNR redirect is deliberately NOT the
//     sub-frame mechanism (embeds keep the in-page masking/injection path; an
//     iframe redirected to the extension origin would break whitelisted
//     workspaces that embed productive frames).
//
// Rule lifecycle:
//   - ADD: blocker.ts onTitle, only when lock.forceBlocking && blocked.
//   - REMOVE: (a) lock release/expiry — our own storage.onChanged lockState
//     listener + a listener on the lock-enforcer's 'lock-boundary' alarm
//     (fire-and-re-check; time-based expiry has no storage write);
//     (b) tabs.onRemoved; (c) SW (re)start prune — session rules outlive the
//     service worker inside a browser session, so getSessionRules() is
//     reconciled against live tabs on init; (d) verdict-clear — an ALLOWED
//     verdict reached for a URL that carries a rule (classifier recovered
//     during fail-closed backoff) releases that rule.
import { api, IS_FIREFOX } from '../shared/api';
import { getLockStatus } from '../shared/lock';

/** Dedicated ID space for force-redirect session rules — anything we find in
 *  the session ruleset at or above this base is ours (no other rules exist). */
const FORCE_RULE_ID_BASE = 1_000_000;
/** Above every other rule this extension could ever install. */
const FORCE_REDIRECT_PRIORITY = 1000;
/** Defensive cap — session rules share a global quota; FIFO-prune beyond it. */
const MAX_FORCE_REDIRECT_RULES = 200;
/** Keep the redirect URL sane; longer URLs fall back to the injected overlay. */
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;

type ForceRedirectReason = 'dnf-redirect' | 'classifier-unavailable';

export interface ForceRedirectInfo {
  title: string;
  label: string;
  score: number;
  ms: number;
  reason: ForceRedirectReason;
}

/** Add ownership is explicit: an idempotent hit on an already-enforced rule is
 * not permission for this caller to delete that rule if its verdict goes stale. */
export type ForceRedirectInstallResult =
  | { status: 'installed'; ruleId: number }
  | { status: 'already-enforced' }
  | { status: 'failed' };

interface ForceRedirectEntry {
  ruleId: number;
  tabId: number;
  /** The canonical (URL-normalized) blocked URL this rule matches. */
  url: string;
}

// ruleId → verdict bookkeeping (the task's "ruleId→verdict map"), plus a
// (tabId, url) → ruleId index for targeted clears.
const ruleIdToEntry = new Map<number, ForceRedirectEntry>();
const ruleIdsByTabUrl = new Map<number, Map<string, number>>();
// Insertion-ordered FIFO for the defensive cap.
const allocatedOrder: number[] = [];
let nextRuleId = FORCE_RULE_ID_BASE;

function indexRule(entry: ForceRedirectEntry): void {
  ruleIdToEntry.set(entry.ruleId, entry);
  let perTab = ruleIdsByTabUrl.get(entry.tabId);
  if (!perTab) {
    perTab = new Map<string, number>();
    ruleIdsByTabUrl.set(entry.tabId, perTab);
  }
  perTab.set(entry.url, entry.ruleId);
  allocatedOrder.push(entry.ruleId);
}

function unindexRule(ruleId: number): void {
  const entry = ruleIdToEntry.get(ruleId);
  if (!entry) return;
  ruleIdToEntry.delete(ruleId);
  const perTab = ruleIdsByTabUrl.get(entry.tabId);
  perTab?.delete(entry.url);
  if (perTab && perTab.size === 0) ruleIdsByTabUrl.delete(entry.tabId);
  const i = allocatedOrder.indexOf(ruleId);
  if (i >= 0) allocatedOrder.splice(i, 1);
}

/** The DNR API surface exists only when the manifest grants it; any port gap
 *  (e.g. a Firefox build without session-rule tabIds support) must degrade to
 *  the injected overlay instead of failing open — every public entry point
 *  funnels through this guard. */
export function forceRedirectAvailable(): boolean {
  const dnr = api.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== 'function') return false;
  if (IS_FIREFOX) {
    // Firefox ships session rules + tabIds conditions in current releases;
    // nothing here needs a different code path — the try/catch fallbacks in
    // this module cover any residual Gecko gap byte-identically.
    return true;
  }
  return true;
}

/** Canonicalize to the exact byte string Chrome's network stack will request,
 *  and assert the ASCII/length constraints of urlFilter. */
function canonicalizeUrl(url: string): string | null {
  let canonical: string;
  try {
    canonical = new URL(url).href;
  } catch {
    return null;
  }
  if (canonical.length > MAX_URL_LENGTH) return null;
  // urlFilter must be ASCII — URL normalization percent-encodes anything
  // non-ASCII, so a violation here means something exotic enough to skip.
  if (!/^[\x21-\x7e]+$/.test(canonical)) return null;
  return canonical;
}

/** The blocked.html redirect target. `locked=1` is always sent (this path is
 *  force-mode-only); the page itself never renders bypass buttons regardless
 *  of query values — see blocked.ts for why params are distrusted. */
function buildExtensionPath(info: ForceRedirectInfo): string {
  const p = new URLSearchParams();
  p.set('v', '1');
  p.set('reason', info.reason);
  p.set('locked', '1');
  p.set('title', info.title.slice(0, MAX_TITLE_LENGTH));
  p.set('label', info.label.slice(0, MAX_LABEL_LENGTH));
  const score = Number.isFinite(info.score) ? Math.min(1, Math.max(0, info.score)) : 0;
  p.set('score', score.toFixed(3));
  p.set('ms', String(Math.max(0, Math.round(info.ms))));
  return `/blocked.html?${p.toString()}`;
}

// Session rules persist across MV3 service-worker restarts (they die only at
// browser-session end), so on boot we must reconcile: rebuild the ID indexes
// from what is actually installed, and drop rules whose tabId is gone.
let readyPromise: Promise<void> | null = null;

async function reconcileSessionRules(): Promise<void> {
  if (!forceRedirectAvailable()) return;
  let rules: chrome.declarativeNetRequest.Rule[];
  try {
    rules = await api.declarativeNetRequest.getSessionRules();
  } catch {
    return; // session-rule read failed — leave enforcement to the injected path
  }
  const stale: number[] = [];
  for (const rule of rules) {
    if (rule.id < FORCE_RULE_ID_BASE) continue;
    const tabId = rule.condition.tabIds?.[0];
    const rawFilter = rule.condition.urlFilter ?? '';
    const url = rawFilter.startsWith('|') && rawFilter.endsWith('|') ? rawFilter.slice(1, -1) : rawFilter;
    let tabAlive = false;
    if (tabId !== undefined) {
      tabAlive = await api.tabs.get(tabId).then(
        () => true,
        () => false,
      );
    }
    if (tabId === undefined || !tabAlive) {
      stale.push(rule.id);
      continue;
    }
    indexRule({ ruleId: rule.id, tabId, url });
    if (rule.id >= nextRuleId) nextRuleId = rule.id + 1;
  }
  if (stale.length > 0) {
    try {
      await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
    } catch {
      // prune is best-effort; the entries are also unindexed
    }
    for (const id of stale) unindexRule(id);
  }
}

function ensureReady(): Promise<void> {
  readyPromise ??= reconcileSessionRules();
  return readyPromise;
}

async function removeRuleIds(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  try {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch {
    // Removing an already-gone rule is fine — local indexes are still updated.
  }
  for (const id of ruleIds) unindexRule(id);
}

/**
 * Install (or idempotently observe) a session-scoped main_frame redirect rule
 * for (tabId, url) pointing at blocked.html carrying the verdict params. Only
 * the 'installed' result grants ownership for stale-evaluation rollback.
 * 'already-enforced' belongs to another evaluator/reconciled browser session;
 * 'failed' asks the caller to use the injected overlay (never an allow).
 */
export async function addForceRedirectRule(
  tabId: number,
  url: string,
  info: ForceRedirectInfo,
): Promise<ForceRedirectInstallResult> {
  if (!forceRedirectAvailable()) return { status: 'failed' };
  await ensureReady();
  const canonical = canonicalizeUrl(url);
  if (!canonical) return { status: 'failed' };
  if (ruleIdsByTabUrl.get(tabId)?.has(canonical)) return { status: 'already-enforced' };

  const rule: chrome.declarativeNetRequest.Rule = {
    id: nextRuleId++,
    priority: FORCE_REDIRECT_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { extensionPath: buildExtensionPath(info) },
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      urlFilter: '|' + canonical + '|',
    },
  };

  try {
    await api.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  } catch (e) {
    console.warn('[SmartBlocker] force redirect rule rejected (falling back to overlay):', e);
    return { status: 'failed' };
  }
  indexRule({ ruleId: rule.id, tabId, url: canonical });

  // Defensive FIFO prune past the cap.
  if (allocatedOrder.length > MAX_FORCE_REDIRECT_RULES) {
    const overflow = allocatedOrder.slice(0, allocatedOrder.length - MAX_FORCE_REDIRECT_RULES);
    void removeRuleIds(overflow);
  }
  return { status: 'installed', ruleId: rule.id };
}

/** Verdict-clear release: an allowed verdict for a rule-carrying URL lets it
 *  load again (classifier recovery during fail-closed backoff). A stale caller
 *  may pass its owned rule ID; a replacement owned by newer work is retained. */
export async function clearForceRedirectRule(
  tabId: number,
  url: string,
  ownedRuleId?: number,
): Promise<void> {
  if (!forceRedirectAvailable()) return;
  await ensureReady();
  const canonical = canonicalizeUrl(url);
  if (!canonical) return;
  const ruleId = ruleIdsByTabUrl.get(tabId)?.get(canonical);
  if (ruleId === undefined || (ownedRuleId !== undefined && ruleId !== ownedRuleId)) return;
  await removeRuleIds([ruleId]);
}

/** Every rule bound to a closed (or otherwise gone) tab. */
export async function clearForceRedirectsForTab(tabId: number): Promise<void> {
  if (!forceRedirectAvailable()) return;
  await ensureReady();
  const perTab = ruleIdsByTabUrl.get(tabId);
  if (!perTab || perTab.size === 0) return;
  await removeRuleIds([...perTab.values()]);
}

/** Global release on lock unlock/expiry. Re-reads the LIVE session ruleset
 *  rather than trusting local indexes, so a rule added by a now-dead SW
 *  instance can never leak past the lock. */
export async function clearAllForceRedirectRules(): Promise<void> {
  if (!forceRedirectAvailable()) return;
  await ensureReady();
  let rules: chrome.declarativeNetRequest.Rule[];
  try {
    rules = await api.declarativeNetRequest.getSessionRules();
  } catch {
    return;
  }
  const ours = rules.filter((r) => r.id >= FORCE_RULE_ID_BASE).map((r) => r.id);
  await removeRuleIds(ours);
}

async function releaseIfNotForceBlocking(): Promise<void> {
  try {
    const lock = await getLockStatus();
    if (!lock.forceBlocking) await clearAllForceRedirectRules();
  } catch {
    // lock read failure must never wipe enforcement — safest is to keep rules.
  }
}

/** Register the lifecycle listeners. Called synchronously from initBlocker()
 *  (MV3 listener-registration rules), exactly like the other background
 *  module inits. */
export function initForceRedirectLifecycle(): void {
  if (!forceRedirectAvailable()) return;

  // (a) explicit lock changes (unlock, companion merge, raw test writes).
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lockState']) return;
    void releaseIfNotForceBlocking();
  });

  // (a') time-based expiry has no storage write — piggy-back the boundary
  // alarm lock-enforcer.ts already schedules ('lock-boundary' covers duration
  // ends AND schedule-window edges). Multiple alarm listeners are legal.
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'lock-boundary') return;
    void releaseIfNotForceBlocking();
  });

  // (b) tab close.
  api.tabs.onRemoved.addListener((tabId) => {
    void clearForceRedirectsForTab(tabId).catch(() => {});
  });

  // (c) SW restart reconciliation (async fire-and-forget; adds are gated on
  // the same ready promise, so no ID can collide with a stale session rule).
  void ensureReady().catch(() => {});
}
