import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import {
  ShieldCheck,
  LockKey,
  Crosshair,
  Sliders,
  Plus,
  Clock,
  Desktop,
  ClockCounterClockwise,
  Brain,
  CheckCircle,
  XCircle,
  ArrowUpRight,
  Cpu,
  Lightning,
  Fingerprint,
  EyeSlash,
  Sparkle,
  Warning,
} from '@phosphor-icons/react';
import { api } from '../shared/api';
import { clearFeedback, getFeedback } from '../shared/feedback';
import { LABELS } from '../shared/config';
import type { CompanionStatusResponse, HistoryScanState } from '../shared/messages';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Switch } from '../components/ui/switch';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
// Self-hosted showcase imagery (red-team P1 #17 — previously hotlinked to
// picsum.photos on every options-page open). Bundled by Vite; render is
// identical offline and the extension emits zero image requests.
import heroPillImg from '../assets/showcase/hero-pill.svg';
import monolithImg from '../assets/showcase/monolith.svg';
import vaultImg from '../assets/showcase/vault.svg';
import prismOneImg from '../assets/showcase/prism-one.svg';
import prismTwoImg from '../assets/showcase/prism-two.svg';
import prismThreeImg from '../assets/showcase/prism-three.svg';
import ladderGateImg from '../assets/showcase/ladder-gate.svg';
import ladderCorridorImg from '../assets/showcase/ladder-corridor.svg';
import ladderLatticeImg from '../assets/showcase/ladder-lattice.svg';

gsap.registerPlugin(ScrollTrigger, useGSAP);

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

function lockBannerText(status: LockStatus): string {
  const reasons = status.reasons.map((r) => REASON_NAMES[r]).join(', ');
  const tail = status.until
    ? ` — unlocks in ${formatRemaining(status.until - Date.now())} (${new Date(status.until).toLocaleString()})`
    : ' — unlock with your password';
  return `Locked: ${reasons}${tail}`;
}

const MANIFESTO_TEXT =
  'Legacy blockers amputate whole domains because they cannot read. SmartBlocker embeds every title locally in twelve milliseconds, separating deep engineering research from algorithmic rabbit holes without a single packet ever leaving your machine.';

const ACCORDION_PANELS = [
  {
    title: 'Domain Whitelist & Pre-Curtain Gate',
    subtitle: 'Zero-latency exemption and 180ms media suppression',
    description:
      'Whitelisted domains and subdomains bypass inference immediately. On mixed high-risk hosts like YouTube, Reddit, and Twitch, an immediate pre-classification curtain pauses active media before a single frame distracts you.',
    image: ladderGateImg,
  },
  {
    title: 'Deterministic Substring Blocklist',
    subtitle: 'Instant URL and query interception',
    description:
      'Unambiguous patterns in the full URL or page title trigger the block screen in zero milliseconds without waking the neural pipeline—catching shopping carts, impulse queries, and distracting storefronts.',
    image: ladderCorridorImg,
  },
  {
    title: 'BGE-Small Multi-Prototype Centroids',
    subtitle: '384-dimensional local vector geometry',
    description:
      'Each page is embedded once via ONNX WASM and scored against multi-cluster category prototypes, neutral productive anchors, and your active Focus Context vector—updating centroids on-device whenever you record a correction.',
    image: ladderLatticeImg,
  },
] as const;

const PINNED_CHAPTERS = [
  {
    title: 'Sub-15ms Offscreen WASM Inference',
    detail:
      'Hosted inside a persistent offscreen document so service-worker sleep cycles never force a cold model reload.',
    image: prismOneImg,
  },
  {
    title: 'Monotonic Commitment Convergence',
    detail:
      'Timer locks, password hashes, Frozen Turkey sessions, and recurring schedules merge monotonically across browser and native daemon.',
    image: prismTwoImg,
  },
  {
    title: 'On-Device Centroid Personalization',
    detail:
      'False positives and false negatives fold directly into local prototype centroids—adapting to your exact discipline without cloud training.',
    image: prismThreeImg,
  },
] as const;

