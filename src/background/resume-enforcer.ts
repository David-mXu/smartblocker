// Auto-resume ("autostart-resume", Phase 5 batch 1): optionally turn the
// master blocking toggle back ON after the user disables it. Cold Turkey
// ships this as "Autostart Blocks" to close the #1 relapse path — "I forgot
// to turn my block back on" (docs/audits/2026-11-07-cold-turkey-blocker-
// landscape-audit.md §1.3).
//
// STATE MACHINE (derived, settings are the source of truth — nothing else
// is persisted):
//   ARMED   ⇔ settings.resumeMode !== 'off' && settings.enabled === false
//   FIRED   → setSettings({ enabled: true, resumeAt: null }) + a quiet
//             notification. Never fires while any lock is active: a timed
//             lock DEFERS the resume to the lock's end, an indefinite
//             (password) lock drops it — blocking is enforced anyway and
//             setSettings would throw.
//   CLEARED → the master toggle returning to ON (by the user OR by firing)
//             nulls resumeAt; resumeMode survives, so the next disable
//             re-arms. Setting resumeMode to 'off' also nulls resumeAt.
//
// PROMPTNESS-ONLY alarm, same doctrine as lock-enforcer.ts: every state of
// interest is re-derived from stored settings + lockState, so a missed or
// late alarm never strands anything — the SW-start re-check below and the
// storage.onChanged listeners always bring the one-shot `resume-at` alarm
// back in line (and fire overdue resumes immediately, missed-while-asleep).
import { api } from '../shared/api';
import { getLockState, getLockStatus } from '../shared/lock';
import { getSettings, setSettings, type Settings } from '../shared/settings';
import {
  nextResumeAt,
  normalizeResumeMode,
  RESUME_ALARM_NAME,
  type ResumeMode,
} from '../shared/resume';

// storage.session marker: storage.session survives MV3 SW restarts but is
// discarded when the browser process exits, so ABSENT-at-SW-boot ≈ a cold
// browser start. That is the 'startup' trigger's cold-start test (see
// maybeResumeStartup for the full reasoning).
const BOOT_KEY = 'resumeBootId';

/** True once per browser session (first SW boot), false on later SW
 *  restarts within the session. Fails safe to false when storage.session is
 *  unavailable — runtime.onStartup then remains the only 'startup' path. */
async function isColdBoot(): Promise<boolean> {
  try {
    if (!api.storage.session) return false;
    const stored = await api.storage.session.get(BOOT_KEY);
    if (stored[BOOT_KEY]) return false;
    await api.storage.session.set({ [BOOT_KEY]: Date.now() });
    return true;
  } catch {
    return false;
  }
}

interface ArmedPlan {
  mode: ResumeMode;
  resumeAt: number | null;
}

/** The armed plan, or null when auto-resume is inert (mode 'off', an
 *  unknown stored mode, or blocking already on). */
async function readArmedPlan(): Promise<ArmedPlan | null> {
  const s = await getSettings();
  const mode = normalizeResumeMode(s.resumeMode);
  if (mode === 'off' || s.enabled) return null;
  return { mode, resumeAt: s.resumeAt };
}

/** Quiet best-effort OS notification. The current manifests deliberately
 *  carry no "notifications" permission (feature constraint: manifests are
 *  out of scope), so `api.notifications` is undefined at runtime and this
 *  no-ops — it lights up automatically if the permission is ever added. */
async function notifyResumed(): Promise<void> {
  try {
    if (!api.notifications?.create) return;
    await api.notifications.create('smartblocker-auto-resume', {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.png'),
      title: 'Smart Blocker',
      message: 'Blocking resumed automatically',
      silent: true,
    });
  } catch (e) {
    console.warn('[SmartBlocker] resume notification failed:', e);
  }
}

// Reentrancy guard: resumeNow writes settings, which wakes the storage
// listener, which re-syncs — all idempotent, but the guard keeps a single
// logical fire from overlapping itself (alarm + onStartup can race).
let firing = false;

/** Fire an armed resume now. Idempotent: racing triggers land on the one
 *  guarded write, and once `enabled` is true every later call no-ops. */
async function resumeNow(): Promise<void> {
  if (firing) return;
  firing = true;
  try {
    if ((await getSettings()).enabled) return;
    const lock = await getLockStatus();
    if (lock.settingsLocked) {
      // A lock means blocking is enforced anyway (schedule window, Frozen
      // Turkey, timer, password) — an auto-resume mid-lock is pointless AND
      // setSettings would throw. Defer past a timed lock (+1s so the end
      // strictly passed, mirroring the lock-boundary alarm); drop under an
      // indefinite password lock.
      if (lock.until !== null) {
        void api.alarms.create(RESUME_ALARM_NAME, { when: lock.until + 1000 });
      } else {
        void api.alarms.clear(RESUME_ALARM_NAME);
      }
      return;
    }
    try {
      await setSettings({ enabled: true, resumeAt: null });
    } catch (e) {
      // Lost a race with a fresh lock — never fight setSettings' lock-throw.
      console.warn('[SmartBlocker] auto-resume write refused:', e);
      return;
    }
    void api.alarms.clear(RESUME_ALARM_NAME);
    console.log('[SmartBlocker] blocking resumed automatically');
    await notifyResumed();
  } finally {
    firing = false;
  }
}

