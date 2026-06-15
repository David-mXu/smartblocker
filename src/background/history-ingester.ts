import { api } from '../shared/api';
import { HISTORY_CAP } from '../shared/config';
import type { HistoryScanState } from '../shared/messages';
import { getSettings } from '../shared/settings';
import { cleanTitle, isClassifiableUrl, isWhitelisted } from '../shared/titles';
import { classify } from './classifier';

const CHUNK_SIZE = 10;

let running = false;

async function writeState(state: HistoryScanState) {
  await api.storage.local.set({ historyScan: state });
}

export async function scanHistory(): Promise<void> {
  if (running) return;
  running = true;
  const t0 = Date.now();

  const state: HistoryScanState = {
    status: 'running',
    done: 0,
    total: 0,
    items: [],
    categoryCounts: {},
    elapsedMs: 0,
  };

  try {
    // FlowGuard now watches all sites, so scan all history (empty query) and
    // filter to classifiable, non-whitelisted pages — same gates as the live
    // blocker. Most-recent first; capped at HISTORY_CAP.
    const { whitelist } = await getSettings();
    const items = await api.history.search({ text: '', startTime: 0, maxResults: 1000 });

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
        const r = await classify({ title });
        state.items.push({ title, url, label: r.label, score: r.score });
        state.categoryCounts[r.label] = (state.categoryCounts[r.label] ?? 0) + 1;
        state.done++;
      }
      state.elapsedMs = Date.now() - t0;
      // Chunked writes double as the MV3 service-worker keep-alive: any
      // extension-API call resets the idle timer (Chrome 110+).
      await writeState(state);
      console.log(`[FlowGuard] history scan ${state.done}/${state.total}`);
    }

    state.status = 'done';
  } catch (e) {
    state.status = 'error';
    state.error = String(e);
    console.error('[FlowGuard] history scan failed:', e);
  } finally {
    state.elapsedMs = Date.now() - t0;
    await writeState(state);
    running = false;
  }
}
