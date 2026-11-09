// Background wiring for opt-in reminders. Nothing here depends on a page
// being open: the MV3 service worker may be asleep for hours, so the only
// durable triggers are chrome.alarms (one-shot, one per kind) plus
// storage.onChanged. Every wake re-derives the plan from the CURRENT lock
// state + allowance authority + settings, which is the same promptness-only
// doctrine as lock-enforcer.ts and resume-enforcer.ts.
//
// Why one-shot alarms instead of a periodic tick:
//   - a periodic tick either misses exact lead instants or wakes constantly;
//   - a one-shot alarm is overwritten by the next reconcile, so state changes
//     (schedule deleted, break cancelled, toggle off) clean it up immediately;
//   - after a reminder fires, the next reconcile can arm the FOLLOWING
//     schedule start without needing another storage event.
//
// Duplicate suppression is two-layered:
//   1. fixed OS-notification ids replace a still-visible toast of the same
//      kind instead of stacking; and
//   2. a bounded `notificationState` ledger stores one key per delivered
//      event (schedule start, break window, allowance grant), so a late alarm,
//      SW restart, or overlapping reconcile can never redeliver it.
import { api } from '../shared/api';
import { getLockState } from '../shared/lock';
import { getSettings } from '../shared/settings';
import { getAllowanceResponse } from './allowance';
import {
  NOTIFICATION_ALARM_NAMES,
  NOTIFICATION_IDS,
  NOTIFICATION_KINDS,
  isAllowlistedNotificationAlarm,
  isAllowlistedNotificationId,
  isNotificationAlarm,
  normalizeNotificationLedger,
  planNotifications,
  rememberNotification,
  type NotificationEvent,
  type NotificationKind,
  type NotificationLedger,
} from '../shared/notifications';

const LEDGER_KEY = 'notificationState';

let ledgerCache: NotificationLedger | null = null;
// One logical reconcile at a time. Alarm + storage-change bursts are cheap and
// rare, so a simple promise chain is clearer than a coalescing state machine.
let queue: Promise<void> = Promise.resolve();
// In-flight guards survive a slow notifications.create without serializing
// unrelated kinds.
const firingKeys = new Set<string>();

function enqueue(task: () => Promise<void>): void {
  queue = queue
    .then(task)
    .catch((error) => console.warn('[SmartBlocker] notification reconcile error:', error));
}

async function getLedger(): Promise<NotificationLedger> {
  if (ledgerCache) return ledgerCache;
  try {
    const stored = await api.storage.local.get(LEDGER_KEY);
    ledgerCache = normalizeNotificationLedger(stored[LEDGER_KEY]);
  } catch {
    ledgerCache = normalizeNotificationLedger(undefined);
  }
  return ledgerCache;
}

async function setLedger(next: NotificationLedger): Promise<void> {
  ledgerCache = next;
  try {
    await api.storage.local.set({ [LEDGER_KEY]: next });
  } catch (error) {
    // The notification already left; a failed bookkeeping write can at worst
    // duplicate one reminder after a restart, never lose it.
    console.warn('[SmartBlocker] notification ledger write failed:', error);
  }
}

/** Allowance authority can live in the daemon and be mirrored into local
 *  storage. Prefer the live authority; fall back to the local snapshot. */
async function readAllowanceState(): Promise<unknown> {
  try {
    const response = await getAllowanceResponse();
    if (response.state) return response.state;
  } catch {
    // Companion/daemon unavailable — use the extension's own snapshot.
  }
  try {
    const stored = await api.storage.local.get('allowanceAuthority');
    return stored['allowanceAuthority'];
  } catch {
    return undefined;
  }
}

/** Silent, best-effort OS toast. Returns true only when the API accepted the
 *  call; permission/OS failures are swallowed because a reminder is optional
 *  and must never break blocking, the popup, or the service worker. */
async function showNotification(event: NotificationEvent): Promise<boolean> {
  try {
    const create = api.notifications?.create;
    if (typeof create !== 'function') return false;
    const id = NOTIFICATION_IDS[event.kind];
    if (!isAllowlistedNotificationId(id)) return false;
    const created = api.notifications.create(id, {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.png'),
      title: event.title,
      message: event.message,
      silent: true,
    });
    // Chrome's @types are callback-era (void); Firefox returns a Promise.
    // Promise.resolve handles both without feature-testing the browser.
    await Promise.resolve(created);
    return true;
  } catch (error) {
    console.warn('[SmartBlocker] notification was skipped:', error);
    return false;
  }
}

