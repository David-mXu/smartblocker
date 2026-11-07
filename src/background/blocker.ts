import { api } from '../shared/api';
import { LATENCY_LOG_MAX } from '../shared/config';
import { getSettings, type Settings } from '../shared/settings';
import { getLockStatus } from '../shared/lock';
import type { LockStatus } from '../shared/lock-math';
import { isOverridden } from '../shared/overrides';
import type { ClassifyInput, ClassifyOutcome, LatencySample } from '../shared/messages';
import { cleanTitle, isClassifiableUrl, isWhitelisted, matchedBlocklistEntry } from '../shared/titles';
import { applyUrlSignals, hostnameOf, urlFallbackTitle } from '../shared/url-signals';
import { extractMeta } from '../content/extract-meta';
import {
  sanitizePage,
  type SubItemEvalRequest,
  type SubItemEvalResult,
} from '../content/sanitize-page';
import { classify } from './classifier';
import {
  applyPreBlockCurtain,
  clearBlockScreen,
  clearPreBlockCurtain,
  showBlockScreen,
  showClassifierUnavailableScreen,
} from './blockscreen';
import { mintOverrideToken } from './override-tokens';
import { effectiveBlockScore } from '../shared/prototypes';
import {
  addForceRedirectRule,
  clearForceRedirectRule,
  initForceRedirectLifecycle,
} from './force-redirect';

/** The fields onTitle actually needs, shared by the ML path and the
 *  deterministic blocklist short-circuit (which skips classify() entirely). */
type BlockDecisionInput = Pick<
  ClassifyOutcome,
  'label' | 'score' | 'cached' | 'loadMs' | 'inferMs'
> & {
  all?: { labels: string[]; scores: number[] };
};

// SmartBlocker watches EVERY http(s) site (whitelist exemption applied later, in
// onTitle). Many sites are SPAs: most "navigations" never reload the page, and
// the document title only lands well after the navigation event. Strategy:
//  - onCommitted (full loads) and onHistoryStateUpdated (SPA / in-tab route
//    changes) ARM the tab and timestamp the navigation. Title NOT ready yet.
//  - tabs.onUpdated with changeInfo.title is the actual classification
//    trigger, with a per-tab last-title guard against title flicker.

const armedAt = new Map<number, number>(); // tabId -> nav commit epoch ms
const armedUrl = new Map<number, string>(); // tabId -> latest armed URL
const lastClassified = new Map<number, string>(); // tabId -> `${url}|${title}`
const inFlightKey = new Map<number, string>();
const metaRecheckTimers = new Map<number, ReturnType<typeof setTimeout>>();
const spaCheckTimers = new Map<number, ReturnType<typeof setTimeout>>();
// Bumped on every arm() (i.e. every committed/SPA navigation). onTitle
// captures it before its async classify() work and checks it again just
// before injecting — if the user has since navigated away (e.g. hit back
// while a slow classification was in flight) the generation has moved on
// and the now-stale verdict is dropped instead of painting a block screen
// over a page the user already left.
const navGeneration = new Map<number, number>();

// Per-subframe state (`${tabId}:${frameId}`) for direct sub-frame (frameId > 0)
// classification and blocking inside Shadow DOMs and nested iframes.
const subFrameArmedAt = new Map<string, number>();
const subFrameLastClassified = new Map<string, string>();
const subFrameInFlightKey = new Map<string, string>();
const subFrameGeneration = new Map<string, number>();
const subFrameBlockedVerdict = new Map<
  string,
  { label: string; score: number; title: string; locked: boolean; unavailable?: boolean }
>();
const subFrameKeysByTab = new Map<number, Set<string>>();

function subFrameKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

function trackSubFrameKey(tabId: number, key: string): void {
  let set = subFrameKeysByTab.get(tabId);
  if (!set) {
    set = new Set<string>();
    subFrameKeysByTab.set(tabId, set);
  }
  set.add(key);
}

function clearSubFrameStateForTab(tabId: number): void {
  const set = subFrameKeysByTab.get(tabId);
  if (!set) return;
  for (const key of set) {
    subFrameArmedAt.delete(key);
    subFrameLastClassified.delete(key);
    subFrameInFlightKey.delete(key);
    subFrameGeneration.delete(key);
    subFrameBlockedVerdict.delete(key);
  }
  subFrameKeysByTab.delete(tabId);
}

// Red-team P1 #13: classification historically failed OPEN — an offscreen-doc
// kill or model-load failure rejected classify() and the page sailed through.
// During a HARD lock (Frozen Turkey / schedule window / password lock) that
// is a hole, so those locks fail CLOSED instead: treat the page as blocked,
// show the loud "classifier unavailable" screen, and keep retrying with
// exponential backoff. Timer locks alone and normal mode keep the historical
// fail-open posture byte-for-byte (the rejection just propagates).
function isHardLocked(lock: LockStatus): boolean {
  return lock.forceBlocking || lock.reasons.includes('password');
}

// A dead offscreen document or a model (re)load often recovers within
// seconds, so fail-closed verdicts retry before going loud-permanently.
const HARD_LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

type HardLockClassify =
  | { kind: 'ok'; result: ClassifyOutcome }
  /** Hard-locked and every retry failed — the loud screen stays up. */
  | { kind: 'failed' }
  /** The user navigated away during backoff — drop everything quietly. */
  | { kind: 'stale' };

/**
 * classify() with fail-closed semantics. NOT hard-locked: a rejection
 * propagates to the caller unchanged. Hard-locked: the first rejection runs
 * onFirstFailure() (injects the loud screen), then retries with exponential
 * backoff; a recovered classify returns 'ok', exhaustion returns 'failed'.
 */
async function classifyWithHardLockRetry(
  input: ClassifyInput,
  hardLocked: boolean,
  stillCurrent: () => boolean,
  onFirstFailure: () => void,
): Promise<HardLockClassify> {
  try {
    return { kind: 'ok', result: await classify(input) };
  } catch (e) {
    if (!hardLocked) throw e;
    onFirstFailure();
  }
  for (const delayMs of HARD_LOCK_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delayMs));
    if (!stillCurrent()) return { kind: 'stale' };
    try {
      return { kind: 'ok', result: await classify(input) };
    } catch {
      // keep backing off
    }
  }
  return stillCurrent() ? { kind: 'failed' } : { kind: 'stale' };
}

const ytOembedCache = new Map<string, { title: string; author: string }>();
const ytOembedInFlight = new Map<string, Promise<{ title: string; author: string } | null>>();

