import { api } from '../shared/api';
import { clearFeedback, getFeedback } from '../shared/feedback';
import { LABELS } from '../shared/config';
import type { HistoryScanState } from '../shared/messages';
import { getSettings, setSettings } from '../shared/settings';
import {
  armPasswordLock,
  attemptPasswordUnlock,
  getLockState,
  getLockStatus,
  setSchedules,
  startTimerLock,
} from '../shared/lock';
import type { LockStatus, ScheduleRule } from '../shared/lock-math';

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
const lockStatusEl = document.getElementById('lock-status') as HTMLDivElement;
const lockDurationInput = document.getElementById('lock-duration') as HTMLInputElement;
const lockUnitSelect = document.getElementById('lock-unit') as HTMLSelectElement;
const lockTimerBtn = document.getElementById('lock-timer-btn') as HTMLButtonElement;
const lockPasswordInput = document.getElementById('lock-password') as HTMLInputElement;
const lockPasswordBtn = document.getElementById('lock-password-btn') as HTMLButtonElement;
const lockPasswordMsg = document.getElementById('lock-password-msg') as HTMLSpanElement;
const scheduleList = document.getElementById('schedule-list') as HTMLDivElement;
const scheduleAddBtn = document.getElementById('schedule-add') as HTMLButtonElement;
const scheduleSaveBtn = document.getElementById('schedule-save') as HTMLButtonElement;
const scheduleMsg = document.getElementById('schedule-msg') as HTMLSpanElement;

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
/** True while any lock source is active — set by applyLockUI(). */
let locked = false;
/** Only rebuild control rows when lockedness flips, not every countdown tick. */
let lastRenderedLocked: boolean | null = null;
let passwordArmed = false;
let scheduleRules: ScheduleRule[] = [];

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
    checkbox.disabled = locked;
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
    span.style.cursor = locked ? 'default' : 'pointer';
    span.addEventListener('click', () => {
      if (locked) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-label-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Remove category';
    deleteBtn.disabled = locked;
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

  scheduleRules = (await getLockState()).schedules.map((r) => ({ ...r, days: [...r.days] }));
  await applyLockUI();
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
// Lock section: status banner, disable-while-locked, timer/password locks,
// and the scheduled-blocks editor. Lock transitions act IMMEDIATELY through
// lock.ts (not via the Save button — setSettings would reject while locked,
// and locks live in their own storage key anyway).
// ---------------------------------------------------------------------------
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REASON_NAMES: Record<LockStatus['reasons'][number], string> = {
  timer: 'timer lock',
  password: 'password lock',
  frozen: 'Frozen Turkey',
  schedule: 'scheduled block',
};

function formatRemaining(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function minutesToHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function hhmmToMinutes(v: string): number {
  const [h = 0, m = 0] = v.split(':').map(Number);
  return h * 60 + m;
}

function buildScheduleRows(): void {
  scheduleList.innerHTML = '';
  for (const rule of scheduleRules) {
    const row = document.createElement('div');
    row.className = 'schedule-row';

    for (let d = 0; d < 7; d++) {
      const dayLabel = document.createElement('label');
      dayLabel.className = 'day-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = rule.days.includes(d);
      cb.disabled = locked;
      cb.addEventListener('change', () => {
        rule.days = cb.checked
          ? [...rule.days, d].sort((a, b) => a - b)
          : rule.days.filter((x) => x !== d);
      });
      dayLabel.append(cb, document.createTextNode(DAY_NAMES[d]));
      row.appendChild(dayLabel);
    }

    const start = document.createElement('input');
    start.type = 'time';
    start.value = minutesToHHMM(rule.startMinutes);
    start.disabled = locked;
    start.addEventListener('change', () => {
      rule.startMinutes = hhmmToMinutes(start.value);
    });
    const sep = document.createElement('span');
    sep.textContent = '–';
    const end = document.createElement('input');
    end.type = 'time';
    end.value = minutesToHHMM(rule.endMinutes);
    end.disabled = locked;
    end.addEventListener('change', () => {
      rule.endMinutes = hhmmToMinutes(end.value);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'schedule-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove schedule';
    removeBtn.disabled = locked;
    removeBtn.addEventListener('click', () => {
      scheduleRules = scheduleRules.filter((r) => r !== rule);
      buildScheduleRows();
    });

    row.append(start, sep, end, removeBtn);
    scheduleList.appendChild(row);
  }
}

function lockBannerText(status: LockStatus): string {
  const reasons = status.reasons.map((r) => REASON_NAMES[r]).join(', ');
  const tail = status.until
    ? ` — unlocks in ${formatRemaining(status.until - Date.now())} (${new Date(status.until).toLocaleString()})`
    : ' — unlock with your password';
  return `\u{1F512} Locked: ${reasons}${tail}`;
}

/** Controls that only ever LOOSEN settings — frozen while any lock is active.
 *  The lock/timer/password controls themselves stay enabled: extending or
 *  arming is tightening, and unlock goes through the password check. */
function lockableControls(): { disabled: boolean }[] {
  return [
    enabledToggle,
    thresholdInput,
    whitelistInput,
    blocklistInput,
    saveBtn,
    feedbackClearBtn,
    shareToggle,
    blockTopBtn,
    customCategoryInput,
    addCategoryBtn,
    scheduleAddBtn,
    scheduleSaveBtn,
  ];
}

async function applyLockUI(): Promise<void> {
  const status = await getLockStatus();
  locked = status.settingsLocked;
  passwordArmed = !!(await getLockState()).passwordHash;

  lockStatusEl.style.display = locked ? 'block' : 'none';
  if (locked) lockStatusEl.textContent = lockBannerText(status);
  lockPasswordBtn.textContent = passwordArmed ? 'Unlock' : 'Arm password lock';

  if (lastRenderedLocked !== locked) {
    lastRenderedLocked = locked;
    for (const el of lockableControls()) el.disabled = locked;
    buildLabelRows();
    buildScheduleRows();
  }
}

// Countdown + cross-context refresh: cheap (state is cached; derivation is
// pure math), so a steady 1s tick keeps the banner honest even when another
// page (popup Frozen Turkey) or the boundary alarm changes the lock.
setInterval(() => void applyLockUI(), 1000);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['lockState']) void applyLockUI();
});

let timerConfirmPending = false;
lockTimerBtn.addEventListener('click', async () => {
  const n = parseInt(lockDurationInput.value, 10);
  if (!Number.isFinite(n) || n < 1) return;
  const unit = lockUnitSelect.value === 'd' ? 'day' : 'hour';
  if (!timerConfirmPending) {
    timerConfirmPending = true;
    lockTimerBtn.textContent = `Lock for ${n} ${unit}${n === 1 ? '' : 's'} — click to confirm`;
    setTimeout(() => {
      timerConfirmPending = false;
      lockTimerBtn.textContent = 'Lock settings';
    }, 5000);
    return;
  }
  timerConfirmPending = false;
  lockTimerBtn.textContent = 'Lock settings';
  await startTimerLock(n * (lockUnitSelect.value === 'd' ? 86_400_000 : 3_600_000));
  await applyLockUI();
});

lockPasswordBtn.addEventListener('click', async () => {
  lockPasswordMsg.textContent = '';
  try {
    if (passwordArmed) {
      if (!(await attemptPasswordUnlock(lockPasswordInput.value))) {
        lockPasswordMsg.textContent = 'Wrong password.';
        return;
      }
    } else {
      await armPasswordLock(lockPasswordInput.value);
    }
    lockPasswordInput.value = '';
  } catch (e) {
    lockPasswordMsg.textContent = e instanceof Error ? e.message : String(e);
  }
  await applyLockUI();
});

scheduleAddBtn.addEventListener('click', () => {
  scheduleRules.push({
    id: crypto.randomUUID(),
    days: [1, 2, 3, 4, 5],
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
  });
  buildScheduleRows();
});

scheduleSaveBtn.addEventListener('click', async () => {
  scheduleMsg.textContent = '';
  try {
    await setSchedules(scheduleRules);
    scheduleMsg.style.color = '#16a34a';
    scheduleMsg.textContent = 'Schedules saved.';
  } catch (e) {
    scheduleMsg.style.color = '#991b1b';
    scheduleMsg.textContent = e instanceof Error ? e.message : String(e);
  }
  setTimeout(() => {
    scheduleMsg.textContent = '';
  }, 4000);
  await applyLockUI();
});

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
  if (!isOnboarded) patch.onboarded = true;

  // setSettings THROWS while a lock is active. The button is disabled then
  // anyway (applyLockUI), but surface the reason if a lock lands mid-edit.
  try {
    await setSettings(patch);
  } catch (e) {
    saveMsg.textContent = e instanceof Error ? e.message : String(e);
    saveMsg.style.color = '#991b1b';
    saveMsg.classList.add('visible');
    setTimeout(() => saveMsg.classList.remove('visible'), 4000);
    return;
  }
  if (!isOnboarded) {
    isOnboarded = true;
    banner.style.display = 'none';
    saveBtn.textContent = 'Save';
  }

  // Flash the "Saved!" message
  saveMsg.textContent = 'Saved!';
  saveMsg.style.color = '';
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
