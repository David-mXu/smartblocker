// Background wiring for the lock system. The alarm here is PROMPTNESS-only:
// every enforcement path (setSettings guard, blocker gates, options/popup UI)
// re-derives activeness from Date.now() vs stored timestamps, so a missed or
// late alarm can never extend or weaken a lock. What the alarm buys us is
// sweeping already-open tabs the moment a blocking window starts, instead of
// waiting for the next navigation.
//
// Clock-tamper guard: duration locks (Timer Lock, Frozen Turkey) and a running
// delay-unlock countdown store absolute wall-clock end times, so jumping the OS
// clock forward past timerUntil/frozenUntil/delayUntil would expire them early.
// A periodic wall-clock vs
// monotonic comparison detects forward jumps and shifts active end timestamps
// forward by the skew. Schedule rules are intentionally NOT compensated —
// they are wall-clock windows by definition.
import { api, IS_FIREFOX } from '../shared/api';
import { getLockState, getLockStatus, mergeRemoteLockState } from '../shared/lock';
import { nextBoundary } from '../shared/lock-math';
import { advanceCategoryPolicyEpoch, sweepOpenTabs } from './blocker';
import { completeReadyDelayUnlock } from './lock-types';

const ALARM_NAME = 'lock-boundary';
const FF_KEEPALIVE_ALARM = 'firefox-sw-keepalive';

// Wall-vs-monotonic skew tracking. performance.now() is monotonic and immune
// to OS clock edits, so wall time racing ahead of it means the user is
// jumping the system clock forward to end a lock early. Two detectors
// (red-team #10):
//   1. The per-tick JUMP guard: wall delta between consecutive checks racing
//      past the monotonic delta by > 60s — the loud, immediate detector.
//   2. The CUMULATIVE unexplained-drift anchor: +55s nudges every few seconds
//      sit under the per-tick tolerance forever, but they ACCUMULATE. At lock
//      start we persist (wall0, mono0); every check computes
//          unexplained = (wall − wall0) − (mono − mono0)
//      and once that exceeds the tolerance, every active lock deadline
//      shifts forward by the FULL unexplained amount (fail-safe direction;
//      backward drift only ever lengthens locks, so it's never compensated)
//      and the anchor re-bases (wall0 += shift, keep mono0) so the guard
//      doesn't double-fire on the following ticks.
const CLOCK_CHECK_INTERVAL_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
let lastWallMs = Date.now();
let lastMonoMs = performance.now();

// The anchor is a per-node diagnostic, NOT part of the merged lock state
// (peers must never merge each other's clocks), so it lives in its own
// storage key and is persisted: an MV3 service-worker restart must not
// forgive accumulated drift. Lifecycle: created when a lock is first
// observed active, re-based after every compensation, DELETED the moment no
// lock is active. Format: { "wall0": epochMs, "mono0": performance.now() }.
const CLOCK_ANCHOR_KEY = 'lockClockAnchor';
interface ClockAnchor {
  wall0: number;
  mono0: number;
}
// undefined = not read from storage yet (fresh SW instance).
let anchorCache: ClockAnchor | null | undefined;

function parseAnchor(raw: unknown): ClockAnchor | null {
  const a = raw as Partial<ClockAnchor> | null | undefined;
  if (
    a &&
    typeof a.wall0 === 'number' &&
    Number.isFinite(a.wall0) &&
    a.wall0 > 0 &&
    typeof a.mono0 === 'number' &&
    Number.isFinite(a.mono0) &&
    a.mono0 >= 0
  ) {
    return { wall0: a.wall0, mono0: a.mono0 };
  }
  return null;
}

async function getAnchor(): Promise<ClockAnchor | null> {
  if (anchorCache !== undefined) return anchorCache;
  const stored = await api.storage.local.get(CLOCK_ANCHOR_KEY);
  anchorCache = parseAnchor(stored[CLOCK_ANCHOR_KEY]);
  return anchorCache;
}

async function setAnchor(anchor: ClockAnchor | null): Promise<void> {
  anchorCache = anchor;
  // Only this module ever writes the key, so the cache can't go stale.
  if (anchor === null) await api.storage.local.remove(CLOCK_ANCHOR_KEY);
  else await api.storage.local.set({ [CLOCK_ANCHOR_KEY]: anchor });
}