/** The sanitizer rewrites embed URLs to canonical watch URLs before sending
 *  them for evaluation, so the nocookie/facade provenance (which must never
 *  trigger oEmbed) has to be recovered from the item's channel/context/id. */
function isPrivacyPreservingEmbed(item: SubItemEvalRequest): boolean {
  return (
    /youtube-nocookie\.com/i.test(item.url) ||
    /youtube-nocookie/i.test(item.channel ?? '') ||
    /facade/i.test(item.context ?? '') ||
    item.id.startsWith('sb-facade')
  );
}

function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    if (h === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v') || u.searchParams.get('video');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveYouTubeMeta(
  videoId: string,
  source: { privacyPreserving: boolean },
): Promise<{ title: string; author: string } | null> {
  // youtube-nocookie embeds and lite-youtube-style privacy facades exist
  // precisely so the page never talks to YouTube's servers — resolving
  // titles over oEmbed would leak the video ID to www.youtube.com and defeat
  // them, so they get no network resolution even when the toggle is on
  // (red-team P1 #9).
  if (source.privacyPreserving) return null;
  // Default OFF: each oEmbed lookup is browsing-metadata egress (the video
  // ID) to www.youtube.com. DOM/URL-extracted titles are tried first at
  // every call site; this fetch is strictly the last resort.
  if (!(await getSettings()).resolveEmbedTitles) return null;
  const cached = ytOembedCache.get(videoId);
  if (cached) return cached;
  const inflight = ytOembedInFlight.get(videoId);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`;
      const resp = await fetch(oembedUrl, { signal: AbortSignal.timeout(2500) });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { title?: string; author_name?: string };
      if (data?.title) {
        const entry = {
          title: String(data.title).trim(),
          author: String(data.author_name ?? '').trim(),
        };
        if (ytOembedCache.size >= 300) {
          const oldest = ytOembedCache.keys().next().value;
          if (oldest) ytOembedCache.delete(oldest);
        }
        ytOembedCache.set(videoId, entry);
        return entry;
      }
    } catch {
      // oEmbed fetch failed or timed out — fall back to DOM/URL signals
    }
    return null;
  })();

  ytOembedInFlight.set(videoId, task);
  try {
    return await task;
  } finally {
    ytOembedInFlight.delete(videoId);
  }
}

async function runPageSanitizer(tabId: number): Promise<void> {
  try {
    const settings = await getSettings();
    const lock = await getLockStatus();
    if (!settings.enabled && !lock.forceBlocking) return;
    await api.scripting.executeScript({
      target: { tabId },
      func: sanitizePage,
      args: [
        {
          blockedLabels: settings.blockedLabels,
          blocklist: settings.blocklist,
          settingsLocked: lock.settingsLocked,
        },
      ],
    });
  } catch {
    // Page not injectable (e.g. chrome:// or closed tab)
  }
}

export async function evaluateSubItems(
  items: SubItemEvalRequest[],
  senderTabId?: number,
): Promise<SubItemEvalResult[]> {
  const settings = await getSettings();
  const lock = await getLockStatus();
  if (!settings.enabled && !lock.forceBlocking) {
    return items.map((it) => ({ id: it.id, blocked: false, label: 'disabled', score: 0 }));
  }

  let focusContext: ClassifyInput['focusContext'];
  if (settings.focusGoal.trim() || settings.useTabContext) {
    const openTabTitles: string[] = [];
    try {
      const openTabs = await api.tabs.query({ currentWindow: true });
      for (const t of openTabs) {
        if (t.id !== senderTabId && isClassifiableUrl(t.url)) {
          const ct = cleanTitle(t.title);
          if (ct) {
            openTabTitles.push(ct);
            if (openTabTitles.length >= 6) break;
          }
        }
      }
    } catch {
      // ignore
    }
    focusContext = {
      focusGoal: settings.focusGoal.trim() || undefined,
      openTabTitles,
    };
  }

  const results: SubItemEvalResult[] = [];
  for (const item of items.slice(0, 20)) {
    let title = cleanTitle(item.title) ?? item.title?.trim() ?? '';
    let channel = item.channel ?? hostnameOf(item.url);
    let context = item.context ?? '';

    const ytId = extractYouTubeVideoId(item.url);
    if (ytId && (!title || /^youtube video player$/i.test(title))) {
      const ytMeta = await resolveYouTubeMeta(ytId, {
        privacyPreserving: isPrivacyPreservingEmbed(item),
      });
      if (ytMeta) {
        title = cleanTitle(ytMeta.title) ?? ytMeta.title;
        channel = ytMeta.author ? `${ytMeta.author} (youtube.com)` : 'youtube.com';
        context = ytMeta.author ? `YouTube video by ${ytMeta.author}.` : context;
      }
    }

    if (!title) {
      title = urlFallbackTitle(item.url) ?? hostnameOf(item.url);
    }

    const blHit = matchedBlocklistEntry(item.url, title, settings.blocklist);
    if (blHit) {
      const overridden =
        !lock.forceBlocking && (await isOverridden(title, hostnameOf(item.url)));
      results.push({
        id: item.id,
        blocked: !overridden,
        label: `blocked rule: "${blHit}"`,
        score: 1,
        resolvedTitle: title,
      });
      continue;
    }

    let res: ClassifyOutcome;
    try {
      res = await classify({
        title,
        channel,
        context,
        focusContext,
      });
    } catch (e) {
      if (!isHardLocked(lock)) throw e;
      // Fail closed per-card (red-team P1 #13): during a hard lock an
      // unverifiable embed/SERP card stays masked instead of slipping
      // through. No backoff here — the sanitizer already re-scans.
      results.push({
        id: item.id,
        blocked: true,
        label: 'classifier unavailable (locked)',
        score: 1,
        resolvedTitle: title,
      });
      continue;
    }
    const effScore = effectiveBlockScore(res, settings.blockedLabels);
    let blocked =
      settings.blockedLabels.includes(res.label) && effScore >= settings.blockThreshold;
    if (blocked && !lock.forceBlocking && (await isOverridden(title, hostnameOf(item.url)))) {
      blocked = false;
    }
    results.push({
      id: item.id,
      blocked,
      label: res.label,
      score: res.score,
      resolvedTitle: title,
    });
  }
  return results;
}

const HIGH_RISK_HOSTS = new Set([
  'youtube.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'twitch.tv',
  'tiktok.com',
  'instagram.com',
  'kick.com',
  'store.steampowered.com',
]);

const recentlyBlockedHosts = new Set<string>();

function isHighRiskOrRecentlyBlocked(host: string): boolean {
  if (!host) return false;
  for (const h of HIGH_RISK_HOSTS) {
    if (host === h || host.endsWith('.' + h)) return true;
  }
  if (recentlyBlockedHosts.has(host)) return true;
  for (const b of recentlyBlockedHosts) {
    if (host === b || host.endsWith('.' + b)) return true;
  }
  return false;
}

function clearCurtain(tabId: number, frameId?: number): void {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
  void api.scripting
    .executeScript({
      target,
      func: clearPreBlockCurtain,
    })
    .catch(() => {});
}

function clearOverlay(tabId: number, frameId?: number): void {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
  void api.scripting
    .executeScript({
      target,
      func: clearBlockScreen,
    })
    .catch(() => {});
}

function isYouTubeVideoPage(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    if (h !== 'youtube.com' && h !== 'youtube-nocookie.com') return false;
    return /^\/(?:watch|shorts\/|embed\/|live\/|v\/)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * True when `url` is a YouTube browsing/discovery surface (homepage `/`,
 * channel pages `/@...`, `/channel/...`, `/c/...`, `/user/...`, library/sub
 * feeds `/feed/...`, playlists `/playlist`, or `/results` search pages) rather
 * than an actual video playback page (`/watch`, `/shorts/`, `/live/`, `/embed/`).
 */
function isYouTubeBrowsingSurface(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    if (h !== 'youtube.com') return false;
    if (isYouTubeVideoPage(url)) return false;
    return (
      u.pathname === '/' ||
      /^\/(?:@|channel\/|c\/|user\/|feed\/|results\b|playlist\b)/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

async function maybeCurtain(tabId: number, url: string, gen: number): Promise<void> {
  try {
    const settings = await getSettings();
    const lock = await getLockStatus();
    if (!settings.enabled && !lock.forceBlocking) return;
    if (isWhitelisted(url, settings.whitelist)) return;
    if (navGeneration.get(tabId) !== gen) return;

    const isBlocklistMatch = matchedBlocklistEntry(url, null, settings.blocklist) !== null;
    if (!isBlocklistMatch && isYouTubeBrowsingSurface(url)) return;

    const host = hostnameOf(url);
    const isTarget = isHighRiskOrRecentlyBlocked(host);

    if (isBlocklistMatch || isTarget) {
      await api.scripting.executeScript({
        target: { tabId },
        func: applyPreBlockCurtain,
        args: [180],
      });
    }
  } catch {
    // ignore injection failure
  }
}

function clearTabTimers(tabId: number): void {
  const mt = metaRecheckTimers.get(tabId);
  if (mt) {
    clearTimeout(mt);
    metaRecheckTimers.delete(tabId);
  }
  const st = spaCheckTimers.get(tabId);
  if (st) {
    clearTimeout(st);
    spaCheckTimers.delete(tabId);
  }
}

function arm(tabId: number, url: string) {
  clearSubFrameStateForTab(tabId);
  clearTabTimers(tabId);
  if (isClassifiableUrl(url)) {
    armedAt.set(tabId, Date.now());
    armedUrl.set(tabId, url);
    lastClassified.delete(tabId);
    inFlightKey.delete(tabId);
    const nextGen = (navGeneration.get(tabId) ?? 0) + 1;
    navGeneration.set(tabId, nextGen);
    void maybeCurtain(tabId, url, nextGen);

    // SPA fallback: if changeInfo.title fired just BEFORE onHistoryStateUpdated
    // (or never fires because the title didn't change, e.g. returning to YouTube
    // homepage), ensure onTitle still runs for the newly-armed URL.
    const timer = setTimeout(async () => {
      spaCheckTimers.delete(tabId);
      if (navGeneration.get(tabId) !== nextGen) return;
      if (lastClassified.has(tabId) || inFlightKey.has(tabId)) return;
      try {
        const tab = await api.tabs.get(tabId);
        if (!tab?.url || !isClassifiableUrl(tab.url)) return;
        await onTitle(tabId, tab.title ?? '', tab.url);
      } catch {
        // tab closed or unreachable
      }
    }, 320);
    spaCheckTimers.set(tabId, timer);
  }
}

const EMBED_SUBFRAME_URL_RE =
  /(?:youtube\.com\/(?:embed|shorts|live|v|watch)|youtube-nocookie\.com\/(?:embed|shorts|live|v|watch)|youtu\.be\/|player\.vimeo\.com|vimeo\.com\/video\/|player\.bilibili\.com|bilibili\.com\/blackboard\/|dailymotion\.com\/embed|geo\.dailymotion\.com|player\.dailymotion\.com|player\.twitch\.tv|clips\.twitch\.tv|twitch\.tv\/embed|kick\.com|streamable\.com|tiktok\.com|instagram\.com|platform\.twitter\.com|twitter\.com\/i\/videos|x\.com\/i\/videos|redditmedia\.com|v\.redd\.it|poki\.com|crazygames\.com|itch\.io|html\.itch\.io|construct\.net|stage\.construct\.net|cardgames\.io|minesweeper\.online|1000mines\.com|google\.[a-z.]+\/fbx)/i;

const INFRA_SUBFRAME_HOST_RE =
  /(?:^|\.)(?:accounts\.google\.com|ogs\.google\.com|content\.googleapis\.com|clients\d*\.google\.com|recaptcha\.net|gstatic\.com|doubleclick\.net|googlesyndication\.com|googletagmanager\.com|challenges\.cloudflare\.com|hcaptcha\.com|js\.stripe\.com|stripe\.com|paypal\.com)$/i;

function isEmbedSubFrameUrl(url: string): boolean {
  if (!isClassifiableUrl(url)) return false;
  if (extractYouTubeVideoId(url) !== null) return true;
  return EMBED_SUBFRAME_URL_RE.test(url);
}

function extractUrlTitleParam(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const explicit = u.searchParams.get('title');
    if (explicit) return cleanTitle(explicit);
    const tParam = u.searchParams.get('t');
    // Ignore numeric playback timestamps like ?t=120 or ?t=90s
    if (tParam && !/^\d+(?:[smh]|\.\d+)?$/i.test(tParam.trim())) {
      return cleanTitle(tParam);
    }
  } catch {
    // ignore
  }
  return null;
}

async function armSubFrame(tabId: number, frameId: number, url: string): Promise<void> {
  if (!isClassifiableUrl(url)) return;
  const host = hostnameOf(url);
  if (INFRA_SUBFRAME_HOST_RE.test(host)) return;

  const key = subFrameKey(tabId, frameId);
  trackSubFrameKey(tabId, key);
  subFrameArmedAt.set(key, Date.now());
  subFrameLastClassified.delete(key);
  subFrameInFlightKey.delete(key);
  subFrameBlockedVerdict.delete(key);
  const nextGen = (subFrameGeneration.get(key) ?? 0) + 1;
  subFrameGeneration.set(key, nextGen);

  try {
    const settings = await getSettings();
    const lock = await getLockStatus();
    if (!settings.enabled && !lock.forceBlocking) return;
    if (isWhitelisted(url, settings.whitelist)) return;
    if (subFrameGeneration.get(key) !== nextGen) return;

    const isBlocklistMatch = matchedBlocklistEntry(url, null, settings.blocklist) !== null;
    if (isBlocklistMatch || isEmbedSubFrameUrl(url)) {
      await api.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: applyPreBlockCurtain,
        args: [1500],
      });
    }
  } catch {
    // ignore injection failure on transient or already-unloaded sub-frame
  }
}

async function logSample(sample: LatencySample) {
  const { latencySamples = [] } = await api.storage.local.get('latencySamples');
  latencySamples.push(sample);
  while (latencySamples.length > LATENCY_LOG_MAX) latencySamples.shift();
  await api.storage.local.set({ latencySamples });
  console.log(
    `[SmartBlocker] ${sample.blocked ? 'BLOCKED' : 'allowed'} "${sample.title}" -> ` +
      `${sample.label} (${(sample.score * 100).toFixed(0)}%) | ` +
      `pageDelay ${sample.pageDelayMs}ms, load ${Math.round(sample.loadMs)}ms, ` +
      `infer ${Math.round(sample.inferMs)}ms, inject ${Math.round(sample.injectMs)}ms, ` +
      `total ${Math.round(sample.totalMs)}ms${sample.cached ? ' (cached)' : ''}`,
  );
}

// Pull richer page signals (channel, description/post-body snippet, fallbackTitle) from the
// live DOM. extractMeta is self-contained so it serializes for executeScript.
async function gatherMeta(
  tabId: number,
  frameId?: number,
): Promise<{ channel?: string; context?: string; fallbackTitle?: string; metaStale?: boolean }> {
  try {
    const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
    const [inj] = await api.scripting.executeScript({ target, func: extractMeta });
    return (
      (inj?.result as
        | { channel?: string; context?: string; fallbackTitle?: string; metaStale?: boolean }
        | undefined) ?? {}
    );
  } catch {
    return {}; // page not injectable / navigated away — classify on the title alone
  }
}

async function onSubFrame(
  tabId: number,
  frameId: number,
  url: string,
  phase: 'committed' | 'completed',
): Promise<void> {
  if (!isClassifiableUrl(url)) return;
  const embedHost = hostnameOf(url);
  if (INFRA_SUBFRAME_HOST_RE.test(embedHost)) return;

  const key = subFrameKey(tabId, frameId);
  trackSubFrameKey(tabId, key);
  const myGeneration = subFrameGeneration.get(key) ?? 0;

  try {
    const settings = await getSettings();
    const lock = await getLockStatus();
    if (!settings.enabled && !lock.forceBlocking) {
      subFrameBlockedVerdict.delete(key);
      clearCurtain(tabId, frameId);
      clearOverlay(tabId, frameId);
      return;
    }
    if (isWhitelisted(url, settings.whitelist)) {
      subFrameBlockedVerdict.delete(key);
      clearCurtain(tabId, frameId);
      clearOverlay(tabId, frameId);
      return;
    }

    const urlBlocklistHit = matchedBlocklistEntry(url, null, settings.blocklist);
    if (!urlBlocklistHit && !isEmbedSubFrameUrl(url)) {
      return;
    }

    // If onCommitted already blocked this sub-frame and onCompleted now fires,
    // re-ensure the block screen is mounted in case document parsing reset the DOM.
    const priorBlocked = subFrameBlockedVerdict.get(key);
    if (priorBlocked && phase === 'completed') {
      if (priorBlocked.unavailable) {
        await api.scripting
          .executeScript({
            target: { tabId, frameIds: [frameId] },
            func: showClassifierUnavailableScreen,
            args: [priorBlocked.title],
          })
          .catch(() => {});
        return;
      }
      await api.scripting
        .executeScript({
          target: { tabId, frameIds: [frameId] },
          func: showBlockScreen,
          args: [
            priorBlocked.label,
            priorBlocked.score,
            priorBlocked.title,
            0,
            priorBlocked.locked,
            await mintOverrideToken(),
            settings.blockThreshold,
          ],
        })
        .catch(() => {});
      return;
    }

    const tStart = Date.now();
    const pageDelayMs = tStart - (subFrameArmedAt.get(key) ?? tStart);

    let title: string | null = null;
    let result: BlockDecisionInput;
    let blocked: boolean;
    // True once the fail-closed loud screen has been injected for this
    // evaluation — the normal verdict screen must NOT replace it.
    let classifyFailedClosed = false;

    const blockedSet = new Set(settings.blockedLabels);
    const isGameEmbed =
      /(?:^|\.)(?:poki\.com|crazygames\.com|itch\.io|html\.itch\.io|construct\.net|stage\.construct\.net|cardgames\.io|minesweeper\.online|1000mines\.com)$/i.test(
        embedHost,
      ) || /google\.[a-z.]+\/fbx/i.test(url);
    const isSocialOrStreamEmbed =
      /(?:^|\.)(?:player\.twitch\.tv|clips\.twitch\.tv|twitch\.tv|kick\.com|tiktok\.com|instagram\.com|platform\.twitter\.com|twitter\.com|x\.com|redditmedia\.com|v\.redd\.it)$/i.test(
        embedHost,
      ) || /\/shorts\//i.test(url);

    if (urlBlocklistHit) {
      title = extractUrlTitleParam(url) ?? urlFallbackTitle(url) ?? embedHost;
      subFrameLastClassified.set(key, title);
      result = {
        label: `blocked rule: "${urlBlocklistHit}"`,
        score: 1,
        cached: false,
        loadMs: 0,
        inferMs: 0,
      };
      blocked = true;
    } else if (isGameEmbed && blockedSet.has('video games')) {
      title = extractUrlTitleParam(url) ?? urlFallbackTitle(url) ?? `Embedded game (${embedHost})`;
      subFrameLastClassified.set(key, title);
      result = {
        label: 'video games',
        score: 1,
        cached: false,
        loadMs: 0,
        inferMs: 0,
      };
      blocked = true;
    } else if (
      isSocialOrStreamEmbed &&
      (blockedSet.has('memes and entertainment') ||
        blockedSet.has('social media and networking'))
    ) {
      title = extractUrlTitleParam(url) ?? urlFallbackTitle(url) ?? `Embedded media (${embedHost})`;
      subFrameLastClassified.set(key, title);
      result = {
        label: blockedSet.has('memes and entertainment')
          ? 'memes and entertainment'
          : 'social media and networking',
        score: 1,
        cached: false,
        loadMs: 0,
        inferMs: 0,
      };
      blocked = true;
    } else {
      const meta = await gatherMeta(tabId, frameId);
      const domTitle = cleanTitle(meta.fallbackTitle);
      const ytId = extractYouTubeVideoId(url);
      let ytTitle: string | null = null;

      // DOM-extracted titles first, URL `?title=` param second; oEmbed is
      // strictly the last resort (and opt-in — see resolveYouTubeMeta).
      title = domTitle ?? extractUrlTitleParam(url);
      if (ytId && !title) {
        const ytMeta = await resolveYouTubeMeta(ytId, {
          privacyPreserving: /(?:^|\.)youtube-nocookie\.com$/i.test(embedHost),
        });
        if (ytMeta) {
          ytTitle = cleanTitle(ytMeta.title) ?? ytMeta.title;
          if (!meta.channel && ytMeta.author) {
            meta.channel = `${ytMeta.author} (youtube.com)`;
          }
          if (!meta.context || meta.context === 'Embedded YouTube video.') {
            meta.context = ytMeta.author
              ? `YouTube video by ${ytMeta.author}.`
              : 'Embedded YouTube video.';
          }
        }
      }

      title = title ?? ytTitle;

      // During the initial onCommitted hook, if the sub-frame DOM hasn't rendered
      // its title yet and oEmbed didn't resolve one, keep the pre-block curtain
      // active and wait for onCompleted when the sub-frame DOM is ready.
      if (!title && phase === 'committed') {
        return;
      }

      if (!title) {
        // If this is a YouTube embed whose video ID could not be resolved by
        // either DOM or oEmbed (e.g. a bare placeholder frame), don't classify
        // the opaque 11-char ID slug as a real title.
        if (ytId && !meta.channel && (!meta.context || meta.context === 'Embedded YouTube video.')) {
          clearCurtain(tabId, frameId);
          return;
        }
        title = urlFallbackTitle(url) ?? embedHost;
      }

      if (subFrameLastClassified.get(key) === title) {
        if (!subFrameBlockedVerdict.has(key)) {
          clearCurtain(tabId, frameId);
        }
        return;
      }

      const flightToken = `${url}|${title}`;
      if (subFrameInFlightKey.get(key) === flightToken) return;
      subFrameInFlightKey.set(key, flightToken);

      try {
        subFrameLastClassified.set(key, title);
        const titleBlocklistHit = matchedBlocklistEntry(url, title, settings.blocklist);
        if (titleBlocklistHit) {
          result = {
            label: `blocked rule: "${titleBlocklistHit}"`,
            score: 1,
            cached: false,
            loadMs: 0,
            inferMs: 0,
          };
          blocked = true;
        } else {
          const { channel, context } = applyUrlSignals(url, meta);

          let focusContext: ClassifyInput['focusContext'];
          if (settings.focusGoal.trim() || settings.useTabContext) {
            const openTabTitles: string[] = [];
            try {
              const openTabs = await api.tabs.query({ currentWindow: true });
              for (const t of openTabs) {
                if (t.id !== tabId && isClassifiableUrl(t.url)) {
                  const ct = cleanTitle(t.title);
                  if (ct) {
                    openTabTitles.push(ct);
                    if (openTabTitles.length >= 6) break;
                  }
                }
              }
            } catch {
              // ignore
            }
            focusContext = {
              focusGoal: settings.focusGoal.trim() || undefined,
              openTabTitles,
            };
          }

          const outcome = await classifyWithHardLockRetry(
            {
              title,
              channel,
              context,
              focusContext,
            },
            isHardLocked(lock),
            () => (subFrameGeneration.get(key) ?? 0) === myGeneration,
            () => {
              classifyFailedClosed = true;
              void api.scripting
                .executeScript({
                  target: { tabId, frameIds: [frameId] },
                  func: showClassifierUnavailableScreen,
                  args: [title ?? ''],
                })
                .catch(() => {});
            },
          );
          if (outcome.kind === 'stale') return;
          if (outcome.kind === 'failed') {
            result = {
              label: 'classifier unavailable (locked)',
              score: 1,
              cached: false,
              loadMs: 0,
              inferMs: 0,
            };
            blocked = true;
          } else {
            result = outcome.result;
            const effScore = effectiveBlockScore(result, settings.blockedLabels);
            blocked =
              settings.blockedLabels.includes(result.label) && effScore >= settings.blockThreshold;
            if (!blocked && classifyFailedClosed) {
              // Recovered during backoff with an allow verdict — tear the
              // fail-closed screen back down (a block verdict overwrites it).
              classifyFailedClosed = false;
              void api.scripting
                .executeScript({
                  target: { tabId, frameIds: [frameId] },
                  func: clearBlockScreen,
                })
                .catch(() => {});
            }
          }
        }
      } finally {
        if (subFrameInFlightKey.get(key) === flightToken) {
          subFrameInFlightKey.delete(key);
        }
      }
    }

    if (blocked && !lock.forceBlocking && (await isOverridden(title ?? '', hostnameOf(url)))) {
      blocked = false;
    }

    if ((subFrameGeneration.get(key) ?? 0) !== myGeneration) {
      return;
    }

    let injectMs = 0;
    if (blocked) {
      subFrameBlockedVerdict.set(key, {
        label: result.label,
        score: result.score,
        title: title ?? '',
        locked: lock.settingsLocked,
        unavailable: classifyFailedClosed || undefined,
      });
      const tInject = Date.now();
      try {
        // Fail-closed: the "classifier unavailable" screen was already
        // injected on first failure — do NOT overwrite it with a normal
        // category verdict screen claiming 100% confidence.
        if (!classifyFailedClosed) {
          await api.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: showBlockScreen,
            args: [
              result.label,
              result.score,
              title ?? '',
              Date.now() - tStart,
              lock.settingsLocked,
              await mintOverrideToken(),
              settings.blockThreshold,
            ],
          });
        }
      } catch (e) {
        console.warn('[SmartBlocker] sub-frame block screen injection failed:', e);
      }
      injectMs = Date.now() - tInject;
    } else {
      subFrameBlockedVerdict.delete(key);
      clearCurtain(tabId, frameId);
      clearOverlay(tabId, frameId);
    }

    await logSample({
      url,
      title: title ?? '',
      label: result.label,
      score: result.score,
      blocked,
      cached: result.cached,
      pageDelayMs,
      loadMs: result.loadMs,
      inferMs: result.inferMs,
      injectMs,
      totalMs: Date.now() - tStart,
      ts: tStart,
    });
  } catch (e) {
    console.warn('[SmartBlocker] sub-frame classification failed:', e);
  }
}

async function onTitle(tabId: number, rawTitle: string, url: string) {
  const initialTitle = cleanTitle(rawTitle);
  if (initialTitle && lastClassified.get(tabId) === `${url}|${initialTitle}`) return;
  const flightToken = `${url}|${initialTitle ?? ''}`;
  if (inFlightKey.get(tabId) === flightToken) return;
  inFlightKey.set(tabId, flightToken);
  const myGeneration = navGeneration.get(tabId) ?? 0;

  try {
    const settings = await getSettings();
    const lock = await getLockStatus();
    if (!settings.enabled && !lock.forceBlocking) {
      armedAt.delete(tabId);
      clearCurtain(tabId);
      clearOverlay(tabId);
      void clearForceRedirectRule(tabId, url);
      return; // master switch off — never classify or block (unless a Frozen
      //         Turkey session or schedule window forces blocking on)
    }
    if (isWhitelisted(url, settings.whitelist)) {
      armedAt.delete(tabId);
      clearCurtain(tabId);
      clearOverlay(tabId);
      void clearForceRedirectRule(tabId, url);
      // Even on whitelisted workspaces (e.g. Google AI Studio, Gemini, Docs,
      // Notion), scan for embedded distraction videos/iframes inside the page.
      void runPageSanitizer(tabId);
      return;
    }

    // Deterministic blocklist check with the initial clean title (or null if generic/empty)
    let blocklistHit = matchedBlocklistEntry(url, initialTitle, settings.blocklist);

    // Allow YouTube browsing/discovery surfaces (homepage, channel pages, feeds,
    // search results) unless explicitly matched by a deterministic blocklist rule,
    // so users can search/browse YouTube and only get blocked on distracting videos.
    if (!blocklistHit && isYouTubeBrowsingSurface(url)) {
      armedAt.delete(tabId);
      lastClassified.set(tabId, `${url}|${initialTitle ?? 'youtube'}`);
      clearCurtain(tabId);
      clearOverlay(tabId);
      void clearForceRedirectRule(tabId, url);
      return;
    }

    const tTitle = Date.now();
    const pageDelayMs = tTitle - (armedAt.get(tabId) ?? tTitle);
    if (initialTitle) {
      armedAt.delete(tabId);
    }

    let title: string | null = initialTitle;
    let result: BlockDecisionInput;
    let blocked: boolean;
    // True once the fail-closed loud screen has been injected for this
    // evaluation — the normal verdict screen must NOT replace it.
    let classifyFailedClosed = false;

    // ── P2 DNR force redirect (red-team #1/#4, main frames only) ─────────
    // Under a force-blocking lock the block screen is the extension-owned
    // /blocked.html page reached through a declarativeNetRequest session
    // rule + tab reload — after the redirect the hostile document is GONE
    // (zero DOM for the site to tamper with). Memoized per evaluation so the
    // fail-closed first-failure hook and the final verdict share at most one
    // redirect; the FIRST caller's params win (a fail-closed redirect is not
    // "upgraded" to a category redirect if the classifier recovers mid-
    // backoff — documented residual, the posture stays fail-closed).
    // ANY DNR failure returns false, and the injected overlay path — still
    // byte-identical for every non-force mode and all sub-frames — runs as
    // the fallback.
    type ForceRedirectParams = {
      title: string;
      label: string;
      score: number;
      ms: number;
      reason: 'dnf-redirect' | 'classifier-unavailable';
    };
    let forceRedirectParams: ForceRedirectParams | null = null;
    let forceRedirectPromise: Promise<boolean> | null = null;
    const requestForceRedirect = (params: ForceRedirectParams): Promise<boolean> => {
      forceRedirectParams ??= params;
      forceRedirectPromise ??= (async () => {
        const ok = await addForceRedirectRule(tabId, url, forceRedirectParams as ForceRedirectParams);
        if (!ok) return false;
        try {
          await api.tabs.reload(tabId);
        } catch (e) {
          // Rule exists but the reload itself failed (tab racing a close) —
          // the rule alone still enforces the NEXT load of this URL.
          console.warn('[SmartBlocker] force redirect reload failed:', e);
        }
        return true;
      })();
      return forceRedirectPromise;
    };

    if (blocklistHit) {
      title = initialTitle ?? urlFallbackTitle(url) ?? '';
      if (title) lastClassified.set(tabId, `${url}|${title}`);
      result = {
        label: `blocked rule: "${blocklistHit}"`,
        score: 1,
        cached: false,
        loadMs: 0,
        inferMs: 0,
      };
      blocked = true;
    } else {
      // URL fallbacks (hostname as channel, path hint prepended) live in
      // shared/url-signals.ts so the offline evaluator builds identical input.
      const meta = await gatherMeta(tabId);
      const domTitle = cleanTitle(meta.fallbackTitle);

      // On YouTube video pages (/watch, /shorts, /live), if both document.title
      // and the active DOM h1 are still generic ("YouTube") or empty because the
      // SPA hasn't hydrated the video title yet, do NOT classify the bare
      // hostname ("youtube.com") — wait for the real video title to land.
      if (isYouTubeVideoPage(url) && !initialTitle && !domTitle) {
        const prevTimer = metaRecheckTimers.get(tabId);
        if (prevTimer) clearTimeout(prevTimer);
        const timer = setTimeout(async () => {
          metaRecheckTimers.delete(tabId);
          try {
            const tab = await api.tabs.get(tabId);
            if (!tab?.url || tab.url !== url) return;
            await onTitle(tabId, tab.title ?? '', tab.url);
          } catch {
            // ignore
          }
        }, 350);
        metaRecheckTimers.set(tabId, timer);
        return;
      }

      title = initialTitle ?? domTitle ?? urlFallbackTitle(url);

      if (!title && !meta.channel && !meta.context) {
        clearCurtain(tabId);
        return;
      }

      // If navigation failed (chrome-error:// page where DOM is unreachable and
      // rawTitle degraded to the bare hostname), do not classify error pages.
      const bareHost = hostnameOf(url);
      if (
        !meta.channel &&
        !meta.context &&
        !meta.fallbackTitle &&
        rawTitle.trim().toLowerCase() === bareHost
      ) {
        clearCurtain(tabId);
        return;
      }

      if (title && lastClassified.get(tabId) === `${url}|${title}`) {
        clearCurtain(tabId);
        void runPageSanitizer(tabId);
        return;
      }

      lastClassified.set(tabId, `${url}|${title ?? url}`);

      // If YouTube's Polymer DOM was still mid-transition (meta.metaStale) when
      // the title event fired, schedule a one-shot re-check once the active
      // ytd-watch-metadata channel & description finish rendering.
      if (meta.metaStale && isYouTubeVideoPage(url)) {
        const prevTimer = metaRecheckTimers.get(tabId);
        if (prevTimer) clearTimeout(prevTimer);
        const timer = setTimeout(async () => {
          metaRecheckTimers.delete(tabId);
          if (armedUrl.get(tabId) && armedUrl.get(tabId) !== url) return;
          try {
            const freshMeta = await gatherMeta(tabId);
            if (
              (freshMeta.channel && freshMeta.channel !== meta.channel) ||
              (freshMeta.context && freshMeta.context !== meta.context) ||
              (freshMeta.fallbackTitle && cleanTitle(freshMeta.fallbackTitle) !== title)
            ) {
              lastClassified.delete(tabId);
              inFlightKey.delete(tabId);
              const tab = await api.tabs.get(tabId);
              await onTitle(tabId, tab?.title ?? rawTitle, tab?.url ?? url);
            }
          } catch {
            // ignore
          }
        }, 450);
        metaRecheckTimers.set(tabId, timer);
      }

      blocklistHit = matchedBlocklistEntry(url, title, settings.blocklist);
      if (blocklistHit) {
        result = {
          label: `blocked rule: "${blocklistHit}"`,
          score: 1,
          cached: false,
          loadMs: 0,
          inferMs: 0,
        };
        blocked = true;
      } else {
        const { channel, context } = applyUrlSignals(url, meta);

        let focusContext: ClassifyInput['focusContext'];
        if (settings.focusGoal.trim() || settings.useTabContext) {
          let openTabTitles: string[] = [];
          try {
            const openTabs = await api.tabs.query({ currentWindow: true });
            for (const t of openTabs) {
              if (t.id !== tabId && isClassifiableUrl(t.url)) {
                const ct = cleanTitle(t.title);
                if (ct) {
                  openTabTitles.push(ct);
                  if (openTabTitles.length >= 6) break;
                }
              }
            }
          } catch {
            // ignore tab query failure
          }
          focusContext = {
            focusGoal: settings.focusGoal.trim() || undefined,
            openTabTitles,
          };
        }

        const outcome = await classifyWithHardLockRetry(
          {
            title: title ?? '',
            channel,
            context,
            focusContext,
          },
          isHardLocked(lock),
          () => navGeneration.get(tabId) === myGeneration,
          () => {
            classifyFailedClosed = true;
            if (lock.forceBlocking) {
              // P2: under a force-blocking lock the fail-closed screen IS the
              // extension-owned blocked page — redirect instead of injecting
              // the loud overlay. Password-locked and normal modes keep the
              // injected screen byte-identical; a DNR failure here only means
              // the final verdict branch re-ensures the loud screen.
              void requestForceRedirect({
                title: title ?? '',
                label: 'classifier unavailable (locked)',
                score: 1,
                ms: 0,
                reason: 'classifier-unavailable',
              }).catch(() => false);
            } else {
              void api.scripting
                .executeScript({
                  target: { tabId },
                  func: showClassifierUnavailableScreen,
                  args: [title ?? ''],
                })
                .catch(() => {});
            }
          },
        );
        if (outcome.kind === 'stale') return;
        if (outcome.kind === 'failed') {
          result = {
            label: 'classifier unavailable (locked)',
            score: 1,
            cached: false,
            loadMs: 0,
            inferMs: 0,
          };
          blocked = true;
        } else {
          result = outcome.result;
          const effScore = effectiveBlockScore(result, settings.blockedLabels);
          blocked =
            settings.blockedLabels.includes(result.label) && effScore >= settings.blockThreshold;
          if (!blocked && classifyFailedClosed) {
            // Recovered during backoff with an allow verdict — the loud
            // fail-closed screen comes down (a block verdict overwrites it).
            classifyFailedClosed = false;
            void api.scripting
              .executeScript({ target: { tabId }, func: clearBlockScreen })
              .catch(() => {});
            // P2: if the tab picked up a fail-closed force redirect during
            // the backoff, release its session rule so this URL can load
            // again. (The blocked page itself stays displayed until the user
            // navigates — intentionally fail-closed; documented residual.)
            if (lock.forceBlocking) void clearForceRedirectRule(tabId, url);
          }
        }
      }
    }

    // A prior "this is actually productive" correction wins over the model
    // (and over a blocklist match, so overrides always have the final say) —
    // EXCEPT during a forced-blocking lock, whose whole point is that past
    // exceptions stop applying. Scoped to this page's hostname (red-team #14).
    if (blocked && !lock.forceBlocking && (await isOverridden(title ?? '', hostnameOf(url)))) {
      blocked = false;
    }

    // The user may have navigated again (e.g. pressed back) while classify()
    // was still running — arm() would have bumped the generation. Painting a
    // block screen for a page the user already left is worse than a missed
    // block, so drop the stale verdict if the tab moved to a different URL.
    // (If onHistoryStateUpdated bumped navGeneration for the SAME URL right
    // after changeInfo.title, keep the verdict!)
    if (blocked && navGeneration.get(tabId) !== myGeneration) {
      const latestUrl = armedUrl.get(tabId);
      if (latestUrl && latestUrl !== url) {
        blocked = false;
      }
    }

    let injectMs = 0;
    if (blocked) {
      const host = hostnameOf(url);
      if (host) {
        if (recentlyBlockedHosts.size >= 50) {
          const oldest = recentlyBlockedHosts.keys().next().value;
          if (oldest) recentlyBlockedHosts.delete(oldest);
        }
        recentlyBlockedHosts.add(host);
      }

      const tInject = Date.now();
      // P2: under a force-blocking lock, enforce via declarativeNetRequest
      // redirect to the extension-owned blocked page instead of the injected
      // overlay (main frames only — sub-frames keep masking/injection; see
      // force-redirect.ts). Memoized with the fail-closed first-failure hook:
      // at most one redirect per verdict. Non-force modes skip this entirely.
      let forceRedirected = false;
      if (lock.forceBlocking) {
        forceRedirected = await requestForceRedirect({
          title: title ?? '',
          label: result.label,
          score: result.score,
          ms: Date.now() - tTitle,
          reason: classifyFailedClosed ? 'classifier-unavailable' : 'dnf-redirect',
        });
      }
      if (!forceRedirected) {
        try {
          // Fail-closed: the "classifier unavailable" screen was already
          // injected on first failure — do NOT overwrite it with a normal
          // category verdict screen claiming 100% confidence. Exception:
          // under a force lock whose DNR redirect FAILED, the first failure
          // tried the redirect (not an injection), so ensure the loud screen
          // now — a failed DNR must never become a silent allow.
          if (classifyFailedClosed) {
            if (lock.forceBlocking) {
              await api.scripting.executeScript({
                target: { tabId },
                func: showClassifierUnavailableScreen,
                args: [title ?? ''],
              });
            }
          } else {
            await api.scripting.executeScript({
              target: { tabId },
              func: showBlockScreen,
              args: [
                result.label,
                result.score,
                title ?? '',
                Date.now() - tTitle,
                lock.settingsLocked,
                await mintOverrideToken(),
                settings.blockThreshold,
              ],
            });
          }
        } catch (e) {
          console.warn('[SmartBlocker] block screen injection failed:', e);
        }
      }
      injectMs = Date.now() - tInject;
    } else {
      // P2 verdict-clear: an allowed verdict releases the session rule this
      // URL may have picked up from an earlier fail-closed redirect (a no-op
      // when none exists, so non-force modes stay cheap).
      void clearForceRedirectRule(tabId, url);
      clearCurtain(tabId);
      clearOverlay(tabId);
      void runPageSanitizer(tabId);
    }

    await logSample({
      url,
      title: title ?? '',
      label: result.label,
      score: result.score,
      blocked,
      cached: result.cached,
      pageDelayMs,
      loadMs: result.loadMs,
      inferMs: result.inferMs,
      injectMs,
      totalMs: Date.now() - tTitle,
      ts: tTitle,
    });
  } finally {
    if (inFlightKey.get(tabId) === flightToken) {
      inFlightKey.delete(tabId);
    }
  }
}

/** Re-evaluate every open tab and embedded sub-frame — used by the lock
 *  enforcer when a blocking lock starts mid-session, and when settings change
 *  in storage.local, so already-open distracting tabs and embedded videos get
 *  blocked (or unblocked) without waiting for a navigation. */
export async function sweepOpenTabs(): Promise<void> {
  const tabs = await api.tabs.query({});
  // Evaluate active/foreground tabs first so the user sees instant feedback
  // when toggling protection or categories in the Popup or Options page.
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  for (const t of tabs) {
    if (t.id === undefined || !t.url || !isClassifiableUrl(t.url)) continue;
    lastClassified.delete(t.id); // bypass the title-flicker guard
    inFlightKey.delete(t.id);
    await onTitle(t.id, t.title ?? '', t.url).catch(() => {});

    let frames: { frameId: number; url: string; errorOccurred?: boolean }[] = [];
    try {
      frames = (await api.webNavigation.getAllFrames({ tabId: t.id })) ?? [];
    } catch {
      continue;
    }
    for (const f of frames) {
      if (f.frameId === 0 || f.errorOccurred || !isClassifiableUrl(f.url)) continue;
      const key = subFrameKey(t.id, f.frameId);
      subFrameLastClassified.delete(key);
      subFrameInFlightKey.delete(key);
      subFrameBlockedVerdict.delete(key);
      await onSubFrame(t.id, f.frameId, f.url, 'completed').catch(() => {});
    }
  }
}

const SETTINGS_SWEEP_KEYS: (keyof Settings)[] = [
  'enabled',
  'blockedLabels',
  'blockThreshold',
  'blocklist',
  'whitelist',
  'focusGoal',
  'useTabContext',
];

let settingsSweepTimer: ReturnType<typeof setTimeout> | undefined;

export function initBlocker() {
  // P2: force-mode DNR redirect lifecycle (unlock/expiry release, tab-close
  // cleanup, SW-restart session-rule reconciliation). Registers its own
  // listeners synchronously per MV3 rules; a no-op if DNR is unavailable.
  initForceRedirectLifecycle();

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['settings']) return;
    const oldVal = changes['settings'].oldValue as Partial<Settings> | undefined;
    const newVal = changes['settings'].newValue as Partial<Settings> | undefined;
    if (!newVal) return;
    const shouldSweep =
      !oldVal ||
      SETTINGS_SWEEP_KEYS.some(
        (k) => JSON.stringify(oldVal[k]) !== JSON.stringify(newVal[k]),
      );
    if (shouldSweep) {
      if (settingsSweepTimer) clearTimeout(settingsSweepTimer);
      settingsSweepTimer = setTimeout(() => {
        settingsSweepTimer = undefined;
        void sweepOpenTabs();
      }, 80);
    }
  });

  api.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) {
      arm(d.tabId, d.url);
    } else if (d.frameId > 0 && isClassifiableUrl(d.url)) {
      if (isEmbedSubFrameUrl(d.url)) {
        void runPageSanitizer(d.tabId);
      }
      void armSubFrame(d.tabId, d.frameId, d.url).then(() =>
        onSubFrame(d.tabId, d.frameId, d.url, 'committed'),
      );
    }
  });
  api.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId > 0 && isClassifiableUrl(d.url)) {
      void onSubFrame(d.tabId, d.frameId, d.url, 'completed');
    }
  });
  api.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId === 0) {
      arm(d.tabId, d.url);
    } else if (d.frameId > 0 && isClassifiableUrl(d.url)) {
      void armSubFrame(d.tabId, d.frameId, d.url).then(() =>
        onSubFrame(d.tabId, d.frameId, d.url, 'completed'),
      );
    }
  });
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab.url || !isClassifiableUrl(tab.url)) return;
    if (changeInfo.title) {
      void onTitle(tabId, changeInfo.title, tab.url).catch((e) =>
        console.error('[SmartBlocker] classification failed:', e),
      );
    } else if (changeInfo.status === 'complete' && armedAt.has(tabId)) {
      void onTitle(tabId, tab.title ?? '', tab.url).catch((e) =>
        console.error('[SmartBlocker] classification failed:', e),
      );
    }
  });
  api.tabs.onRemoved.addListener((tabId) => {
    clearTabTimers(tabId);
    armedAt.delete(tabId);
    armedUrl.delete(tabId);
    lastClassified.delete(tabId);
    inFlightKey.delete(tabId);
    navGeneration.delete(tabId);
    clearSubFrameStateForTab(tabId);
  });
}
