import { api } from '../shared/api';
import { clearFeedback, getFeedback } from '../shared/feedback';
import { LABELS } from '../shared/config';
import type { HistoryScanState } from '../shared/messages';
import { getSettings, setSettings } from '../shared/settings';
import { dismissSuggestion, getSuggestions, type Suggestion } from '../shared/suggestions';
import { clearUsage, dayKey, getUsage } from '../shared/usage-stats';

/** The set of canonical built-in labels, used to tell built-in from custom. */
const BUILTIN_LABELS = new Set(LABELS);

// ---------------------------------------------------------------------------
// Labels that are considered "productive" — not candidates for auto-blocking.
// ---------------------------------------------------------------------------
const PRODUCTIVE_LABELS = new Set([
  'programming and software development',
  'science and education',
  'finance and investing',
  'news and politics',
]);

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const banner = document.getElementById('banner') as HTMLDivElement;
const enabledToggle = document.getElementById('enabled-toggle') as HTMLInputElement;
const labelList = document.getElementById('label-list') as HTMLUListElement;
const thresholdInput = document.getElementById('threshold') as HTMLInputElement;
const thresholdVal = document.getElementById('threshold-val') as HTMLSpanElement;
const whitelistInput = document.getElementById('whitelist') as HTMLTextAreaElement;
const blocklistInput = document.getElementById('blocklist') as HTMLTextAreaElement;
const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
const blockTopBtn = document.getElementById('block-top-btn') as HTMLButtonElement;
const scanStatus = document.getElementById('scan-status') as HTMLDivElement;
const scanOut = document.getElementById('scan-out') as HTMLPreElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const saveMsg = document.getElementById('save-msg') as HTMLSpanElement;
const feedbackCount = document.getElementById('feedback-count') as HTMLSpanElement;
const feedbackExportBtn = document.getElementById('feedback-export') as HTMLButtonElement;
const feedbackClearBtn = document.getElementById('feedback-clear') as HTMLButtonElement;
const shareToggle = document.getElementById('share-toggle') as HTMLInputElement;
const modelProgress = document.getElementById('model-progress') as HTMLSpanElement;
const customCategoryInput = document.getElementById('custom-category-input') as HTMLInputElement;
const addCategoryBtn = document.getElementById('add-category-btn') as HTMLButtonElement;
const trackToggle = document.getElementById('track-toggle') as HTMLInputElement;
const habitsSuggestions = document.getElementById('habits-suggestions') as HTMLDivElement;
const habitsEmpty = document.getElementById('habits-empty') as HTMLDivElement;
const habitsDash = document.getElementById('habits-dash') as HTMLDivElement;
const habitsSummary = document.getElementById('habits-summary') as HTMLDivElement;
const habitsCats = document.getElementById('habits-cats') as HTMLDivElement;
const habitsTrend = document.getElementById('habits-trend') as HTMLDivElement;
const habitsDomains = document.getElementById('habits-domains') as HTMLTableElement;
const usageClearBtn = document.getElementById('usage-clear') as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentLabels: string[] = [];
/** Tracks which categories the user has checked in the UI (before saving). */
const checkedBlocked = new Set<string>();
/** Built-in labels the user has explicitly deleted (persisted to prevent re-add on update). */
const deletedBuiltins = new Set<string>();
let isOnboarded = false;
/** Last scan result used by "Block my top distractions". */
let lastScanCounts: Record<string, number> = {};
let pollTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Parse the whitelist textarea into normalized, deduped hostnames. */
function parseWhitelist(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const host = line
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '') // strip scheme if pasted as a URL
      .replace(/\/.*$/, '') // strip path
      .replace(/^www\./, '');
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** Parse the blocklist textarea into trimmed, deduped free-text entries.
 *  Unlike parseWhitelist, entries are arbitrary substrings (not just
 *  hostnames), so no scheme/path/www stripping — just trim + dedupe. */