/** Extend every still-active duration-lock deadline by `shiftMs` (fail-safe
 *  direction — the merge is monotonic, timestamps only ever move later, so
 *  the shifted values always win without touching any other lock source).
 *  "Active" = not yet expired at `referenceWallMs`. Schedules are NOT
 *  shifted: they are wall-clock windows by definition (and are now pinned
 *  to their own tz offset). Returns true when a deadline actually moved. */
async function shiftActiveDeadlines(referenceWallMs: number, shiftMs: number): Promise<boolean> {
  const state = await getLockState();
  const timerUntil =
    state.timerUntil !== null && state.timerUntil > referenceWallMs
      ? state.timerUntil + shiftMs
      : state.timerUntil;
  const frozenUntil =
    state.frozenUntil !== null && state.frozenUntil > referenceWallMs
      ? state.frozenUntil + shiftMs
      : state.frozenUntil;
  const delayUntil =
    typeof state.delayUntil === 'number' &&
    Number.isFinite(state.delayUntil) &&
    state.delayUntil > referenceWallMs
      ? state.delayUntil + shiftMs
      : state.delayUntil;
  if (
    timerUntil === state.timerUntil &&
    frozenUntil === state.frozenUntil &&
    delayUntil === state.delayUntil
  ) {
    return false;
  }
  // Equal-stamp delay conflicts choose the later deadline, so this merge
  // extends only a running countdown; waiting (0) and released gates are inert.
  await mergeRemoteLockState({ ...state, timerUntil, frozenUntil, delayUntil });
  return true;
}

/** Run both clock-tamper detectors and maintain the drift anchor. A forward
 *  jump (one loud leap) or accumulated forward drift extends active Timer
 *  Lock / Frozen Turkey ends so fast-forwarding can never expire them
 *  early. Backward movement needs no handling — it only ever makes a lock
 *  last LONGER (the fail-safe direction). Suspend gaps: while the device is
 *  asleep performance.now() typically pauses with the process, so a wake
 *  looks like a wall jump; shifting the deadlines by the slept duration is
 *  the fail-safe answer (the lock outlasts the nap), and the re-anchor
 *  keeps it a one-time correction. */
async function checkClockSkew(): Promise<void> {
  const nowWall = Date.now();
  const nowMono = performance.now();
  const prevWallMs = lastWallMs;
  const wallDelta = nowWall - prevWallMs;
  const monoDelta = nowMono - lastMonoMs;
  lastWallMs = nowWall;
  lastMonoMs = nowMono;

  const status = await getLockStatus(nowWall);
  if (!status.settingsLocked && !status.forceBlocking) {
    // Anchor lifecycle: it exists strictly while a lock is active.
    if ((await getAnchor()) !== null) await setAnchor(null);
    return;
  }

  let anchor = await getAnchor();
  if (anchor === null || nowMono < anchor.mono0) {
    // Fresh lock, or the monotonic clock's origin moved backwards — an SW
    // restart gives performance.now() a new time origin, and wall drift
    // that happened while this process was dead is unattributable. The only
    // safe move is a silent re-anchor. (Residual: a patient attacker who
    // kills the SW, nudges the clock < the expired-by-wall amount, and lets
    // it restart buys at most that gap — deadlines are wall-based, so a
    // lock that expired while nothing watched stays expired.)
    anchor = { wall0: nowWall, mono0: nowMono };
    await setAnchor(anchor);
  }

  // Detector 1: loud per-tick jump (pre-#10 behavior, kept).
  if (wallDelta > monoDelta + CLOCK_SKEW_TOLERANCE_MS) {
    const skew = Math.round(wallDelta - monoDelta);
    await shiftActiveDeadlines(prevWallMs, skew);
    console.warn(
      `[SmartBlocker] system clock jumped forward by ${skew}ms — extending active lock ends`,
    );
    anchor.wall0 += skew; // re-base: detector 2 must not count this skew again
    await setAnchor(anchor);
  }

  // Detector 2: cumulative unexplained drift since lock start — catches the
  // sub-tolerance ratchet that detector 1 cannot see.
  const unexplained = Math.round(nowWall - anchor.wall0 - (nowMono - anchor.mono0));
  if (unexplained > CLOCK_SKEW_TOLERANCE_MS) {
    await shiftActiveDeadlines(nowWall, unexplained);
    console.warn(
      `[SmartBlocker] cumulative clock drift of ${unexplained}ms since lock start — extending active lock ends`,
    );
    anchor.wall0 += unexplained; // re-base so the guard doesn't double-fire
    await setAnchor(anchor);
  }
}

