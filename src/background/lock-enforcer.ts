// Background wiring for the lock system. The alarm here is PROMPTNESS-only:
// every enforcement path (setSettings guard, blocker gates, options/popup UI)
// re-derives activeness from Date.now() vs stored timestamps, so a missed or
// late alarm can never extend or weaken a lock. What the alarm buys us is
// sweeping already-open tabs the moment a blocking window starts, instead of
// waiting for the next navigation.
import { api } from '../shared/api';
import { getLockState, getLockStatus } from '../shared/lock';
import { nextBoundary } from '../shared/lock-math';
import { sweepOpenTabs } from './blocker';

const ALARM_NAME = 'lock-boundary';

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
  if ((await getLockStatus()).forceBlocking) await sweepOpenTabs();
  await syncAlarm();
}

/** MV3: called synchronously from index.ts startup. */
export function initLockEnforcer(): void {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void onBoundary().catch((e) => console.warn('[FlowGuard] lock boundary error:', e));
  });

  // A lockState write from the popup/options wakes the SW via this listener —
  // that's how "Frozen Turkey" started from the popup immediately blocks
  // already-open distracting tabs, with no explicit message needed.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lockState']) return;
    void (async () => {
      await syncAlarm();
      if ((await getLockStatus()).forceBlocking) await sweepOpenTabs();
    })().catch((e) => console.warn('[FlowGuard] lock change handling error:', e));
  });

  // SW (re)start: cover "a schedule window began while the browser was closed".
  void (async () => {
    await syncAlarm();
    if ((await getLockStatus()).forceBlocking) await sweepOpenTabs();
  })().catch((e) => console.warn('[FlowGuard] lock init error:', e));
}