function parseBlocklist(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const entry = line.trim();
    const key = entry.toLowerCase();
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function buildLabelRows(): void {
  labelList.innerHTML = '';
  for (const label of currentLabels) {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `lbl-${label}`;
    checkbox.checked = checkedBlocked.has(label);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        checkedBlocked.add(label);
      } else {
        checkedBlocked.delete(label);
      }
    });

    const span = document.createElement('span');
    span.className = 'label-name';
    span.textContent = label;
    span.style.cursor = 'pointer';
    span.addEventListener('click', () => {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-label-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Remove category';
    deleteBtn.addEventListener('click', () => removeCategory(label));

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(deleteBtn);
    labelList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Add / remove categories
// ---------------------------------------------------------------------------
function addCategory(raw: string): void {
  const label = raw.trim().toLowerCase();
  if (!label) return;
  if (currentLabels.includes(label)) {
    customCategoryInput.value = '';
    customCategoryInput.placeholder = 'Category already exists';
    setTimeout(() => { customCategoryInput.placeholder = 'e.g. cooking and recipes'; }, 2000);
    return;
  }
  currentLabels.push(label);
  checkedBlocked.add(label); // auto-block: why add it if not to block it?
  // If re-adding a previously deleted built-in, un-track the deletion.
  deletedBuiltins.delete(label);
  customCategoryInput.value = '';
  buildLabelRows();
}

function removeCategory(label: string): void {
  currentLabels = currentLabels.filter((l) => l !== label);
  checkedBlocked.delete(label);
  // Track deletion of built-in labels so migrateLabels() won't re-add them.
  if (BUILTIN_LABELS.has(label)) {
    deletedBuiltins.add(label);
  }
  buildLabelRows();
}

// ---------------------------------------------------------------------------
// Load settings and populate UI
// ---------------------------------------------------------------------------
async function loadSettings(): Promise<void> {
  const s = await getSettings();

  isOnboarded = s.onboarded;
  currentLabels = [...s.labels];

  checkedBlocked.clear();
  for (const l of s.blockedLabels) checkedBlocked.add(l);

  deletedBuiltins.clear();
  for (const l of s.deletedBuiltinLabels) deletedBuiltins.add(l);

  enabledToggle.checked = s.enabled;

  thresholdInput.value = String(s.blockThreshold);
  thresholdVal.textContent = pct(s.blockThreshold);

  whitelistInput.value = s.whitelist.join('\n');
  blocklistInput.value = s.blocklist.join('\n');
  shareToggle.checked = s.shareFeedback;
  trackToggle.checked = s.trackUsage;

  buildLabelRows();
  await refreshFeedbackCount();
  void renderHabits();

  if (!isOnboarded) {
    banner.style.display = 'block';
    saveBtn.textContent = 'Finish setup';
  } else {
    banner.style.display = 'none';
    saveBtn.textContent = 'Save';
  }
}

// ---------------------------------------------------------------------------
// Custom category input
// ---------------------------------------------------------------------------
addCategoryBtn.addEventListener('click', () => {
  addCategory(customCategoryInput.value);
});
customCategoryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addCategory(customCategoryInput.value);
  }
});