/** (Re)schedule the one-shot alarm for the next lock start/end instant.
 *  +1s so the boundary has strictly passed by the time it fires. */
async function syncAlarm(): Promise<void> {
  const boundary = nextBoundary(await getLockState(), Date.now());
  if (boundary !== null) {
    await api.alarms.create(ALARM_NAME, { when: boundary + 1000 });
  } else {
    await api.alarms.clear(ALARM_NAME);
  }
}

async function onBoundary(): Promise<void> {
  await checkClockSkew();
  await completeReadyDelayUnlock();
  // A break start/end is a classifier-verdict boundary even when forceBlocking
  // is false. Scoped category windows also re-gate existing subitems here,
  // not only top-level tabs, so advance their invalidation epoch before work.
  advanceCategoryPolicyEpoch();
  await sweepOpenTabs();
  await syncAlarm();
}

/** MV3: called synchronously from index.ts startup. */
export function initLockEnforcer(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void onBoundary().catch((e) => console.warn('[SmartBlocker] lock boundary error:', e));
      return;
    }
    if (alarm.name === FF_KEEPALIVE_ALARM) {
      // The wake itself is the point; run the clock-tamper check while up.
      void checkClockSkew().catch((e) => console.warn('[SmartBlocker] clock check error:', e));
    }
  });

  // Periodic clock-tamper guard. Cheap while the background is awake
  // (getLockState is in-memory cached); when it sleeps, the stored
  // timestamps + per-check re-derivation remain authoritative.
  setInterval(() => {
    void checkClockSkew().catch((e) => console.warn('[SmartBlocker] clock check error:', e));
  }, CLOCK_CHECK_INTERVAL_MS);

  if (IS_FIREFOX) {
    // Firefox suspends MV3 backgrounds far more aggressively than Chrome,
    // which would evict the in-process embedding model mid-session and drop
    // enforcement during an active lock. A sub-minute recurring alarm plus a
    // lightweight runtime ping keep the background context resident.
    try {
      // Firefox 121 implements alarms.create with the older void return value;
      // newer Firefox/Chrome return a Promise. Promise.resolve supports both
      // without a `.catch` property access aborting background initialization.
      void Promise.resolve(api.alarms.create(FF_KEEPALIVE_ALARM, { periodInMinutes: 0.4 })).catch(
        (e) => console.warn('[SmartBlocker] keepalive alarm error:', e),
      );
    } catch (e) {
      console.warn('[SmartBlocker] keepalive alarm error:', e);
    }
    setInterval(() => {
      void api.runtime.getPlatformInfo().catch(() => {});
    }, 20_000);
  }

  // A lockState write from the popup/options wakes the SW via this listener —
  // that's how "Frozen Turkey" started from the popup immediately blocks
  // already-open distracting tabs, with no explicit message needed.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lockState']) return;
    void (async () => {
      await completeReadyDelayUnlock();
      await syncAlarm();
      // Lock/break writes are rare. Sweeping on both starts and cancellations
      // restores the correct classifier verdict without mutating the lock.
      await sweepOpenTabs();
    })().catch((e) => console.warn('[SmartBlocker] lock change handling error:', e));
  });

  // SW (re)start: rebuild the next alarm from wall time and re-evaluate so a
  // break cannot remain active after its stored re-block instant, nor remain
  // blocked after its delayed start. No timer callback derives truth from RAM.
  void (async () => {
    await completeReadyDelayUnlock();
    await syncAlarm();
    await sweepOpenTabs();
  })().catch((e) => console.warn('[SmartBlocker] lock init error:', e));
}
