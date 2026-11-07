import React, { useEffect, useRef, useState } from 'react';
import { LockSimple, Plus, X, Warning, Check, Minus } from '@phosphor-icons/react';
import { api } from '../shared/api';
import { clearFeedback, getFeedback } from '../shared/feedback';
import { FEEDBACK_ENDPOINT, LABELS } from '../shared/config';
import type {
  CompanionStatusResponse,
  DeleteSharedFeedbackResponse,
  HistoryScanState,
  SharedFeedbackInfoResponse,
} from '../shared/messages';
import type { CompanionSnapshot } from '../shared/companion-protocol';
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
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Switch } from '../components/ui/switch';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../components/ui/settings';

const BUILTIN_LABELS = new Set<string>(LABELS);

const PRODUCTIVE_LABELS = new Set<string>([
  'programming and software development',
  'science and education',
  'finance and investing',
  'news and politics',
]);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REASON_NAMES: Record<LockStatus['reasons'][number], string> = {
  timer: 'timer lock',
  password: 'password lock',
  frozen: 'Frozen Turkey',
  schedule: 'scheduled block',
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function parseWhitelist(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const host = line
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '');
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

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

/** Sentence-case a stored lowercase label ("memes and entertainment" → "Memes and entertainment"). */
function displayLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const SECTIONS = [
  { id: 'blocking', label: 'Blocking' },
  { id: 'categories', label: 'Categories' },
  { id: 'focus', label: 'Focus' },
  { id: 'sites', label: 'Sites' },
  { id: 'commitment', label: 'Commitment' },
  { id: 'schedules', label: 'Focus hours' },
  { id: 'companion', label: 'Desktop companion' },
  { id: 'history', label: 'History review' },
  { id: 'privacy', label: 'Learning & privacy' },
] as const;

function lockShortText(status: LockStatus): string {
  return status.until ? `Locked · ${formatRemaining(status.until - Date.now())}` : 'Locked';
}

function lockBannerText(status: LockStatus): string {
  const reasons = status.reasons.map((r) => REASON_NAMES[r]).join(', ');
  const tail = status.until
    ? ` — unlocks in ${formatRemaining(status.until - Date.now())} (${new Date(status.until).toLocaleString()})`
    : ' — unlock with your password';
  return `Locked: ${reasons}${tail}`;
}

export function OptionsApp() {
  // Core Settings State
  const [isOnboarded, setIsOnboarded] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [currentLabels, setCurrentLabels] = useState<string[]>([]);
  const [checkedBlocked, setCheckedBlocked] = useState<Set<string>>(new Set());
  const [deletedBuiltins, setDeletedBuiltins] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState(0.5);
  const [whitelistText, setWhitelistText] = useState('');
  const [blocklistText, setBlocklistText] = useState('');
  const [shareFeedback, setShareFeedback] = useState(false);
  const [focusGoal, setFocusGoal] = useState('');
  const [useTabContext, setUseTabContext] = useState(true);
  const [resolveEmbedTitles, setResolveEmbedTitles] = useState(false);

  // Self-service feedback erasure (#32 P3): installId reveal + delete flow.
  const [installId, setInstallId] = useState<string | null>(null);
  const [idRevealed, setIdRevealed] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [deleteResult, setDeleteResult] = useState<{ deleted: number } | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // Category Input
  const [customCategory, setCustomCategory] = useState('');
  const [categoryPlaceholder, setCategoryPlaceholder] = useState('e.g. cooking and recipes');

  // Lock State
  const [locked, setLocked] = useState(false);
  const [lockStatusText, setLockStatusText] = useState('');
  const [lockShort, setLockShort] = useState('');
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const [passwordArmed, setPasswordArmed] = useState(false);
  const [lockDuration, setLockDuration] = useState('1');
  const [lockUnit, setLockUnit] = useState<'h' | 'd'>('h');
  const [timerConfirmPending, setTimerConfirmPending] = useState(false);
  const [timerBtnText, setTimerBtnText] = useState('Lock settings');
  const [lockPassword, setLockPassword] = useState('');
  const [lockPasswordMsg, setLockPasswordMsg] = useState('');

  // Schedules
  const [scheduleRules, setScheduleRules] = useState<ScheduleRule[]>([]);
  const [scheduleMsg, setScheduleMsg] = useState('');
  const [scheduleMsgError, setScheduleMsgError] = useState(false);

  // Companion
  const [companionState, setCompanionState] = useState<CompanionSnapshot['state']>('connecting');
  const [companionText, setCompanionText] = useState('Checking…');
  const [companionFlags, setCompanionFlags] = useState<{ label: string; ok: boolean }[]>([]);
  // "Allow in Incognito" state — true until loaded so we never flash a false
  // incognito-bypass warning.
  const [incognitoAllowed, setIncognitoAllowed] = useState(true);

  // History Scan
  const [scanStatusText, setScanStatusText] = useState('');
  const [scanOutText, setScanOutText] = useState('');
  const [scanOutVisible, setScanOutVisible] = useState(false);
  const [showBlockTopBtn, setShowBlockTopBtn] = useState(false);
  const [lastScanCounts, setLastScanCounts] = useState<Record<string, number>>({});

  // Feedback
  const [feedbackCount, setFeedbackCount] = useState(0);

  // Save & Model Progress
  const [saveMsgText, setSaveMsgText] = useState('Saved!');
  const [saveMsgVisible, setSaveMsgVisible] = useState(false);
  const [saveMsgError, setSaveMsgError] = useState(false);
  const [modelProgressText, setModelProgressText] = useState('');
  const [modelProgressVisible, setModelProgressVisible] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refreshFeedbackCount = async () => {
    const list = await getFeedback();
    setFeedbackCount(list.length);
  };

  const applyLockUI = async () => {
    const status = await getLockStatus();
    const state = await getLockState();
    setLocked(status.settingsLocked);
    setPasswordArmed(Boolean(state.passwordHash));
    if (status.settingsLocked) {
      setLockStatusText(lockBannerText(status));
      setLockShort(lockShortText(status));
    } else {
      setLockStatusText('');
      setLockShort('');
    }
  };

  const renderCompanion = (snapshot: CompanionSnapshot) => {
    const { state, status } = snapshot;
    setCompanionState(state);

    if (state === 'not-installed') {
      setCompanionText('Get SmartBlocker Companion — coming with the Pro release');
      setCompanionFlags([]);
      return;
    }
    if (state === 'connecting') {
      setCompanionText('Connecting…');
      setCompanionFlags([]);
      return;
    }
    if (state === 'disconnected') {
      setCompanionText(
        status
          ? `Installed but not running (companion v${status.companionVersion})`
          : 'Disconnected — reconnecting…',
      );
      setCompanionFlags([]);
      return;
    }
    setCompanionText(
      'Connected — hardcore mode active' +
        (status ? ` (companion v${status.companionVersion})` : ''),
    );
    if (status) {
      setCompanionFlags([
        { label: `${status.enforcement.appBlocking ? 'Active' : 'Inactive'}: App blocking`, ok: status.enforcement.appBlocking },
        { label: `${status.enforcement.watchdog ? 'Active' : 'Inactive'}: Browser watchdog`, ok: status.enforcement.watchdog },
        {
          label: status.enforcement.policyProtected
            ? 'Active: Policy protection'
            : 'Inactive: Policy protection (unavailable until store release)',
          ok: status.enforcement.policyProtected,
        },
      ]);
    } else {
      setCompanionFlags([]);
    }
  };

  const refreshCompanion = async () => {
    try {
      const resp = (await api.runtime.sendMessage({
        type: 'GET_COMPANION_STATUS',
      })) as CompanionStatusResponse;
      if (resp?.ok) {
        setIncognitoAllowed(resp.incognitoAllowed ?? true);
        if (resp.snapshot) renderCompanion(resp.snapshot);
      }
    } catch {
      // Background unreachable during SW restart
    }
  };

  const refreshInstallId = async () => {
    try {
      const resp = (await api.runtime.sendMessage({
        type: 'GET_SHARED_FEEDBACK_INFO',
      })) as SharedFeedbackInfoResponse;
      setInstallId(resp?.ok ? (resp.installId ?? null) : null);
    } catch {
      // Background unreachable during SW restart
    }
  };

  const copyInstallId = async () => {
    if (!installId) return;
    try {
      await navigator.clipboard.writeText(installId);
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions policy) — the revealed
      // text stays selectable for manual copy.
    }
  };

  const runDeleteShared = async () => {
    if (deleteStage === 'idle') {
      setDeleteResult(null);
      setDeleteError('');
      setDeleteStage('confirm');
      return;
    }
    setDeleteStage('busy');
    try {
      const resp = (await api.runtime.sendMessage({
        type: 'DELETE_SHARED_FEEDBACK',
      })) as DeleteSharedFeedbackResponse;
      if (resp?.ok) {
        setDeleteResult({ deleted: resp.deleted ?? 0 });
        setDeleteError('');
      } else {
        setDeleteResult(null);
        setDeleteError(resp?.error ?? 'delete failed');
      }
    } catch (e) {
      setDeleteResult(null);
      setDeleteError(String(e));
    }
    setDeleteStage('idle');
  };

  useEffect(() => {
    const load = async () => {
      const s = await getSettings();
      setIsOnboarded(s.onboarded);
      setCurrentLabels([...s.labels]);
      setCheckedBlocked(new Set(s.blockedLabels));
      setDeletedBuiltins(new Set(s.deletedBuiltinLabels));
      setEnabled(s.enabled);
      setThreshold(s.blockThreshold);
      setWhitelistText(s.whitelist.join('\n'));
      setBlocklistText(s.blocklist.join('\n'));
      setShareFeedback(s.shareFeedback);
      setFocusGoal(s.focusGoal);
      setUseTabContext(s.useTabContext);
      setResolveEmbedTitles(s.resolveEmbedTitles);

      const ls = await getLockState();
      setScheduleRules(ls.schedules.map((r) => ({ ...r, days: [...r.days] })));
      await applyLockUI();
      await refreshFeedbackCount();
      await refreshInstallId();
    };

    void load();
    void refreshCompanion();

    const lockTick = setInterval(() => void applyLockUI(), 1000);
    const companionTick = setInterval(() => void refreshCompanion(), 5000);

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' && changes['lockState']) {
        void applyLockUI();
      }
      if (area === 'local' && changes['settings']) {
        void getSettings().then((s) => {
          setEnabled(s.enabled);
          setCurrentLabels([...s.labels]);
          setCheckedBlocked(new Set(s.blockedLabels));
          setDeletedBuiltins(new Set(s.deletedBuiltinLabels));
          setThreshold(s.blockThreshold);
          setShareFeedback(s.shareFeedback);
          setUseTabContext(s.useTabContext);
          setResolveEmbedTitles(s.resolveEmbedTitles);
          if (s.onboarded) setIsOnboarded(true);
          if (document.activeElement?.id !== 'focus-goal') {
            setFocusGoal(s.focusGoal);
          }
        });
      }
    };
    api.storage.onChanged.addListener(onStorageChanged);

    const onRuntimeMessage = (message: {
      type?: string;
      status?: string;
      progress?: number;
    }) => {
      if (message?.type === 'MODEL_PROGRESS') {
        setModelProgressVisible(true);
        if (message.status === 'init' || message.status === 'ready') {
          setModelProgressText('Initializing...');
        } else if (message.status === 'progress' && message.progress != null) {
          setModelProgressText(`Downloading components: ${message.progress.toFixed(0)}%`);
        } else if (message.status === 'done') {
          setModelProgressText('Ready');
          setTimeout(() => {
            setModelProgressVisible(false);
          }, 5000);
        }
      }
    };
    api.runtime.onMessage.addListener(onRuntimeMessage);

    return () => {
      clearInterval(lockTick);
      clearInterval(companionTick);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      api.storage.onChanged.removeListener(onStorageChanged);
      api.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, []);

  // Section nav scroll-spy: highlight the section nearest the top.
  useEffect(() => {
    const els = SECTIONS.map((sec) => document.getElementById(sec.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -60% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const autoSaveSettings = (patch: Parameters<typeof setSettings>[0]) => {
    void setSettings(patch)
      .then(() => {
        setSaveMsgText('Saved!');
        setSaveMsgError(false);
        setSaveMsgVisible(true);
        setTimeout(() => setSaveMsgVisible(false), 2000);
      })
      .catch((e) => {
        setSaveMsgText(e instanceof Error ? e.message : String(e));
        setSaveMsgError(true);
        setSaveMsgVisible(true);
        setTimeout(() => setSaveMsgVisible(false), 4000);
      });
  };

  // Category Handlers
  const toggleCategory = (label: string, checked: boolean) => {
    if (locked) return;
    const next = new Set(checkedBlocked);
    if (checked) next.add(label);
    else next.delete(label);
    setCheckedBlocked(next);
    autoSaveSettings({ blockedLabels: [...next] });
  };

  const addCategory = (raw: string) => {
    const label = raw.trim().toLowerCase();
    if (!label) return;
    if (currentLabels.includes(label)) {
      setCustomCategory('');
      setCategoryPlaceholder('Category already exists');
      setTimeout(() => setCategoryPlaceholder('e.g. cooking and recipes'), 2000);
      return;
    }
    const nextLabels = [...currentLabels, label];
    const nextBlocked = new Set(checkedBlocked).add(label);
    const nextDeleted = new Set(deletedBuiltins);
    nextDeleted.delete(label);
    setCurrentLabels(nextLabels);
    setCheckedBlocked(nextBlocked);
    setDeletedBuiltins(nextDeleted);
    setCustomCategory('');
    autoSaveSettings({
      labels: nextLabels,
      blockedLabels: [...nextBlocked],
      deletedBuiltinLabels: [...nextDeleted],
    });
  };

  const removeCategory = (label: string) => {
    if (locked) return;
    const nextLabels = currentLabels.filter((l) => l !== label);
    const nextBlocked = new Set(checkedBlocked);
    nextBlocked.delete(label);
    const nextDeleted = new Set(deletedBuiltins);
    if (BUILTIN_LABELS.has(label)) {
      nextDeleted.add(label);
    }
    setCurrentLabels(nextLabels);
    setCheckedBlocked(nextBlocked);
    setDeletedBuiltins(nextDeleted);
    autoSaveSettings({
      labels: nextLabels,
      blockedLabels: [...nextBlocked],
      deletedBuiltinLabels: [...nextDeleted],
    });
  };

  // Lock Handlers
  const handleTimerLockClick = async () => {
    const n = parseInt(lockDuration, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const unitName = lockUnit === 'd' ? 'day' : 'hour';
    if (!timerConfirmPending) {
      setTimerConfirmPending(true);
      setTimerBtnText(`Lock for ${n} ${unitName}${n === 1 ? '' : 's'} — click to confirm`);
      setTimeout(() => {
        setTimerConfirmPending(false);
        setTimerBtnText('Lock settings');
      }, 5000);
      return;
    }
    setTimerConfirmPending(false);
    setTimerBtnText('Lock settings');
    await startTimerLock(n * (lockUnit === 'd' ? 86_400_000 : 3_600_000));
    await applyLockUI();
  };

  const handlePasswordLockClick = async () => {
    setLockPasswordMsg('');
    try {
      if (passwordArmed) {
        if (!(await attemptPasswordUnlock(lockPassword))) {
          setLockPasswordMsg('Wrong password.');
          return;
        }
      } else {
        await armPasswordLock(lockPassword);
      }
      setLockPassword('');
    } catch (e) {
      setLockPasswordMsg(e instanceof Error ? e.message : String(e));
    }
    await applyLockUI();
  };

  // Schedule Handlers
  const handleAddSchedule = () => {
    if (locked) return;
    setScheduleRules((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        days: [1, 2, 3, 4, 5],
        startMinutes: 9 * 60,
        endMinutes: 17 * 60,
      },
    ]);
  };

  const handleToggleScheduleDay = (ruleId: string, day: number, checked: boolean) => {
    if (locked) return;
    setScheduleRules((prev) =>
      prev.map((r) => {
        if (r.id !== ruleId) return r;
        const days = checked
          ? [...r.days, day].sort((a, b) => a - b)
          : r.days.filter((x) => x !== day);
        return { ...r, days };
      }),
    );
  };

  const handleScheduleTimeChange = (
    ruleId: string,
    field: 'startMinutes' | 'endMinutes',
    hhmm: string,
  ) => {
    if (locked) return;
    const mins = hhmmToMinutes(hhmm);
    setScheduleRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, [field]: mins } : r)),
    );
  };

  const handleRemoveSchedule = (ruleId: string) => {
    if (locked) return;
    setScheduleRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  const handleSaveSchedules = async () => {
    setScheduleMsg('');
    try {
      await setSchedules(scheduleRules);
      setScheduleMsgError(false);
      setScheduleMsg('Schedules saved.');
    } catch (e) {
      setScheduleMsgError(true);
      setScheduleMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => {
      setScheduleMsg('');
    }, 4000);
    await applyLockUI();
  };

  // History Scan Handlers
  const renderScan = (s: HistoryScanState | undefined) => {
    if (!s) {
      setScanOutText('No scan data yet.');
      setScanOutVisible(true);
      return;
    }
    setLastScanCounts(s.categoryCounts);
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

    setScanOutText(
      `Scan ${s.status}: ${s.done}/${s.total} titles in ${(s.elapsedMs / 1000).toFixed(1)}s\n` +
        (s.error ? `Error: ${s.error}\n` : '') +
        zeroHint +
        `\nCategories:\n${counts || '  (none yet)'}`,
    );
    setScanOutVisible(true);

    if (s.status === 'done' && Object.keys(s.categoryCounts).length > 0) {
      setShowBlockTopBtn(true);
    }
  };

  const handleScanHistory = async () => {
    setScanStatusText('Scanning history…');
    setShowBlockTopBtn(false);
    setScanOutVisible(false);
    setLastScanCounts({});
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    await api.runtime.sendMessage({ type: 'SCAN_HISTORY' });

    pollTimerRef.current = setInterval(async () => {
      const { historyScan } = await api.storage.local.get('historyScan');
      const state = historyScan as HistoryScanState | undefined;
      renderScan(state);
      if (state && state.status !== 'running') {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setScanStatusText('');
      }
    }, 1000);
  };

  const handleBlockTopDistractions = () => {
    if (locked) return;
    const topDistractions = Object.entries(lastScanCounts)
      .filter(([label]) => !PRODUCTIVE_LABELS.has(label))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label);

    const next = new Set(checkedBlocked);
    for (const label of topDistractions) next.add(label);
    setCheckedBlocked(next);
    autoSaveSettings({ blockedLabels: [...next] });
  };

  // Feedback Handlers
  const handleExportFeedback = async () => {
    const records = await getFeedback();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smartblocker-feedback-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearFeedback = async () => {
    if (locked) return;
    await clearFeedback();
    await refreshFeedbackCount();
  };

  // Save Settings Handler
  const handleSaveSettings = async () => {
    const whitelist = parseWhitelist(whitelistText);
    setWhitelistText(whitelist.join('\n'));
    const blocklist = parseBlocklist(blocklistText);
    setBlocklistText(blocklist.join('\n'));

    const patch: Parameters<typeof setSettings>[0] = {
      enabled,
      labels: currentLabels,
      blockedLabels: [...checkedBlocked],
      blockThreshold: threshold,
      whitelist,
      blocklist,
      shareFeedback,
      deletedBuiltinLabels: [...deletedBuiltins],
      focusGoal: focusGoal.trim(),
      useTabContext,
      resolveEmbedTitles,
    };
    if (!isOnboarded) patch.onboarded = true;

    try {
      await setSettings(patch);
    } catch (e) {
      setSaveMsgText(e instanceof Error ? e.message : String(e));
      setSaveMsgError(true);
      setSaveMsgVisible(true);
      setTimeout(() => setSaveMsgVisible(false), 4000);
      return;
    }

    if (!isOnboarded) {
      setIsOnboarded(true);
    }

    setSaveMsgText('Saved!');
    setSaveMsgError(false);
    setSaveMsgVisible(true);
    setTimeout(() => setSaveMsgVisible(false), 2000);
  };

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-background text-foreground">
      {/* Header — wordmark · live status · save (docs/design-notes.md §5) */}
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <LockSimple weight="bold" className="size-3.5" />
            </span>
            <span className="text-sm font-semibold tracking-tight">SmartBlocker</span>
            <span className="hidden text-faint sm:inline">/</span>
            <span className="hidden text-sm text-muted-foreground sm:inline">Settings</span>
          </div>

          <div className="flex items-center gap-4">
            {locked ? (
              <Badge variant="commit" dot>
                {lockShort}
              </Badge>
            ) : enabled ? (
              <Badge variant="success" dot>
                Blocking on
              </Badge>
            ) : (
              <Badge dot>Paused</Badge>
            )}
            <span
              id="save-msg"
              role="status"
              className={`hidden text-xs font-medium transition-opacity duration-150 sm:inline ${
                saveMsgVisible ? 'opacity-100' : 'opacity-0'
              } ${saveMsgError ? 'text-destructive-soft' : 'text-success-soft'}`}
            >
              {saveMsgText}
            </span>
            <Button
              id="save-btn"
              size="sm"
              disabled={locked}
              onClick={() => void handleSaveSettings()}
            >
              {isOnboarded ? 'Save' : 'Finish setup'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl gap-12 px-4 pb-24 pt-8 md:px-8">
        {/* Section nav (md+) */}
        <nav aria-label="Settings sections" className="hidden w-44 shrink-0 md:block">
          <ul className="sticky top-22 m-0 flex list-none flex-col gap-0.5 p-0">
            {SECTIONS.map((sec) => (
              <li key={sec.id}>
                <a
                  href={`#${sec.id}`}
                  aria-current={activeSection === sec.id ? 'true' : undefined}
                  className={`block rounded-md px-2.5 py-1.5 text-[13px] no-underline transition-colors ${
                    activeSection === sec.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {sec.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 max-w-[680px] flex-1 flex-col gap-12">
          {/* First run + lock seal */}
          <div
            id="banner"
            style={{ display: isOnboarded ? 'none' : 'block' }}
            className="rounded-xl border border-border bg-card px-5 py-4"
          >
            <p className="m-0 text-base font-semibold tracking-tight">Welcome to SmartBlocker</p>
            <p className="m-0 mt-1 text-[13px] text-muted-foreground">
              Pick the categories you want blocked below, then choose{' '}
              <span className="font-medium text-foreground">Finish setup</span>. Everything runs on
              this device.
            </p>
          </div>

          <div
            id="lock-status"
            role="status"
            style={{ display: locked ? 'flex' : 'none' }}
            className="items-start gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-[13px] font-medium text-accent-soft"
          >
            <LockSimple weight="fill" className="mt-0.5 size-4 shrink-0 text-accent" />
            <span>{lockStatusText}</span>
          </div>

          {/* ── Blocking ─────────────────────────────────────────── */}
          <SettingsSection
            id="blocking"
            title="Blocking"
            description="SmartBlocker checks every page title on this device and blocks the ones that look like a detour."
          >
            <SettingsGroup>
              <SettingRow
                label="Block distracting pages"
                description="Turn off to pause all blocking. Allowed sites are never checked."
                htmlFor="enabled-toggle"
                control={
                  <Switch
                    id="enabled-toggle"
                    checked={enabled}
                    disabled={locked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setEnabled(next);
                      autoSaveSettings({ enabled: next });
                    }}
                  />
                }
              />
              <SettingRow
                stacked
                label="Sensitivity"
                htmlFor="threshold"
                description="A page is blocked when the model is at least this confident it's a distraction."
                control={
                  <span
                    id="threshold-val"
                    className="font-mono text-sm font-medium tabular-nums text-foreground"
                  >
                    {pct(threshold)}
                  </span>
                }
              >
                <div className="flex flex-col gap-1.5">
                  <input
                    type="range"
                    id="threshold"
                    min="0.3"
                    max="0.9"
                    step="0.05"
                    value={threshold}
                    disabled={locked}
                    style={{ ['--fill' as string]: `${((threshold - 0.3) / 0.6) * 100}%` }}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value);
                      setThreshold(next);
                      autoSaveSettings({ blockThreshold: next });
                    }}
                    className="sb-range"
                  />
                  <div className="flex justify-between text-xs text-faint">
                    <span>Stricter · blocks more</span>
                    <span>Relaxed · blocks less</span>
                  </div>
                </div>
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Categories ───────────────────────────────────────── */}
          <SettingsSection
            id="categories"
            title="Categories"
            description="What counts as a distraction for you. Unchecked categories are recognized but never blocked."
            aside={
              <span className="text-xs tabular-nums text-faint">
                {checkedBlocked.size} of {currentLabels.length} blocked
              </span>
            }
          >
            <SettingsGroup className="overflow-hidden">
              <ul
                id="label-list"
                className="m-0 grid list-none grid-cols-1 gap-px bg-border p-0 sm:grid-cols-2"
              >
                {currentLabels.map((label) => {
                  const isChecked = checkedBlocked.has(label);
                  return (
                    <li
                      key={label}
                      className="group/row flex items-center gap-3 bg-card px-4 py-2.5 transition-colors hover:bg-muted sm:last:odd:col-span-2"
                    >
                      <Checkbox
                        id={`lbl-${label}`}
                        checked={isChecked}
                        disabled={locked}
                        onChange={(e) => toggleCategory(label, e.target.checked)}
                      />
                      <label
                        htmlFor={`lbl-${label}`}
                        className={`label-name min-w-0 flex-1 truncate text-sm select-none ${
                          locked ? 'cursor-default' : 'cursor-pointer'
                        } ${isChecked ? 'text-foreground' : 'text-muted-foreground'}`}
                      >
                        {displayLabel(label)}
                      </label>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => removeCategory(label)}
                        title={`Remove ${label}`}
                        aria-label={`Remove ${label}`}
                        className="delete-label-btn flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint opacity-0 transition-[opacity,color] group-hover/row:opacity-100 hover:text-destructive-soft focus-visible:opacity-100 disabled:hidden"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-col gap-2 px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    id="custom-category-input"
                    value={customCategory}
                    disabled={locked}
                    placeholder={categoryPlaceholder}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCategory(customCategory);
                      }
                    }}
                  />
                  <Button
                    id="add-category-btn"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => addCategory(customCategory)}
                  >
                    <Plus weight="bold" className="size-3.5" />
                    Add category
                  </Button>
                </div>
                <p className="m-0 text-xs text-faint">
                  Describe it in a few words — "cooking and recipes" works better than "cooking".
                </p>
              </div>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Focus ────────────────────────────────────────────── */}
          <SettingsSection
            id="focus"
            title="Focus"
            description="Tell SmartBlocker what you're working on so related pages on mixed sites stay open."
          >
            <SettingsGroup>
              <SettingRow
                stacked
                label="Current focus goal"
                htmlFor="focus-goal"
                description="Saved when you press Enter or leave the field."
                control={focusGoal.trim() ? <Badge variant="commit" dot>Focusing</Badge> : undefined}
              >
                <Input
                  type="text"
                  id="focus-goal"
                  value={focusGoal}
                  disabled={locked}
                  onChange={(e) => setFocusGoal(e.target.value)}
                  onBlur={() => autoSaveSettings({ focusGoal: focusGoal.trim() })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      autoSaveSettings({ focusGoal: focusGoal.trim() });
                    }
                  }}
                  placeholder="e.g. Writing my biology lab report"
                />
              </SettingRow>
              <SettingRow
                label="Use my open tabs as context"
                description="Pages similar to the work tabs you have open are less likely to be blocked."
                htmlFor="use-tab-context"
                control={
                  <Switch
                    id="use-tab-context"
                    checked={useTabContext}
                    disabled={locked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setUseTabContext(next);
                      autoSaveSettings({ useTabContext: next });
                    }}
                  />
                }
              />
            </SettingsGroup>
          </SettingsSection>

          {/* ── Sites ────────────────────────────────────────────── */}
          <SettingsSection
            id="sites"
            title="Sites"
            description="Rules that skip the model entirely. Use Save in the header after editing these lists."
          >
            <SettingsGroup>
              <SettingRow
                stacked
                label="Always allow"
                htmlFor="whitelist"
                description={
                  <>
                    One domain per line. Subdomains are included —{' '}
                    <code className="text-xs text-foreground">github.com</code> also allows{' '}
                    <code className="text-xs text-foreground">gist.github.com</code>.
                  </>
                }
              >
                <Textarea
                  id="whitelist"
                  spellCheck={false}
                  disabled={locked}
                  value={whitelistText}
                  onChange={(e) => setWhitelistText(e.target.value)}
                  placeholder={'github.com\nmail.google.com\nlocalhost'}
                  className="min-h-[148px]"
                />
              </SettingRow>
              <SettingRow
                stacked
                label="Always block"
                htmlFor="blocklist"
                description="Keywords or URL fragments, one per line. Any address or page title containing one is blocked instantly."
              >
                <Textarea
                  id="blocklist"
                  spellCheck={false}
                  disabled={locked}
                  value={blocklistText}
                  onChange={(e) => setBlocklistText(e.target.value)}
                  placeholder={'amazon.com\n/cart\nblack friday'}
                  className="min-h-[120px]"
                />
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Commitment ───────────────────────────────────────── */}
          <SettingsSection
            id="commitment"
            title="Commitment"
            description="Lock your settings so future-you can't switch blocking off. Locks can be extended, never shortened, and survive restarts."
            aside={
              locked ? (
                <Badge variant="commit" dot>
                  Locked
                </Badge>
              ) : (
                <Badge>Unlocked</Badge>
              )
            }
          >
            <SettingsGroup>
              <SettingRow
                label="Lock for a set time"
                description="No override buttons on block screens until it ends."
                control={
                  <>
                    <Input
                      type="number"
                      id="lock-duration"
                      min="1"
                      aria-label="Lock duration"
                      value={lockDuration}
                      onChange={(e) => setLockDuration(e.target.value)}
                      className="w-16 font-mono tabular-nums"
                    />
                    <Select
                      id="lock-unit"
                      aria-label="Lock duration unit"
                      value={lockUnit}
                      onChange={(e) => setLockUnit(e.target.value as 'h' | 'd')}
                      className="w-24"
                    >
                      <option value="h">hours</option>
                      <option value="d">days</option>
                    </Select>
                    <Button
                      id="lock-timer-btn"
                      variant={timerConfirmPending ? 'commit' : 'secondary'}
                      onClick={() => void handleTimerLockClick()}
                    >
                      {timerBtnText}
                    </Button>
                  </>
                }
              />
              <SettingRow
                stacked
                label="Password lock"
                htmlFor="lock-password"
                description="Give the password to someone you trust. Settings stay locked until it's entered here."
                control={passwordArmed ? <Badge variant="commit" dot>Armed</Badge> : undefined}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    id="lock-password"
                    value={lockPassword}
                    onChange={(e) => setLockPassword(e.target.value)}
                    placeholder={passwordArmed ? 'Enter password to unlock' : 'At least 8 characters'}
                    autoComplete={passwordArmed ? 'current-password' : 'new-password'}
                  />
                  <Button
                    id="lock-password-btn"
                    variant="secondary"
                    onClick={() => void handlePasswordLockClick()}
                  >
                    {passwordArmed ? 'Unlock' : 'Arm password lock'}
                  </Button>
                </div>
                <span
                  id="lock-password-msg"
                  role="alert"
                  className="block min-h-[18px] text-xs font-medium text-destructive-soft empty:min-h-0"
                >
                  {lockPasswordMsg}
                </span>
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Focus hours (schedules) ──────────────────────────── */}
          <SettingsSection
            id="schedules"
            title="Focus hours"
            description="Recurring windows where blocking is forced on and settings are locked. An end time before the start runs overnight."
          >
            <SettingsGroup>
              <div id="schedule-list" className="flex flex-col divide-y divide-border">
                {scheduleRules.length === 0 && (
                  <p className="m-0 px-4 py-3.5 text-[13px] text-faint">No focus hours yet.</p>
                )}
                {scheduleRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="schedule-row flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Days">
                      {DAY_NAMES.map((dayName, d) => (
                        <label
                          key={d}
                          className={`day-label inline-flex h-7 min-w-9 items-center justify-center rounded-md border px-1.5 text-xs font-medium select-none transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70 ${
                            rule.days.includes(d)
                              ? 'border-accent/40 bg-accent/10 text-accent-soft'
                              : 'border-border text-faint hover:text-muted-foreground'
                          } ${locked ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={rule.days.includes(d)}
                            disabled={locked}
                            onChange={(e) => handleToggleScheduleDay(rule.id, d, e.target.checked)}
                          />
                          {dayName}
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        aria-label="Start time"
                        value={minutesToHHMM(rule.startMinutes)}
                        disabled={locked}
                        onChange={(e) => handleScheduleTimeChange(rule.id, 'startMinutes', e.target.value)}
                        className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs tabular-nums text-foreground disabled:opacity-45"
                      />
                      <Minus className="size-3 text-faint" aria-hidden />
                      <input
                        type="time"
                        aria-label="End time"
                        value={minutesToHHMM(rule.endMinutes)}
                        disabled={locked}
                        onChange={(e) => handleScheduleTimeChange(rule.id, 'endMinutes', e.target.value)}
                        className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs tabular-nums text-foreground disabled:opacity-45"
                      />
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => handleRemoveSchedule(rule.id)}
                        title="Remove focus hours"
                        aria-label="Remove focus hours"
                        className="schedule-remove flex size-7 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-muted hover:text-destructive-soft disabled:opacity-40"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Button
                  id="schedule-add"
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={handleAddSchedule}
                >
                  <Plus weight="bold" className="size-3.5" />
                  Add focus hours
                </Button>
                <span
                  id="schedule-msg"
                  role="status"
                  className={`ml-auto text-xs font-medium ${
                    scheduleMsgError ? 'text-destructive-soft' : 'text-success-soft'
                  }`}
                >
                  {scheduleMsg}
                </span>
                <Button
                  id="schedule-save"
                  variant="secondary"
                  size="sm"
                  disabled={locked}
                  onClick={() => void handleSaveSchedules()}
                >
                  Save focus hours
                </Button>
              </div>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Desktop companion ────────────────────────────────── */}
          <SettingsSection
            id="companion"
            title="Desktop companion"
            description="An optional desktop app that enforces locks outside the browser: closes distracting apps and browsers launched without SmartBlocker."
          >
            <SettingsGroup>
              <div className="flex flex-col gap-3 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${
                      companionState === 'connected' ? 'bg-success' : 'bg-faint'
                    }`}
                  />
                  <div
                    id="companion-status"
                    className={`text-sm ${
                      companionState === 'connected'
                        ? 'companion-connected font-medium text-foreground'
                        : 'companion-muted text-muted-foreground'
                    }`}
                  >
                    {companionText}
                  </div>
                </div>
                <ul
                  id="companion-enforcement"
                  style={{ display: companionFlags.length > 0 ? 'flex' : 'none' }}
                  className="m-0 flex-col gap-1.5 p-0 pl-[18px] list-none text-[13px] text-muted-foreground"
                >
                  {companionFlags.map((f, i) => (
                    <li key={i} className="flex items-center gap-2">
                      {f.ok ? (
                        <Check weight="bold" className="size-3.5 text-success" />
                      ) : (
                        <Minus weight="bold" className="size-3.5 text-faint" />
                      )}
                      <span>{f.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {incognitoAllowed === false && (
                <div className="px-4 py-3.5">
                  <Callout id="incognito-warning" tone="warning">
                    <div className="mb-1 flex items-center gap-1.5 font-medium">
                      <Warning weight="fill" className="size-4 shrink-0 text-warning" />
                      Private windows aren't protected
                    </div>
                    <p className="m-0 text-warning-soft/80">
                      SmartBlocker can't see incognito tabs, so they bypass active locks. Open{' '}
                      <code className="font-mono text-xs text-warning-soft">chrome://extensions</code>,
                      find SmartBlocker, and turn on{' '}
                      <span className="font-medium text-warning-soft">Allow in Incognito</span>.
                    </p>
                  </Callout>
                </div>
              )}
            </SettingsGroup>
          </SettingsSection>

          {/* ── History review ───────────────────────────────────── */}
          <SettingsSection
            id="history"
            title="History review"
            description="Classify your recent browsing history on-device to see where your time actually goes."
          >
            <SettingsGroup>
              <SettingRow
                stacked
                label="Review recent history"
                description="Nothing leaves this device. Takes a few seconds."
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      id="block-top-btn"
                      variant="commit"
                      size="sm"
                      disabled={locked}
                      style={{ display: showBlockTopBtn ? 'inline-flex' : 'none' }}
                      onClick={handleBlockTopDistractions}
                    >
                      Block top 3
                    </Button>
                    <Button
                      id="scan-btn"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleScanHistory()}
                    >
                      Review history
                    </Button>
                  </div>
                }
              >
                <div
                  id="scan-status"
                  role="status"
                  className="text-xs text-muted-foreground empty:hidden"
                >
                  {scanStatusText}
                </div>
                <pre
                  id="scan-out"
                  style={{ display: scanOutVisible ? 'block' : 'none' }}
                  className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed tabular-nums text-muted-foreground"
                >
                  {scanOutText}
                </pre>
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>

          {/* ── Learning & privacy ───────────────────────────────── */}
          <SettingsSection
            id="privacy"
            title="Learning & privacy"
            description="When you correct a block, SmartBlocker learns from it on this device. Nothing is shared unless you turn sharing on."
          >
            <SettingsGroup>
              <SettingRow
                label={
                  <>
                    <span id="feedback-count" className="font-mono tabular-nums">
                      {feedbackCount}
                    </span>{' '}
                    {feedbackCount === 1 ? 'correction' : 'corrections'} learned
                  </>
                }
                description="Stored only in this browser profile."
                control={
                  <>
                    <Button
                      id="feedback-export"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleExportFeedback()}
                    >
                      Export JSON
                    </Button>
                    <Button
                      id="feedback-clear"
                      variant="secondary"
                      size="sm"
                      disabled={locked}
                      onClick={() => void handleClearFeedback()}
                    >
                      Clear all
                    </Button>
                  </>
                }
              />
              <SettingRow
                label="Share corrections to improve blocking"
                htmlFor="share-toggle"
                description="Off by default. Sends only the page title, site name and category — never full URLs or your history. See PRIVACY.md."
                control={
                  <Switch
                    id="share-toggle"
                    checked={shareFeedback}
                    disabled={locked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setShareFeedback(next);
                      autoSaveSettings({ shareFeedback: next });
                    }}
                  />
                }
              />
              <SettingRow
                label="Identify embedded YouTube videos"
                htmlFor="oembed-toggle"
                description="Off by default. Looks up titles of embedded players so they can be checked. Never used for privacy-enhanced embeds."
                control={
                  <Switch
                    id="oembed-toggle"
                    checked={resolveEmbedTitles}
                    disabled={locked}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setResolveEmbedTitles(next);
                      autoSaveSettings({ resolveEmbedTitles: next });
                    }}
                  />
                }
              />

              {/* Self-service erasure (#32 P3): installId reveal + delete.
                   The id only exists after the FIRST shared correction —
                   never minted just for viewing. */}
              <SettingRow
                stacked
                label="Your shared feedback data"
                description="Deletes every record shared from this installation. Limited to once per hour; shared records also expire after 90 days."
                control={
                  <Button
                    variant={deleteStage === 'confirm' ? 'destructive' : 'secondary'}
                    size="sm"
                    disabled={
                      deleteStage === 'busy' || (!FEEDBACK_ENDPOINT && deleteStage !== 'confirm')
                    }
                    onClick={() => void runDeleteShared()}
                  >
                    {deleteStage === 'busy'
                      ? 'Deleting…'
                      : deleteStage === 'confirm'
                        ? 'Click again to confirm delete'
                        : 'Delete shared data'}
                  </Button>
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-xs">
                  <span className="text-faint">Install ID — random, not tied to you</span>
                  {installId ? (
                    <span className="flex items-center gap-1">
                      <code className="mr-1 font-mono text-xs text-muted-foreground">
                        {idRevealed ? installId : `${installId.slice(0, 8)}…••••`}
                      </code>
                      <Button variant="ghost" size="xs" onClick={() => setIdRevealed((v) => !v)}>
                        {idRevealed ? 'Hide' : 'Reveal'}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => void copyInstallId()}>
                        {idCopied ? 'Copied' : 'Copy'}
                      </Button>
                    </span>
                  ) : (
                    <span className="text-faint">
                      none yet — created the first time you share a correction
                    </span>
                  )}
                </div>
                {!FEEDBACK_ENDPOINT && (
                  <p className="m-0 text-xs text-faint">
                    Feedback sharing is not configured in this build — nothing was ever uploaded, so
                    there is nothing to delete.
                  </p>
                )}
                {deleteResult && (
                  <p className="m-0 text-xs text-success-soft">
                    Done — {deleteResult.deleted} record(s) deleted
                    {deleteResult.deleted === 0 ? ' (nothing had been shared)' : ''}.
                  </p>
                )}
                {deleteError && (
                  <p className="m-0 text-xs text-destructive-soft">Could not delete: {deleteError}</p>
                )}
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>

          <footer className="flex flex-col gap-2 border-t border-border pt-6 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
            <span>SmartBlocker v0.5.0 · runs entirely on this device</span>
            <span
              id="model-progress"
              role="status"
              style={{ display: modelProgressVisible ? 'inline-block' : 'none' }}
              className="font-mono tabular-nums text-muted-foreground"
            >
              {modelProgressText}
            </span>
          </footer>
        </div>
      </div>
    </main>
  );
}