export function OptionsApp() {
  const mainRef = useRef<HTMLElement>(null);
  const scrubRef = useRef<HTMLParagraphElement>(null);
  const pinSectionRef = useRef<HTMLDivElement>(null);
  const pinLeftRef = useRef<HTMLDivElement>(null);

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

  // Category Input
  const [customCategory, setCustomCategory] = useState('');
  const [categoryPlaceholder, setCategoryPlaceholder] = useState('e.g. cooking and recipes');

  // Lock State
  const [locked, setLocked] = useState(false);
  const [lockStatusText, setLockStatusText] = useState('');
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
    } else {
      setLockStatusText('');
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
          setModelProgressText(`Model ${message.status}...`);
        } else if (message.status === 'progress' && message.progress != null) {
          setModelProgressText(`Downloading AI model: ${message.progress.toFixed(0)}%`);
        } else if (message.status === 'done') {
          setModelProgressText('AI model ready');
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

  // GSAP ScrollTrigger Animations
  useGSAP(
    () => {
      // Hero entrance
      gsap.from('.hero-reveal', {
        y: 28,
        opacity: 0,
        duration: 0.9,
        stagger: 0.12,
        ease: 'power3.out',
      });

      // Scrubbing text reveal on manifesto words
      if (scrubRef.current) {
        const words = scrubRef.current.querySelectorAll('.scrub-word');
        if (words.length > 0) {
          gsap.fromTo(
            words,
            { opacity: 0.12 },
            {
              opacity: 1,
              stagger: 0.05,
              ease: 'none',
              scrollTrigger: {
                trigger: scrubRef.current,
                start: 'top 82%',
                end: 'bottom 45%',
                scrub: true,
              },
            },
          );
        }
      }

      // Pinning left column in Desire split showcase
      if (pinSectionRef.current && pinLeftRef.current) {
        ScrollTrigger.create({
          trigger: pinSectionRef.current,
          start: 'top 18%',
          end: 'bottom 75%',
          pin: pinLeftRef.current,
          pinSpacing: false,
        });
      }

      // Image Scale & Fade Scroll on showcase cards
      const scaleCards = gsap.utils.toArray<HTMLElement>('.gsap-scale-card');
      for (const card of scaleCards) {
        gsap.fromTo(
          card,
          { scale: 0.84, opacity: 0.35 },
          {
            scale: 1,
            opacity: 1,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: card,
              start: 'top 88%',
              end: 'top 35%',
              scrub: true,
            },
          },
        );
      }
    },
    { scope: mainRef },
  );

  // Category Handlers
  const toggleCategory = (label: string, checked: boolean) => {
    if (locked) return;
    setCheckedBlocked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(label);
      else next.delete(label);
      return next;
    });
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
    setCurrentLabels((prev) => [...prev, label]);
    setCheckedBlocked((prev) => new Set(prev).add(label));
    setDeletedBuiltins((prev) => {
      const next = new Set(prev);
      next.delete(label);
      return next;
    });
    setCustomCategory('');
  };

  const removeCategory = (label: string) => {
    if (locked) return;
    setCurrentLabels((prev) => prev.filter((l) => l !== label));
    setCheckedBlocked((prev) => {
      const next = new Set(prev);
      next.delete(label);
      return next;
    });
    if (BUILTIN_LABELS.has(label)) {
      setDeletedBuiltins((prev) => new Set(prev).add(label));
    }
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

    setCheckedBlocked((prev) => {
      const next = new Set(prev);
      for (const label of topDistractions) next.add(label);
      return next;
    });
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

  const scrollToId = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <main
      ref={mainRef}
      className="overflow-x-hidden w-full max-w-full min-h-screen bg-[#070709] text-zinc-50 relative"
    >
      {/* Background atmospheric mesh & architectural grid */}
      <div className="pointer-events-none fixed inset-0 bg-editorial-grid opacity-55" />
      <div className="pointer-events-none fixed -top-48 left-1/4 h-[520px] w-[720px] rounded-full bg-emerald-500/[0.06] blur-[150px]" />
      <div className="pointer-events-none fixed bottom-0 right-1/4 h-[460px] w-[640px] rounded-full bg-zinc-400/[0.05] blur-[140px]" />

      {/* FLOATING GLASS-PILL NAVIGATION BAR */}
      <header className="fixed top-5 inset-x-0 z-50 mx-auto max-w-6xl px-4 md:px-8">
        <nav className="flex items-center justify-between rounded-full border border-zinc-800/90 bg-[#0b0b0f]/80 px-5 py-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.75)] backdrop-blur-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700/80 bg-zinc-900">
              <ShieldCheck weight="duotone" className="h-4.5 w-4.5 text-emerald-400" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-zinc-100">
              SmartBlocker
            </span>
          </div>

          <div className="hidden md:flex items-center gap-7 text-xs font-medium text-zinc-400">
            <button
              type="button"
              onClick={() => scrollToId('control-matrix')}
              className="hover:text-zinc-100 transition-colors cursor-pointer"
            >
              Control Matrix
            </button>
            <button
              type="button"
              onClick={() => scrollToId('commitment-lock')}
              className="hover:text-zinc-100 transition-colors cursor-pointer"
            >
              Commitment Lock
            </button>
            <button
              type="button"
              onClick={() => scrollToId('defense-architecture')}
              className="hover:text-zinc-100 transition-colors cursor-pointer"
            >
              Defense Pipeline
            </button>
            <button
              type="button"
              onClick={() => scrollToId('commit-section')}
              className="hover:text-zinc-100 transition-colors cursor-pointer"
            >
              Commit Changes
            </button>
          </div>

          <div className="flex items-center gap-2.5">
            <Badge variant={locked ? 'crimson' : enabled ? 'emerald' : 'outline'}>
              {locked ? 'Locked Session' : enabled ? 'Protection Active' : 'Standby'}
            </Badge>
            <Button
              variant="default"
              size="sm"
              onClick={() => scrollToId('commit-section')}
              className="h-8 rounded-full px-4 text-xs"
            >
              {isOnboarded ? 'Save Config' : 'Finish Setup'}
            </Button>
          </div>
        </nav>
      </header>

      {/* ONBOARDING & ACTIVE LOCK BANNERS */}
      <div className="relative z-10 mx-auto max-w-7xl px-6 md:px-12 pt-28">
        <div
          id="banner"
          style={{ display: isOnboarded ? 'none' : 'block' }}
          className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-6 py-4 text-sm text-emerald-200 backdrop-blur-md"
        >
          <p className="m-0 font-medium">
            Welcome to SmartBlocker — pick what distracts you, then click "Finish setup" to activate blocking.
          </p>
        </div>

        <div
          id="lock-status"
          style={{ display: locked ? 'block' : 'none' }}
          className="mb-4 rounded-2xl border border-red-500/45 bg-red-500/12 px-6 py-4 text-sm font-semibold text-red-200 backdrop-blur-md"
        >
          {lockStatusText}
        </div>
      </div>

      {/* =====================================================================
          A — ATTENTION: EDITORIAL SPLIT HERO (py-32 md:py-48)
         ===================================================================== */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 md:px-12 py-32 md:py-48">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* Left: Wide Editorial Typography (2 Lines Guaranteed) */}
          <div className="lg:col-span-8 flex flex-col items-start">
            <h1 className="hero-reveal max-w-5xl w-full text-[clamp(2.5rem,4.0vw,4.35rem)] font-semibold leading-[1.08] tracking-[-0.035em] text-zinc-50">
              Silence the impulse,
              <br className="hidden sm:block" />
              <span
                className="inline-block w-24 h-11 md:w-28 md:h-12 rounded-full align-middle bg-cover bg-center mr-3 border border-zinc-700/80 grayscale contrast-125 shadow-inner"
                style={{
                  backgroundImage: `url(${heroPillImg})`,
                }}
              />
              preserve the craft.
            </h1>

            <p className="hero-reveal mt-8 max-w-2xl text-lg md:text-xl leading-relaxed text-zinc-400">
              SmartBlocker runs a local BGE-Small vector engine inside your browser to evaluate page
              semantics in real time—allowing technical research through while intercepting
              algorithmic feeds before they play.
            </p>

            <div className="hero-reveal mt-10 flex flex-wrap items-center gap-4">
              <Button
                variant="default"
                size="lg"
                onClick={() => scrollToId('control-matrix')}
                className="bg-zinc-100 text-zinc-950 hover:bg-white"
              >
                Configure Control Matrix
                <ArrowUpRight weight="bold" className="h-4.5 w-4.5" />
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => scrollToId('defense-architecture')}
                className="bg-zinc-900 text-zinc-100 border border-zinc-700/80 hover:bg-zinc-800"
              >
                Inspect Local Engine
              </Button>
            </div>
          </div>

          {/* Right: Editorial Split Visual Monolith with Negative Space */}
          <div className="lg:col-span-4">
            <div className="hero-reveal group relative overflow-hidden rounded-3xl border border-zinc-800/80 bg-zinc-950 aspect-[4/5] shadow-[0_32px_80px_rgba(0,0,0,0.85)]">
              <img
                src={monolithImg}
                alt="Architectural concrete monolith"
                className="h-full w-full object-cover grayscale mix-blend-luminosity opacity-90 contrast-125 group-hover:scale-105 transition-transform duration-700 ease-out"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070709] via-[#070709]/35 to-transparent" />
              <div className="absolute bottom-6 inset-x-6 flex flex-col gap-1">
                <span className="font-mono text-xs text-zinc-400">
                  Xenova/bge-small-en-v1.5
                </span>
                <p className="text-sm font-medium text-zinc-200 m-0">
                  Zero telemetry. Multi-prototype cosine similarity in local WASM.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =====================================================================
          I — INTEREST: 5-CARD GAPLESS BENTO CONTROL MATRIX (py-32 md:py-48)
          Math Verification: Row 1 (7 + 5 = 12), Row 2 (6 + 6 = 12), Row 3 (12 = 12)
         ===================================================================== */}
      <section
        id="control-matrix"
        className="scroll-mt-24 relative z-10 mx-auto max-w-7xl px-6 md:px-12 py-32 md:py-48 border-t border-zinc-900/90"
      >
        <div className="mb-14 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h2 className="max-w-4xl text-3xl md:text-5xl font-semibold tracking-tight text-zinc-50 leading-[1.08]">
              Precision Blocking & Semantic Controls
            </h2>
            <p className="mt-3 max-w-2xl text-base text-zinc-400">
              Every threshold, category centroid, domain rule, and commitment lock is persisted
              locally and enforced across active tabs.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              onClick={() => void handleSaveSettings()}
              disabled={locked}
              className="bg-zinc-100 text-zinc-950 hover:bg-white"
            >
              {isOnboarded ? 'Apply & Save' : 'Finish setup'}
            </Button>
          </div>
        </div>

        {/* GAPLESS 12-COLUMN BENTO GRID */}
        <div className="grid grid-cols-1 md:grid-cols-12 grid-flow-dense gap-6">
          {/* BENTO CARD 1 (col-span-7): Engine Core, Threshold & System 1.5 Focus Context */}
          <Card className="md:col-span-7 md:row-span-1 flex flex-col justify-between">
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Sliders className="h-5 w-5 text-emerald-400" />
                  <CardTitle>Semantic Engine & Focus Context</CardTitle>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-zinc-300">Enable SmartBlocker</span>
                  <Switch
                    id="enabled-toggle"
                    checked={enabled}
                    disabled={locked}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                </div>
              </div>
              <CardDescription>
                Calibrate the softmax decision boundary and supply your current task intention so
                ambiguous lectures or technical threads are judged against your active work.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-6">
              {/* Block Threshold Slider */}
              <div className="rounded-xl border border-zinc-800/80 bg-[#111117] p-5">
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="threshold" className="text-sm font-medium text-zinc-200">
                    Block Confidence Threshold
                  </label>
                  <span
                    id="threshold-val"
                    className="font-mono text-base font-semibold text-emerald-400 tabular-nums"
                  >
                    {pct(threshold)}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mb-4">
                  Minimum confidence score before a page is blocked. Lower = stricter; higher = only
                  block when very confident.
                </p>
                <input
                  type="range"
                  id="threshold"
                  min="0.3"
                  max="0.9"
                  step="0.05"
                  value={threshold}
                  disabled={locked}
                  onChange={(e) => setThreshold(parseFloat(e.target.value))}
                  className="w-full h-2 rounded-lg appearance-none bg-zinc-800 accent-emerald-400 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
                />
                <div className="mt-2 flex justify-between font-mono text-[11px] text-zinc-500">
                  <span>30% (Strict)</span>
                  <span>50% (Calibrated Default)</span>
                  <span>90% (Conservative)</span>
                </div>
              </div>

              {/* Focus Context (System 1.5) */}
              <div className="rounded-xl border border-zinc-800/80 bg-[#111117] p-5">
                <div className="flex items-center justify-between mb-2">
                  <label
                    htmlFor="focus-goal"
                    className="flex items-center gap-2 text-sm font-medium text-zinc-200"
                  >
                    <Crosshair className="h-4 w-4 text-emerald-400" />
                    Active Focus Goal (System 1.5)
                  </label>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    2:1 Goal Weighting
                  </Badge>
                </div>
                <p className="text-xs text-zinc-400 mb-3.5">
                  Tell SmartBlocker what you are working on right now. Ambiguous pages (a YouTube
                  lecture, a Reddit thread about your coursework) are evaluated against your task
                  vector instead of URL reputation alone.
                </p>
                <Input
                  type="text"
                  id="focus-goal"
                  value={focusGoal}
                  disabled={locked}
                  onChange={(e) => setFocusGoal(e.target.value)}
                  placeholder="e.g., Studying linear algebra, Building Rust CLI..."
                  className="mb-4"
                />
                <div className="flex items-center justify-between pt-3 border-t border-zinc-800/70">
                  <span className="text-xs text-zinc-300 pr-4">
                    Infer task context from open productive tabs and focus goal to disambiguate
                    gray-zone pages
                  </span>
                  <Switch
                    id="use-tab-context"
                    checked={useTabContext}
                    disabled={locked}
                    onChange={(e) => setUseTabContext(e.target.checked)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* BENTO CARD 2 (col-span-5): Commitment Lock (Timer & Password) */}
          <Card
            id="commitment-lock"
            className="scroll-mt-24 md:col-span-5 md:row-span-1 flex flex-col"
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-36 overflow-hidden opacity-25">
              <img
                src={vaultImg}
                alt="Architectural vault texture"
                className="h-full w-full object-cover grayscale mix-blend-luminosity contrast-125 group-hover:scale-105 transition-transform duration-700 ease-out"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#0d0d12]" />
            </div>

            <CardHeader className="relative z-10">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <LockKey className="h-5 w-5 text-amber-400" />
                  <CardTitle>Commitment Lock</CardTitle>
                </div>
                <Badge variant={locked ? 'crimson' : 'outline'} className="font-mono text-[10px]">
                  {locked ? 'Locked' : 'Unlocked'}
                </Badge>
              </div>
              <CardDescription>
                Cold-Turkey-style commitment: while locked, no setting can be loosened and the block
                screen's bypass buttons disappear. Locks can be extended but never shortened.
              </CardDescription>
            </CardHeader>

            <CardContent className="relative z-10 flex flex-1 flex-col justify-between gap-4">
              {/* Timer Lock */}
              <div className="rounded-xl border border-zinc-800/80 bg-[#111117]/95 p-4">
                <span className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
                  Monotonic Timer Lock
                </span>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Input
                    type="number"
                    id="lock-duration"
                    min="1"
                    value={lockDuration}
                    onChange={(e) => setLockDuration(e.target.value)}
                    className="w-20 font-mono"
                  />
                  <Select
                    id="lock-unit"
                    value={lockUnit}
                    onChange={(e) => setLockUnit(e.target.value as 'h' | 'd')}
                    className="w-28"
                  >
                    <option value="h">hours</option>
                    <option value="d">days</option>
                  </Select>
                  <Button
                    id="lock-timer-btn"
                    variant={timerConfirmPending ? 'destructive' : 'default'}
                    onClick={() => void handleTimerLockClick()}
                    className="flex-1"
                  >
                    {timerBtnText}
                  </Button>
                </div>
              </div>

              {/* Password Lock */}
              <div className="rounded-xl border border-zinc-800/80 bg-[#111117]/95 p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    PBKDF2 Password Lock
                  </span>
                  {passwordArmed && (
                    <Badge variant="amber" className="text-[10px]">
                      Password Armed
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Input
                    type="password"
                    id="lock-password"
                    value={lockPassword}
                    onChange={(e) => setLockPassword(e.target.value)}
                    placeholder="Password (min 8 chars)"
                    className="flex-1 min-w-[160px]"
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
                  className="mt-2 block min-h-[18px] text-xs font-medium text-red-400"
                >
                  {lockPasswordMsg}
                </span>
              </div>

              {/* Monotonic Guarantee Note */}
              <div className="rounded-xl border border-zinc-800/60 bg-[#0a0a0f] px-4 py-3 text-xs text-zinc-400 leading-relaxed">
                <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-300 block mb-1">
                  Monotonic State Guarantee
                </span>
                Active locks synchronize with the native desktop daemon and survive extension
                reloads.
              </div>
            </CardContent>
          </Card>

          {/* BENTO CARD 3 (col-span-6): Categories to Block */}
          <Card className="md:col-span-6 md:row-span-1 flex flex-col justify-between">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Categories to Block</CardTitle>
                <Badge variant="outline" className="font-mono">
                  {checkedBlocked.size} / {currentLabels.length} Blocked
                </Badge>
              </div>
              <CardDescription>
                Toggle distraction prototypes or inject custom semantic categories into the vector
                space.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              <ul
                id="label-list"
                className="m-0 p-0 list-none divide-y divide-zinc-800/70 rounded-xl border border-zinc-800/80 bg-[#111117] max-h-[340px] overflow-y-auto"
              >
                {currentLabels.map((label) => {
                  const isChecked = checkedBlocked.has(label);
                  return (
                    <li
                      key={label}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-900/60 transition-colors"
                    >
                      <input
                        type="checkbox"
                        id={`lbl-${label}`}
                        checked={isChecked}
                        disabled={locked}
                        onChange={(e) => toggleCategory(label, e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-emerald-400 cursor-pointer disabled:cursor-not-allowed"
                      />
                      <span
                        onClick={() => toggleCategory(label, !isChecked)}
                        className={`label-name flex-1 text-sm capitalize select-none ${
                          locked ? 'cursor-default' : 'cursor-pointer'
                        } ${isChecked ? 'text-zinc-100 font-medium' : 'text-zinc-400'}`}
                      >
                        {label}
                      </span>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => removeCategory(label)}
                        title="Remove category"
                        className="delete-label-btn text-zinc-500 hover:text-red-400 disabled:opacity-40 px-1.5 py-0.5 text-base leading-none cursor-pointer transition-colors"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex items-center gap-2.5">
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
                  <Plus weight="bold" className="h-4 w-4" />
                  Add
                </Button>
              </div>
              <p className="m-0 text-xs text-zinc-500">
                Tip: use descriptive phrases like "cooking and recipes" rather than single words —
                embedding similarity improves with specific phrasing.
              </p>
            </CardContent>
          </Card>

          {/* BENTO CARD 4 (col-span-6): Whitelist & Deterministic Blocklist */}
          <Card className="md:col-span-6 md:row-span-1 flex flex-col justify-between">
            <CardHeader>
              <CardTitle>Deterministic Domain & Substring Rules</CardTitle>
              <CardDescription>
                Short-circuit the neural classifier with explicit domain exemptions or zero-latency
                substring blocks.
              </CardDescription>
            </CardHeader>

            <CardContent className="grid grid-cols-1 gap-5">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="whitelist" className="text-sm font-medium text-zinc-200">
                    Whitelisted Sites (Never Blocked)
                  </label>
                  <span className="font-mono text-[11px] text-emerald-400">Subdomain-aware</span>
                </div>
                <p className="text-xs text-zinc-400 mb-2.5">
                  One domain per line — a domain also covers its subdomains (e.g.{' '}
                  <code className="text-zinc-300">google.com</code> covers{' '}
                  <code className="text-zinc-300">mail.google.com</code>).
                </p>
                <Textarea
                  id="whitelist"
                  spellCheck={false}
                  disabled={locked}
                  value={whitelistText}
                  onChange={(e) => setWhitelistText(e.target.value)}
                  placeholder={'github.com\nmail.google.com\nlocalhost'}
                  className="min-h-[145px]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="blocklist" className="text-sm font-medium text-zinc-200">
                    Deterministic Blocklist (Always Blocked)
                  </label>
                  <span className="font-mono text-[11px] text-red-400">0ms Instant Match</span>
                </div>
                <p className="text-xs text-zinc-400 mb-2.5">
                  Matched as a substring against the full URL and page title. A match blocks
                  instantly without running AI inference.
                </p>
                <Textarea
                  id="blocklist"
                  spellCheck={false}
                  disabled={locked}
                  value={blocklistText}
                  onChange={(e) => setBlocklistText(e.target.value)}
                  placeholder={'amazon.com\n/cart\nblack friday'}
                  className="min-h-[145px]"
                />
              </div>
            </CardContent>
          </Card>

          {/* BENTO CARD 5 (col-span-12): Schedules, Desktop Companion, History Scan & Feedback Loop */}
          <Card className="md:col-span-12 md:row-span-1">
            <CardContent className="p-6 md:p-8">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 divide-y lg:divide-y-0 lg:divide-x divide-zinc-800/80">
                {/* Sub-panel 1: Scheduled Blocks (5 cols) */}
                <div className="lg:col-span-5 lg:pr-6 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Clock className="h-5 w-5 text-amber-400" />
                      <h3 className="text-lg font-semibold text-zinc-50 m-0">Scheduled Blocks</h3>
                    </div>
                    <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                      Recurring locked windows — during them blocking is forced on (even if
                      SmartBlocker is toggled off) and settings are frozen. End time earlier than
                      start creates an overnight window.
                    </p>

                    <div id="schedule-list" className="flex flex-col gap-2.5 mb-4">
                      {scheduleRules.map((rule) => (
                        <div
                          key={rule.id}
                          className="schedule-row flex items-center gap-2 flex-wrap rounded-xl border border-zinc-800/90 bg-[#111117] p-3 text-xs"
                        >
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {DAY_NAMES.map((dayName, d) => (
                              <label
                                key={d}
                                className="day-label inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 py-1 cursor-pointer select-none"
                              >
                                <input
                                  type="checkbox"
                                  checked={rule.days.includes(d)}
                                  disabled={locked}
                                  onChange={(e) =>
                                    handleToggleScheduleDay(rule.id, d, e.target.checked)
                                  }
                                  className="accent-emerald-400"
                                />
                                <span className="text-[11px] text-zinc-300">{dayName}</span>
                              </label>
                            ))}
                          </div>

                          <div className="mt-1 flex items-center gap-2 w-full justify-between pt-2 border-t border-zinc-800/60">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="time"
                                value={minutesToHHMM(rule.startMinutes)}
                                disabled={locked}
                                onChange={(e) =>
                                  handleScheduleTimeChange(rule.id, 'startMinutes', e.target.value)
                                }
                                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
                              />
                              <span className="text-zinc-500">–</span>
                              <input
                                type="time"
                                value={minutesToHHMM(rule.endMinutes)}
                                disabled={locked}
                                onChange={(e) =>
                                  handleScheduleTimeChange(rule.id, 'endMinutes', e.target.value)
                                }
                                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
                              />
                            </div>
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => handleRemoveSchedule(rule.id)}
                              title="Remove schedule"
                              className="schedule-remove text-zinc-500 hover:text-red-400 px-2 py-0.5 text-base leading-none cursor-pointer"
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 flex-wrap pt-2">
                    <Button
                      id="schedule-add"
                      variant="secondary"
                      size="sm"
                      disabled={locked}
                      onClick={handleAddSchedule}
                    >
                      Add schedule
                    </Button>
                    <Button
                      id="schedule-save"
                      variant="default"
                      size="sm"
                      disabled={locked}
                      onClick={() => void handleSaveSchedules()}
                    >
                      Save schedules
                    </Button>
                    <span
                      id="schedule-msg"
                      className={`text-xs font-medium ${
                        scheduleMsgError ? 'text-red-400' : 'text-emerald-400'
                      }`}
                    >
                      {scheduleMsg}
                    </span>
                  </div>
                </div>

                {/* Sub-panel 2: Desktop Companion & History Scanner (4 cols) */}
                <div className="lg:col-span-4 pt-6 lg:pt-0 lg:px-6 flex flex-col justify-between gap-6">
                  {/* Desktop Companion */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Desktop className="h-5 w-5 text-emerald-400" />
                      <h3 className="text-lg font-semibold text-zinc-50 m-0">Desktop Companion</h3>
                    </div>
                    <p className="text-xs text-zinc-400 mb-3 leading-relaxed">
                      Turns locks into hard enforcement: closes blocklisted apps and restarts the
                      browser if SmartBlocker is disabled during a locked session.
                    </p>
                    <div
                      id="companion-status"
                      className={`rounded-xl border px-3.5 py-2.5 text-xs font-semibold ${
                        companionState === 'connected'
                          ? 'companion-connected border-emerald-500/40 bg-emerald-500/12 text-emerald-300'
                          : 'companion-muted border-zinc-800 bg-[#111117] text-zinc-400 font-normal italic'
                      }`}
                    >
                      {companionText}
                    </div>
                    <ul
                      id="companion-enforcement"
                      style={{ display: companionFlags.length > 0 ? 'block' : 'none' }}
                      className="m-0 mt-3 p-0 list-none space-y-1.5 text-xs text-zinc-300"
                    >
                      {companionFlags.map((f, i) => (
                        <li key={i} className="flex items-center gap-2">
                          {f.ok ? (
                            <CheckCircle weight="fill" className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <XCircle weight="fill" className="h-4 w-4 text-zinc-500" />
                          )}
                          <span>{f.label}</span>
                        </li>
                      ))}
                    </ul>
                    {incognitoAllowed === false && (
                      <div
                        id="incognito-warning"
                        className="mt-3 rounded-xl border border-amber-500/45 bg-amber-500/10 px-3.5 py-3"
                      >
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Warning weight="fill" className="h-4 w-4 shrink-0 text-amber-400" />
                          <span className="text-xs font-semibold text-amber-200">
                            Incognito bypass possible
                          </span>
                        </div>
                        <p className="m-0 text-[11px] leading-relaxed text-amber-100/75">
                          Incognito access is currently disabled for SmartBlocker, so anything
                          opened in an Incognito window ignores your blocks — even during an
                          active lock. To close the loophole, open{' '}
                          <code className="font-mono text-amber-200">chrome://extensions</code>,
                          find SmartBlocker, and turn on{' '}
                          <span className="font-semibold text-amber-100">Allow in Incognito</span>
                          .
                        </p>
                      </div>
                    )}
                  </div>

                  {/* History Scan */}
                  <div className="pt-5 border-t border-zinc-800/70">
                    <div className="flex items-center gap-2 mb-2">
                      <ClockCounterClockwise className="h-5 w-5 text-zinc-300" />
                      <h3 className="text-base font-semibold text-zinc-50 m-0">History Audit</h3>
                    </div>
                    <p className="text-xs text-zinc-400 mb-3">
                      Scan recent browsing history locally to quantify distraction categories.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        id="scan-btn"
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleScanHistory()}
                      >
                        Scan my history
                      </Button>
                      <Button
                        id="block-top-btn"
                        variant="emerald"
                        size="sm"
                        disabled={locked}
                        style={{ display: showBlockTopBtn ? 'inline-flex' : 'none' }}
                        onClick={handleBlockTopDistractions}
                      >
                        Block my top distractions
                      </Button>
                    </div>
                    <div id="scan-status" className="mt-2 min-h-[18px] text-xs text-emerald-400">
                      {scanStatusText}
                    </div>
                    <pre
                      id="scan-out"
                      style={{ display: scanOutVisible ? 'block' : 'none' }}
                      className="m-0 mt-2 max-h-[180px] overflow-auto rounded-xl border border-zinc-800 bg-[#050507] p-3 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap break-words"
                    >
                      {scanOutText}
                    </pre>
                  </div>
                </div>

                {/* Sub-panel 3: On-Device Feedback Loop (3 cols) */}
                <div className="lg:col-span-3 pt-6 lg:pt-0 lg:pl-6 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Brain className="h-5 w-5 text-emerald-400" />
                      <h3 className="text-lg font-semibold text-zinc-50 m-0">On-Device Learning</h3>
                    </div>
                    <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                      When you correct SmartBlocker, the correction is stored on this device and
                      folds directly into category centroids.{' '}
                      <span id="feedback-count" className="font-mono font-semibold text-zinc-100">
                        {feedbackCount}
                      </span>{' '}
                      correction(s) recorded.
                    </p>

                    <div className="flex items-center gap-2 flex-wrap mb-5">
                      <Button
                        id="feedback-export"
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleExportFeedback()}
                      >
                        Export as JSON
                      </Button>
                      <Button
                        id="feedback-clear"
                        variant="outline"
                        size="sm"
                        disabled={locked}
                        onClick={() => void handleClearFeedback()}
                      >
                        Clear all
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800/80 bg-[#111117] p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <span className="text-xs font-medium text-zinc-200">
                        Share my corrections to improve SmartBlocker (off by default)
                      </span>
                      <Switch
                        id="share-toggle"
                        checked={shareFeedback}
                        disabled={locked}
                        onChange={(e) => setShareFeedback(e.target.checked)}
                      />
                    </div>
                    <p className="m-0 text-[11px] text-zinc-500 leading-relaxed">
                      Sends only page title, hostname, and verdict delta. Never full URLs or
                      browsing history. See PRIVACY.md.
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-800/80 bg-[#111117] p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <span className="text-xs font-medium text-zinc-200">
                        Resolve embed titles via YouTube oEmbed (off by default)
                      </span>
                      <Switch
                        id="oembed-toggle"
                        checked={resolveEmbedTitles}
                        disabled={locked}
                        onChange={(e) => setResolveEmbedTitles(e.target.checked)}
                      />
                    </div>
                    <p className="m-0 text-[11px] text-zinc-500 leading-relaxed">
                      Last-resort title lookup for untitled embedded YouTube players — sends the
                      video ID to www.youtube.com. Never fires for youtube-nocookie or privacy
                      facades. See PRIVACY.md.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* =====================================================================
          D — DESIRE: INFINITE MARQUEE, SCRUBBING MANIFESTO, PINNED SPLIT &
              HORIZONTAL ACCORDIONS (py-32 md:py-48)
         ===================================================================== */}
      <section
        id="defense-architecture"
        className="scroll-mt-24 relative z-10 py-32 md:py-48 border-t border-zinc-900/90"
      >
        {/* COMPONENT ARSENAL 1: INFINITE MARQUEE */}
        <div className="w-full overflow-hidden border-y border-zinc-800/80 bg-[#0a0a0e] py-6 mb-32">
          <div className="animate-marquee flex items-center gap-14">
            {[0, 1].map((dup) => (
              <div key={dup} className="flex items-center gap-14 shrink-0">
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-zinc-300">
                  <Cpu className="h-6 w-6 text-emerald-400" />
                  100% Local ONNX WASM
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-zinc-300">
                  <Lightning className="h-6 w-6 text-amber-400" />
                  Sub-15ms Title Embedding
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-zinc-300">
                  <Fingerprint className="h-6 w-6 text-emerald-400" />
                  Multi-Prototype Centroids
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-zinc-300">
                  <EyeSlash className="h-6 w-6 text-zinc-400" />
                  Zero Cloud Telemetry
                </span>
                <span className="flex items-center gap-3 text-xl md:text-2xl font-semibold tracking-tight text-zinc-300">
                  <Sparkle className="h-6 w-6 text-emerald-400" />
                  97.6% E2E Decision Accuracy
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* GSAP PARADIGM 1: SCRUBBING TEXT REVEAL */}
        <div id="manifesto-section" className="mx-auto max-w-6xl px-6 md:px-12 mb-36">
          <p
            ref={scrubRef}
            className="text-3xl md:text-5xl font-semibold leading-[1.18] tracking-tight text-zinc-100"
          >
            {MANIFESTO_TEXT.split(' ').map((word, idx) => (
              <span key={idx} className="scrub-word inline-block mr-[0.28em]">
                {word}
              </span>
            ))}
          </p>
        </div>

        {/* GSAP PARADIGM 2: SCROLL PINNING SPLIT + IMAGE SCALE & FADE */}
        <div
          ref={pinSectionRef}
          className="mx-auto max-w-7xl px-6 md:px-12 grid grid-cols-1 lg:grid-cols-12 gap-12 items-start mb-36"
        >
          <div ref={pinLeftRef} className="lg:col-span-5 pr-4">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-zinc-50 leading-[1.08]">
              Engineered for Unbreakable Focus
            </h2>
            <p className="mt-5 text-base md:text-lg text-zinc-400 leading-relaxed">
              Every architectural layer is built to eliminate both latency and willpower loopholes—from
              persistent offscreen inference to native process watchdogs.
            </p>
          </div>

          <div className="lg:col-span-7 flex flex-col gap-12">
            {PINNED_CHAPTERS.map((item) => (
              <div
                key={item.title}
                className="gsap-scale-card group relative overflow-hidden rounded-3xl border border-zinc-800/80 bg-[#0d0d12] p-8 md:p-10"
              >
                <div className="overflow-hidden rounded-2xl border border-zinc-800/80 mb-6 aspect-[16/9]">
                  <img
                    src={item.image}
                    alt={item.title}
                    className="h-full w-full object-cover grayscale mix-blend-luminosity opacity-90 contrast-125 group-hover:scale-105 transition-transform duration-700 ease-out"
                  />
                </div>
                <h3 className="text-2xl font-semibold text-zinc-50 tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm md:text-base text-zinc-400 leading-relaxed m-0">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* COMPONENT ARSENAL 2: HORIZONTAL ACCORDIONS */}
        <div className="mx-auto max-w-7xl px-6 md:px-12">
          <h3 className="text-2xl md:text-4xl font-semibold tracking-tight text-zinc-50 mb-8">
            Three-Stage Interception Ladder
          </h3>
          <div className="flex flex-col md:flex-row gap-4 min-h-[420px]">
            {ACCORDION_PANELS.map((panel) => (
              <div
                key={panel.title}
                className="group relative flex-1 hover:flex-[2.4] transition-all duration-700 ease-out overflow-hidden rounded-3xl border border-zinc-800/80 bg-[#0d0d12] p-7 md:p-9 flex flex-col justify-end"
              >
                <img
                  src={panel.image}
                  alt={panel.title}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover grayscale mix-blend-luminosity opacity-30 contrast-125 group-hover:scale-105 group-hover:opacity-45 transition-all duration-700 ease-out"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070709] via-[#070709]/80 to-transparent" />
                <div className="relative z-10">
                  <span className="font-mono text-xs text-emerald-400">{panel.subtitle}</span>
                  <h4 className="mt-2 text-xl md:text-2xl font-semibold text-zinc-50 tracking-tight">
                    {panel.title}
                  </h4>
                  <p className="mt-3 max-w-xl text-sm text-zinc-300 leading-relaxed opacity-85 group-hover:opacity-100 transition-opacity duration-500">
                    {panel.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =====================================================================
          A — ACTION: HIGH-CONTRAST COMMIT FOOTER (py-32 md:py-48)
         ===================================================================== */}
      <footer
        id="commit-section"
        className="scroll-mt-24 relative z-10 mx-auto max-w-7xl px-6 md:px-12 py-32 md:py-48 border-t border-zinc-900"
      >
        <div className="rounded-3xl border border-zinc-800/90 bg-gradient-to-b from-[#111118] to-[#09090d] p-10 md:p-16 flex flex-col md:flex-row items-start md:items-center justify-between gap-8 shadow-[0_32px_90px_rgba(0,0,0,0.85)]">
          <div className="max-w-2xl">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-zinc-50 leading-[1.06]">
              Commit Your Focus Policy
            </h2>
            <p className="mt-4 text-base text-zinc-400 leading-relaxed m-0">
              Changes take effect immediately across all open browser tabs and synchronize with your
              local centroid cache.
            </p>
          </div>

          <div className="flex flex-col items-start md:items-end gap-3 shrink-0">
            <div className="flex items-center gap-4">
              <Button
                id="save-btn"
                variant="default"
                size="lg"
                disabled={locked}
                onClick={() => void handleSaveSettings()}
                className="bg-zinc-100 text-zinc-950 hover:bg-white px-9 h-13 text-base font-semibold"
              >
                {isOnboarded ? 'Save' : 'Finish setup'}
              </Button>
              <span
                id="save-msg"
                className={`text-sm font-semibold transition-opacity duration-300 ${
                  saveMsgVisible ? 'visible opacity-100' : 'opacity-0'
                } ${saveMsgError ? 'text-red-400' : 'text-emerald-400'}`}
              >
                {saveMsgText}
              </span>
            </div>

            <span
              id="model-progress"
              style={{ display: modelProgressVisible ? 'inline-block' : 'none' }}
              className="font-mono text-xs text-zinc-400"
            >
              {modelProgressText}
            </span>
          </div>
        </div>

        <div className="mt-16 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500 font-mono">
          <span>SmartBlocker v0.5.0 — Local-AI Distraction Blocker</span>
          <span>100% On-Device Inference · Privacy-First Architecture</span>
        </div>
      </footer>
    </main>
  );
}