/** Re-derive the one-shot resume alarm from stored state; fire immediately
 *  when the target is already overdue (missed-while-asleep). Runs on SW
 *  boot and on every settings/lockState change, so it self-heals any
 *  ordering of edits (mode switch, resumeAt edit, schedule edit, toggle). */
async function syncResume(): Promise<void> {
  if (firing) return;
  const plan = await readArmedPlan();
  if (!plan || plan.mode === 'startup') {
    // 'startup' is event-driven — no clock trigger exists for it.
    void api.alarms.clear(RESUME_ALARM_NAME);
    return;
  }
  const target = nextResumeAt(plan, (await getLockState()).schedules, Date.now());
  if (target === null) {
    // e.g. 'time' with no valid instant, or 'schedule' with no schedules.
    void api.alarms.clear(RESUME_ALARM_NAME);
    return;
  }
  if (target <= Date.now()) {
    void resumeNow();
    return;
  }
  void api.alarms.create(RESUME_ALARM_NAME, { when: target });
}

/** Master toggle back on (any surface: popup, options, welcome wizard) →
 *  an armed resume clears: resumeAt nulls, the mode survives for next time.
 *  Also nulls a stray resumeAt whenever the mode is 'off'. (Auto-resume's
 *  own firing write already carries resumeAt: null, so this is a no-op for
 *  the FIRED transition.) */
async function disarmOnReEnable(change: chrome.storage.StorageChange): Promise<void> {
  const prev = change.oldValue as Partial<Settings> | undefined;
  const curr = change.newValue as Partial<Settings> | undefined;
  if (!curr || curr.resumeAt === null || curr.resumeAt === undefined) return;
  const turnedOn = curr.enabled === true && prev?.enabled === false;
  const modeOff = normalizeResumeMode(curr.resumeMode) === 'off';
  if (!turnedOn && !modeOff) return;
  try {
    await setSettings({ resumeAt: null });
  } catch (e) {
    // A lock landed concurrently — the stray resumeAt stays but is inert
    // (the toggle is on), and the next disable re-arms cleanly anyway.
    console.warn('[SmartBlocker] resume disarm write refused:', e);
  }
}

/** The 'startup' trigger. Documented choice: 'startup' means "next BROWSER
 *  session", NOT "next MV3 service-worker boot". A plain SW restart must
 *  not fire it — navigation wakes the SW constantly (initBlocker's
 *  listeners run regardless of `enabled`), so firing on every SW boot would
 *  collapse "on browser startup" into "within minutes of disabling" and
 *  make the mode useless. We therefore fire on:
 *    1. runtime.onStartup — Chrome/FF's real browser-start signal; and
 *    2. an SW boot whose storage.session boot marker is ABSENT — the cold-
 *       start catch-up for a browser start whose onStartup raced or never
 *       reached us. storage.session dies with the browser process but
 *       survives SW reaps, so SW-restart-within-a-session boots see the
 *       marker and stay inert.
 *  The armed state itself is durable (it lives in settings), so nothing is
 *  lost when a mid-session SW boot declines to fire. */
async function maybeResumeStartup(coldBoot: boolean): Promise<void> {
  if (!coldBoot) return;
  const plan = await readArmedPlan();
  if (plan?.mode === 'startup') void resumeNow();
}

/** MV3: called synchronously from index.ts startup (constraint #4). */
export function initResumeEnforcer(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESUME_ALARM_NAME) {
      void resumeNow().catch((e) => console.warn('[SmartBlocker] resume fire error:', e));
    }
  });

  // Primary 'startup' trigger: the genuine browser-start event.
  api.runtime.onStartup.addListener(() => {
    void (async () => {
      await maybeResumeStartup(true);
      await syncResume();
    })().catch((e) => console.warn('[SmartBlocker] onStartup resume error:', e));
  });

  // Settings writes arm/clear the feature (master toggle, mode, resumeAt);
  // lockState writes re-target 'schedule' mode and gate firing.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes['settings'] && !changes['lockState'])) return;
    void (async () => {
      if (changes['settings']) await disarmOnReEnable(changes['settings']);
      await syncResume();
    })().catch((e) => console.warn('[SmartBlocker] resume change handling error:', e));
  });

  // SW (re)start: mark this browser session's boot, re-derive the alarm
  // (fires overdue 'time'/'schedule' resumes immediately — missed-while-
  // asleep), and run the 'startup' cold-boot catch-up.
  void (async () => {
    const cold = await isColdBoot();
    await syncResume();
    await maybeResumeStartup(cold);
  })().catch((e) => console.warn('[SmartBlocker] resume init error:', e));
}