async function fire(event: NotificationEvent): Promise<boolean> {
  if (firingKeys.has(event.dedupeKey)) return false;
  firingKeys.add(event.dedupeKey);
  try {
    const ledger = await getLedger();
    if (ledger.fired[event.dedupeKey] !== undefined) return true;
    const delivered = await showNotification(event);
    if (!delivered) return false;
    await setLedger(rememberNotification(ledger, event.dedupeKey, Date.now()));
    return true;
  } finally {
    firingKeys.delete(event.dedupeKey);
  }
}

async function clearAlarm(kind: NotificationKind): Promise<void> {
  try {
    await Promise.resolve(api.alarms.clear(NOTIFICATION_ALARM_NAMES[kind]));
  } catch {
    // Alarms can be unavailable in a torn-down worker; the next start retries.
  }
}

async function armAlarm(kind: NotificationKind, when: number): Promise<void> {
  try {
    await Promise.resolve(
      api.alarms.create(NOTIFICATION_ALARM_NAMES[kind], { when }),
    );
  } catch {
    // A missed alarm is promptness-only; state reconciliation on the next
    // wake will re-arm it or deliver an overdue reminder then.
  }
}

/** Remove alarm names under our prefix that an older build (or a rename)
 *  left behind. Other features' alarms are never touched. */
async function cleanupStaleAlarms(): Promise<void> {
  try {
    const alarms = await api.alarms.getAll();
    for (const alarm of alarms) {
      if (isNotificationAlarm(alarm.name) && !isAllowlistedNotificationAlarm(alarm.name)) {
        await Promise.resolve(api.alarms.clear(alarm.name));
      }
    }
  } catch {
    // getAll/clear are unavailable in some teardown races; harmless.
  }
}

/** One reconcile: re-derive, clean, fire due candidates, and arm the next
 *  one-shot alarm per kind. A second pass is often needed because firing a
 *  schedule-start reminder exposes the FOLLOWING start as the next candidate;
 *  the pass cap is a hostile-state guard, not an expected path. */
async function reconcile(): Promise<void> {
  await cleanupStaleAlarms();
  for (let pass = 0; pass < 4; pass++) {
    const [settings, lockState, allowanceState, ledger] = await Promise.all([
      getSettings(),
      getLockState(),
      readAllowanceState(),
      getLedger(),
    ]);
    const now = Date.now();
    const plan = planNotifications({
      prefs: settings.notificationPrefs,
      lockState,
      allowanceState,
      firedKeys: Object.keys(ledger.fired),
      now,
    });
    let firedAny = false;
    for (const kind of NOTIFICATION_KINDS) {
      const event = plan.alarms.find((candidate) => candidate.kind === kind);
      if (!event) {
        await clearAlarm(kind);
        continue;
      }
      if (event.fireAt <= now) {
        const delivered = await fire(event);
        if (delivered) {
          firedAny = true;
        } else {
          // API refused/failed. Keep the alarm cleared for this reconcile and
          // let the next storage change or SW start try again; never spin.
          await clearAlarm(kind);
        }
      } else {
        await armAlarm(kind, event.fireAt);
      }
    }
    if (!firedAny) return;
  }
}

/** MV3 constraint #4: register every listener synchronously at SW startup. */
export function initNotificationScheduler(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (!isNotificationAlarm(alarm.name)) return;
    if (!isAllowlistedNotificationAlarm(alarm.name)) {
      // A renamed/older reminder alarm. Clear it instead of waking forever.
      void Promise.resolve(api.alarms.clear(alarm.name)).catch(() => {});
      return;
    }
    enqueue(reconcile);
  });

  // A settings/lock/allowance write is the main reconciliation trigger:
  // toggles, schedule edits, break start/cancel/end, allowance grants.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes['settings'] && !changes['lockState'] && !changes['allowanceAuthority']) {
      return;
    }
    enqueue(reconcile);
  });

  // Our own ledger writes invalidate the cache but must not trigger another
  // reconcile (that would be a harmless loop, but a noisy one).
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LEDGER_KEY]) ledgerCache = null;
  });

  // A cold browser start is also a fresh chance to deliver an overdue
  // reminder ("missed-while-asleep") and to schedule the next one.
  api.runtime.onStartup.addListener(() => enqueue(reconcile));

  // SW (re)start: rebuild alarms from stored state. A missed alarm never
  // changes correctness — only whether the toast appeared.
  enqueue(reconcile);
}
