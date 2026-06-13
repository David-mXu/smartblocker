import { api } from '../shared/api';
import type { HistoryScanState } from '../shared/messages';
import { getSettings, setSettings } from '../shared/settings';

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
const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
const blockTopBtn = document.getElementById('block-top-btn') as HTMLButtonElement;
const scanStatus = document.getElementById('scan-status') as HTMLDivElement;
const scanOut = document.getElementById('scan-out') as HTMLPreElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const saveMsg = document.getElementById('save-msg') as HTMLSpanElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentLabels: string[] = [];
/** Tracks which categories the user has checked in the UI (before saving). */
const checkedBlocked = new Set<string>();
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

    li.appendChild(checkbox);
    li.appendChild(span);
    labelList.appendChild(li);
  }
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

  enabledToggle.checked = s.enabled;

  thresholdInput.value = String(s.blockThreshold);
  thresholdVal.textContent = pct(s.blockThreshold);

  buildLabelRows();

  if (!isOnboarded) {
    banner.style.display = 'block';
    saveBtn.textContent = 'Finish setup';
  } else {
    banner.style.display = 'none';
    saveBtn.textContent = 'Save';
  }
}

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
  const patch: Parameters<typeof setSettings>[0] = {
    enabled: enabledToggle.checked,
    labels: currentLabels,
    blockedLabels: [...checkedBlocked],
    blockThreshold: parseFloat(thresholdInput.value),
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

  scanOut.textContent =
    `Scan ${s.status}: ${s.done}/${s.total} titles in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
    (s.error ? `Error: ${s.error}\n` : '') +
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
// Boot
// ---------------------------------------------------------------------------
loadSettings();
