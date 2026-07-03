import { api } from '../shared/api';
import { getSettings } from '../shared/settings';
import type {
  HistoryScanState,
  LatencySample,
  TestPairResponse,
} from '../shared/messages';

const out = document.getElementById('out') as HTMLPreElement;
const status = document.getElementById('status') as HTMLDivElement;

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

// ---- "Should've been blocked" (false-negative feedback) ----
// Reports the ACTIVE tab: records a correction the classifier learns from
// (and that the user can export/share from the options page).
const reportCategory = document.getElementById('report-category') as HTMLSelectElement;
const reportBtn = document.getElementById('report-fn') as HTMLButtonElement;

void getSettings().then(({ labels }) => {
  for (const label of labels) {
    const opt = document.createElement('option');
    opt.value = label;
    opt.textContent = label;
    reportCategory.appendChild(opt);
  }
});

reportBtn.addEventListener('click', async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.title || !tab.url) {
    status.textContent = 'No reportable page in the active tab.';
    return;
  }
  const res = await api.runtime.sendMessage({
    type: 'REPORT_FN' as const,
    title: tab.title,
    url: tab.url,
    correctedLabel: reportCategory.value,
  });
  status.textContent = res?.ok
    ? `Recorded: "${tab.title}" → ${reportCategory.value}`
    : `Report failed: ${res?.error ?? 'no response'}`;
});

// ---- Test Pair ----
document.getElementById('test-pair')!.addEventListener('click', async () => {
  status.textContent = 'Classifying… (first run downloads the model)';
  out.textContent = '';
  const res: TestPairResponse = await api.runtime.sendMessage({ type: 'TEST_PAIR' });
  status.textContent = '';
  if (!res?.ok || !res.results) {
    out.textContent = `Error: ${res?.error ?? 'no response from background'}`;
    return;
  }
  out.textContent = res.results
    .map((r) => {
      const dist = r.all.labels
        .map((l, i) => `  ${pct(r.all.scores[i]).padStart(4)} ${l}`)
        .join('\n');
      return (
        `"${r.text}"\n-> ${r.label} (${pct(r.score)})` +
        `${r.cached ? ' [cached]' : ` [load ${Math.round(r.loadMs)}ms, infer ${Math.round(r.inferMs)}ms]`}\n${dist}`
      );
    })
    .join('\n\n');
});

// ---- Scan History ----
let pollTimer: ReturnType<typeof setInterval> | undefined;

function renderScan(s: HistoryScanState | undefined) {
  if (!s) {
    out.textContent = 'No scan data yet.';
    return;
  }
  const counts = Object.entries(s.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `  ${String(n).padStart(4)}  ${label}`)
    .join('\n');
  const zeroHint =
    s.status === 'done' && s.total === 0
      ? s.historyCount === 0
        ? '\n(No browsing history found.)'
        : `\n(Found ${s.historyCount} history entries, but all were on your whitelist, ` +
          `already-seen titles, or too generic to classify.)`
      : '';
  out.textContent =
    `Scan ${s.status}: ${s.done}/${s.total} titles in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
    (s.error ? `Error: ${s.error}\n` : '') +
    zeroHint +
    `\nCategories:\n${counts || '  (none yet)'}\n\nLatest:\n` +
    s.items
      .slice(-10)
      .map((i) => `  [${i.label} ${pct(i.score)}] ${i.title}`)
      .join('\n');
}

document.getElementById('scan-history')!.addEventListener('click', async () => {
  status.textContent = 'Scanning history…';
  await api.runtime.sendMessage({ type: 'SCAN_HISTORY' });
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { historyScan } = await api.storage.local.get('historyScan');
    renderScan(historyScan);
    if (historyScan && historyScan.status !== 'running') {
      clearInterval(pollTimer);
      status.textContent = '';
    }
  }, 1000);
});

// ---- Options ----
document.getElementById('open-options')!.addEventListener('click', () => {
  api.runtime.openOptionsPage();
});

// ---- Latency Log ----
document.getElementById('latency-log')!.addEventListener('click', async () => {
  status.textContent = '';
  const { latencySamples = [] } = await api.storage.local.get('latencySamples');
  if (!latencySamples.length) {
    out.textContent = 'No latency samples yet — visit a YouTube/Reddit page.';
    return;
  }
  out.textContent = (latencySamples as LatencySample[])
    .slice()
    .reverse()
    .map(
      (s) =>
        `${s.blocked ? 'BLOCK' : 'allow'} [${s.label} ${pct(s.score)}] "${s.title}"\n` +
        `  pageDelay ${s.pageDelayMs}ms | load ${Math.round(s.loadMs)}ms | ` +
        `infer ${Math.round(s.inferMs)}ms | inject ${Math.round(s.injectMs)}ms | ` +
        `total ${Math.round(s.totalMs)}ms${s.cached ? ' (cached)' : ''}`,
    )
    .join('\n\n');
});
