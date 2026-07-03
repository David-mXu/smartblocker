import { api } from '../shared/api';
import { clearFeedback, getFeedback } from '../shared/feedback';
import { LABELS } from '../shared/config';
import type { HistoryScanState } from '../shared/messages';
import { getSettings, setSettings } from '../shared/settings';

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

  buildLabelRows();
  await refreshFeedbackCount();

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