// ---------------------------------------------------------------------------
// Threshold slider live update
// ---------------------------------------------------------------------------
thresholdInput.addEventListener('input', () => {
  thresholdVal.textContent = pct(parseFloat(thresholdInput.value));
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
saveBtn.addEventListener('click', async () => {
  const whitelist = parseWhitelist(whitelistInput.value);
  whitelistInput.value = whitelist.join('\n'); // reflect the normalized list back
  const blocklist = parseBlocklist(blocklistInput.value);
  blocklistInput.value = blocklist.join('\n'); // reflect the normalized list back
  const patch: Parameters<typeof setSettings>[0] = {
    enabled: enabledToggle.checked,
    labels: currentLabels,
    blockedLabels: [...checkedBlocked],
    blockThreshold: parseFloat(thresholdInput.value),
    whitelist,
    blocklist,
    shareFeedback: shareToggle.checked,
    deletedBuiltinLabels: [...deletedBuiltins],
  };
  if (!isOnboarded) {
    patch.onboarded = true;
    isOnboarded = true;
    banner.style.display = 'none';
    saveBtn.textContent = 'Save';
  }
  await setSettings(patch);

  // Flash the "Saved!" message
  saveMsg.classList.add('visible');
  setTimeout(() => saveMsg.classList.remove('visible'), 2000);
});

// ---------------------------------------------------------------------------
// History scan
// ---------------------------------------------------------------------------
function renderScan(s: HistoryScanState | undefined): void {
  if (!s) {
    scanOut.textContent = 'No scan data yet.';
    scanOut.style.display = 'block';
    return;
  }
  lastScanCounts = s.categoryCounts;
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

  scanOut.textContent =
    `Scan ${s.status}: ${s.done}/${s.total} titles in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
    (s.error ? `Error: ${s.error}\n` : '') +
    zeroHint +
    `\nCategories:\n${counts || '  (none yet)'}`;
  scanOut.style.display = 'block';

  if (s.status === 'done' && Object.keys(lastScanCounts).length > 0) {
    blockTopBtn.style.display = 'inline-block';
  }
}

scanBtn.addEventListener('click', async () => {
  scanStatus.textContent = 'Scanning history…';
  blockTopBtn.style.display = 'none';
  scanOut.style.display = 'none';
  lastScanCounts = {};
  clearInterval(pollTimer);

  await api.runtime.sendMessage({ type: 'SCAN_HISTORY' });

  pollTimer = setInterval(async () => {
    const { historyScan } = await api.storage.local.get('historyScan');
    const state = historyScan as HistoryScanState | undefined;
    renderScan(state);
    if (state && state.status !== 'running') {
      clearInterval(pollTimer);
      scanStatus.textContent = '';
    }
  }, 1000);
});

// ---------------------------------------------------------------------------
// "Block my top distractions" convenience button
// ---------------------------------------------------------------------------
blockTopBtn.addEventListener('click', () => {
  // Sort categories by descending count, take those NOT in the productive set.
  const topDistractions = Object.entries(lastScanCounts)
    .filter(([label]) => !PRODUCTIVE_LABELS.has(label))
    .sort((a, b) => b[1] - a[1])
    // Pre-check at most the top 3 distraction categories to avoid being too aggressive.
    .slice(0, 3)
    .map(([label]) => label);

  for (const label of topDistractions) {
    checkedBlocked.add(label);
  }

  // Refresh checkboxes to reflect the new state
  buildLabelRows();
});

// ---------------------------------------------------------------------------
// Feedback: local corrections — count, export as JSON, clear
// ---------------------------------------------------------------------------
async function refreshFeedbackCount(): Promise<void> {
  feedbackCount.textContent = String((await getFeedback()).length);
}

feedbackExportBtn.addEventListener('click', async () => {
  const records = await getFeedback();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flowguard-feedback-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

feedbackClearBtn.addEventListener('click', async () => {
  await clearFeedback();
  await refreshFeedbackCount();
});

// ---------------------------------------------------------------------------
// Habits: usage dashboard + suggestions (see shared/usage-stats.ts,
// shared/suggestions.ts). Everything here is local-only, hostname-level data.
// ---------------------------------------------------------------------------
function fmtMs(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return ms > 0 ? '<1m' : '0m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function renderSuggestions(list: Suggestion[]): void {
  habitsSuggestions.innerHTML = '';
  for (const sg of list) {
    const card = document.createElement('div');
    card.className = 'suggestion';

    const text = document.createElement('div');
    text.className = 'sg-text';
    const head = document.createElement('div');
    head.textContent =
      sg.kind === 'blocklist'
        ? `Add ${sg.domain} to your blocklist?`
        : `Whitelist ${sg.domain}?`;
    const reason = document.createElement('div');
    reason.className = 'sg-reason';
    reason.textContent = sg.reason;
    text.appendChild(head);
    text.appendChild(reason);

    const apply = document.createElement('button');
    apply.className = 'sg-apply';
    apply.textContent = 'Apply';
    apply.addEventListener('click', async () => {
      // Suggestions only ever act through the existing whitelist/blocklist
      // settings — never directly into the classifier.
      if (sg.kind === 'blocklist') {
        const blocklist = parseBlocklist(`${blocklistInput.value}\n${sg.domain}`);
        blocklistInput.value = blocklist.join('\n');
        await setSettings({ blocklist });
      } else {
        const whitelist = parseWhitelist(`${whitelistInput.value}\n${sg.domain}`);
        whitelistInput.value = whitelist.join('\n');
        await setSettings({ whitelist });
      }
      void renderHabits();
    });

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', async () => {
      await dismissSuggestion(sg.kind, sg.domain);
      void renderHabits();
    });

    card.appendChild(text);
    card.appendChild(apply);
    card.appendChild(dismiss);
    habitsSuggestions.appendChild(card);
  }
}

async function renderHabits(): Promise<void> {
  const s = await getSettings();
  const usage = await getUsage(7);

  renderSuggestions(await getSuggestions(s));

  let totalMs = 0;
  let totalVisits = 0;
  const byLabel = new Map<string, number>();
  const byDomain = new Map<string, { visits: number; focusMs: number; label: string }>();
  const byDay = new Map<string, number>();
  for (const [day, entry] of Object.entries(usage)) {
    for (const [domain, st] of Object.entries(entry)) {
      totalMs += st.focusMs;
      totalVisits += st.visits;
      byLabel.set(st.label, (byLabel.get(st.label) ?? 0) + st.focusMs);
      const d = byDomain.get(domain) ?? { visits: 0, focusMs: 0, label: st.label };
      d.visits += st.visits;
      d.focusMs += st.focusMs;
      d.label = st.label;
      byDomain.set(domain, d);
      byDay.set(day, (byDay.get(day) ?? 0) + st.focusMs);
    }
  }

  const hasData = totalVisits > 0 || totalMs > 0;
  habitsDash.style.display = hasData ? 'block' : 'none';
  habitsEmpty.textContent = hasData
    ? ''
    : s.trackUsage
      ? 'No usage data yet — browse for a while and come back.'
      : 'Turn on tracking to build your habits dashboard.';
  if (!hasData) return;

  // Summary stat tiles.
  habitsSummary.innerHTML = '';
  const topCat = [...byLabel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
  const tiles: Array<[string, string]> = [
    ['Focused time', fmtMs(totalMs)],
    ['Visits', String(totalVisits)],
    ['Top category', topCat],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'stat-tile';
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    v.title = value;
    tile.appendChild(l);
    tile.appendChild(v);
    habitsSummary.appendChild(tile);
  }

  // Focused time by category — horizontal bars, top 10.
  habitsCats.innerHTML = '';
  const cats = [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxCat = Math.max(cats[0]?.[1] ?? 0, 1);
  for (const [label, ms] of cats) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const name = document.createElement('div');
    name.className = 'hbar-name';
    name.textContent = label;
    name.title = label;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = `${(ms / maxCat) * 100}%`;
    track.appendChild(fill);
    const val = document.createElement('div');
    val.className = 'hbar-val';
    val.textContent = fmtMs(ms);
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(val);
    habitsCats.appendChild(row);
  }

  // Daily focused time — 7 columns, value labeled only on the peak day.
  habitsTrend.innerHTML = '';
  const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(dayKey(Date.now() - i * 24 * 60 * 60 * 1000));
  const maxDay = Math.max(...days.map((d) => byDay.get(d) ?? 0), 1);
  for (const day of days) {
    const ms = byDay.get(day) ?? 0;
    const col = document.createElement('div');
    col.className = 'trend-col';
    if (ms === maxDay) {
      const cap = document.createElement('div');
      cap.className = 'trend-cap';
      cap.textContent = fmtMs(ms);
      col.appendChild(cap);
    }
    const fill = document.createElement('div');
    fill.className = 'trend-fill';
    // 96px container minus 16px label headroom; keep a sliver for non-zero days.
    fill.style.height = `${ms > 0 ? Math.max(2, Math.round((ms / maxDay) * 72)) : 0}px`;
    col.appendChild(fill);
    const wd = document.createElement('div');
    wd.className = 'trend-day';
    wd.textContent = dayNames[new Date(`${day}T12:00:00`).getDay()];
    col.appendChild(wd);
    habitsTrend.appendChild(col);
  }

  // Top sites table.
  habitsDomains.innerHTML = '';
  const header = document.createElement('tr');
  for (const [text, cls] of [
    ['Site', ''],
    ['Category', ''],
    ['Visits', 'num'],
    ['Time', 'num'],
  ] as const) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    header.appendChild(th);
  }
  habitsDomains.appendChild(header);
  const topDomains = [...byDomain.entries()]
    .sort((a, b) => b[1].focusMs - a[1].focusMs)
    .slice(0, 10);
  for (const [domain, d] of topDomains) {
    const tr = document.createElement('tr');
    const tdDomain = document.createElement('td');
    tdDomain.textContent = domain;
    const tdLabel = document.createElement('td');
    tdLabel.className = 'domain-label';
    tdLabel.textContent = d.label;
    const tdVisits = document.createElement('td');
    tdVisits.className = 'num';
    tdVisits.textContent = String(d.visits);
    const tdTime = document.createElement('td');
    tdTime.className = 'num';
    tdTime.textContent = fmtMs(d.focusMs);
    tr.append(tdDomain, tdLabel, tdVisits, tdTime);
    habitsDomains.appendChild(tr);
  }
}

// The Habits section is self-contained: the toggle applies immediately rather
// than waiting for the Save button (and Save never touches trackUsage).
trackToggle.addEventListener('change', async () => {
  await setSettings({ trackUsage: trackToggle.checked });
  void renderHabits();
});

usageClearBtn.addEventListener('click', async () => {
  await clearUsage();
  void renderHabits();
});

// ---------------------------------------------------------------------------
// Model Progress Listener
// ---------------------------------------------------------------------------
api.runtime.onMessage.addListener((message) => {
  if (message.type === 'MODEL_PROGRESS') {
    modelProgress.style.display = 'inline-block';
    if (message.status === 'init' || message.status === 'ready') {
      modelProgress.textContent = `Model ${message.status}...`;
    } else if (message.status === 'progress' && message.progress != null) {
      modelProgress.textContent = `Downloading AI model: ${message.progress.toFixed(0)}%`;
    } else if (message.status === 'done') {
      modelProgress.textContent = 'AI model ready';
      setTimeout(() => {
        modelProgress.style.display = 'none';
      }, 5000);
    }
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadSettings();
