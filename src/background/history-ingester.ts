import { api } from '../shared/api';
import { HISTORY_CAP } from '../shared/config';
import type { HistoryScanState } from '../shared/messages';
import { getSettings } from '../shared/settings';
import { cleanTitle, isClassifiableUrl, isWhitelisted, matchedBlocklistEntry } from '../shared/titles';
import { classify } from './classifier';

const CHUNK_SIZE = 10;

let running = false;

async function writeState(state: HistoryScanState) {
  await api.storage.local.set({ historyScan: state });
}

/**
 * SW-startup self-heal for a scan that died with a reaped service worker:
 * storage keeps `status: 'running'` forever, but nothing is scanning. At
 * startup `running` is false and Chrome never runs two extension service
 * workers at once, so a stored 'running' seen here is always a dead scan —
 * flip it to an error so the UI stops waiting instead of showing phantom
 * progress. The durable `historyScanStartedAt` marker written at scan start
 * feeds the log line (and lets a future reader measure how far it got).
 */
export async function healStaleHistoryScan(): Promise<void> {
  if (running) return;
  const { historyScan, historyScanStartedAt } = (await api.storage.local.get([
    'historyScan',
    'historyScanStartedAt',
  ])) as { historyScan?: HistoryScanState; historyScanStartedAt?: number };
  // Re-check after the await: a SCAN_HISTORY message may have been handled
  // meanwhile and a live scan in THIS worker owns the record now.
  if (running || historyScan?.status !== 'running') return;
  console.warn(
    `[SmartBlocker] stale history scan found (started ${
      typeof historyScanStartedAt === 'number'
        ? `${Math.round((Date.now() - historyScanStartedAt) / 1000)}s ago`
        : 'before the start marker shipped'
    }) — marking it interrupted`,
  );
  await api.storage.local.set({
    historyScan: {
      ...historyScan,
      status: 'error',
      error: 'Interrupted: the background worker restarted before the scan finished. Run it again.',
    },
  });
}

export async function scanHistory(): Promise<void> {
  if (running) return;
  running = true;
  // Durable start marker — see healStaleHistoryScan(). A mid-scan SW reap
  // also resets the in-memory `running` flag, so the flag alone can't tell
  // the next worker the stored 'running' is dead; the healer at SW boot can.
  // A fresh scan started from the UI overwrites the stored state anyway, so
  // the leftover record only lingers between boots, where the healer
  // catches it.
  await api.storage.local.set({ historyScanStartedAt: Date.now() });
  const t0 = Date.now();

  const state: HistoryScanState = {
    status: 'running',
    done: 0,
    total: 0,
    historyCount: 0,
    items: [],
    categoryCounts: {},
    elapsedMs: 0,
  };

  try {
    // SmartBlocker now watches all sites, so scan all history (empty query) and
    // filter to classifiable, non-whitelisted pages — same gates as the live
    // blocker. Most-recent first; capped at HISTORY_CAP.
    const { whitelist, blocklist } = await getSettings();
    const items = await api.history.search({ text: '', startTime: 0, maxResults: 1000 });
    state.historyCount = items.length;

    const seen = new Set<string>();
    const targets: { title: string; url: string }[] = [];
    for (const item of items) {
      if (targets.length >= HISTORY_CAP) break;
      if (!item.url || !item.title || !isClassifiableUrl(item.url)) continue;
      if (isWhitelisted(item.url, whitelist)) continue;
      const title = cleanTitle(item.title);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      targets.push({ title, url: item.url });
    }

    state.total = targets.length;
    await writeState(state);

    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      for (const { title, url } of chunk) {
        // Same short-circuit as the live blocker: a blocklist match is counted
        // without spending an inference on it.
        const blocklistHit = matchedBlocklistEntry(url, title, blocklist);
        const r = blocklistHit
          ? { label: `blocked rule: "${blocklistHit}"`, score: 1 }
          : await classify({ title });
        state.items.push({ title, url, label: r.label, score: r.score });
        state.categoryCounts[r.label] = (state.categoryCounts[r.label] ?? 0) + 1;
        state.done++;
      }
      state.elapsedMs = Date.now() - t0;
      // Chunked writes double as the MV3 service-worker keep-alive: any
      // extension-API call resets the idle timer (Chrome 110+).
      await writeState(state);
      console.log(`[SmartBlocker] history scan ${state.done}/${state.total}`);
    }

    state.status = 'done';
  } catch (e) {
    state.status = 'error';
    state.error = String(e);
    console.error('[SmartBlocker] history scan failed:', e);
  } finally {
    state.elapsedMs = Date.now() - t0;
    await writeState(state);
    running = false;
  }
}
