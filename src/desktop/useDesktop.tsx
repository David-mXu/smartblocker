import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { errorText, invoke, type ActivityEvent, type DesktopStatus } from './api';

// One store for the whole window: get_status polled every 2s (spec), the
// activity tail every 5s, and a 1s clock for countdowns. Pages read it via
// useDesktop() and call refresh() after any command so the UI never waits a
// full poll interval to show the result of the user's own click.

const STATUS_POLL_MS = 2_000;
const ACTIVITY_POLL_MS = 5_000;
export const ACTIVITY_LIMIT = 200;

export interface DesktopStore {
  status: DesktopStatus | null;
  /** Last get_status failure (the shell itself is unreachable). */
  statusError: string | null;
  activity: ActivityEvent[] | null;
  /** Ticks every second — use for countdowns instead of Date.now(). */
  now: number;
  refresh: () => Promise<void>;
  refreshActivity: () => Promise<void>;
}

const Ctx = createContext<DesktopStore | null>(null);

export function DesktopProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke('get_status');
      if (!alive.current) return;
      setStatus(s);
      setStatusError(null);
      setNow(Date.now());
    } catch (e) {
      if (alive.current) setStatusError(errorText(e));
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const events = await invoke('get_recent_activity', { limit: ACTIVITY_LIMIT });
      if (alive.current) setActivity(events);
    } catch {
      if (alive.current) setActivity((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    void refreshActivity();
    const s = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    const a = window.setInterval(() => void refreshActivity(), ACTIVITY_POLL_MS);
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive.current = false;
      window.clearInterval(s);
      window.clearInterval(a);
      window.clearInterval(t);
    };
  }, [refresh, refreshActivity]);

  // A pending session reaching its commit time: re-read right away instead of
  // showing "Locks in 0:00" until the next poll.
  const commitAt = status?.pendingSession?.commitAtMs ?? null;
  useEffect(() => {
    if (commitAt === null) return;
    const wait = Math.max(0, commitAt - Date.now()) + 150;
    const id = window.setTimeout(() => void refresh(), wait);
    return () => window.clearTimeout(id);
  }, [commitAt, refresh]);

  return (
    <Ctx.Provider value={{ status, statusError, activity, now, refresh, refreshActivity }}>{children}</Ctx.Provider>
  );
}

export function useDesktop(): DesktopStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDesktop outside DesktopProvider');
  return v;
}

/** Status that is guaranteed loaded (pages render only after the first read). */
export function useStatus(): DesktopStore & { status: DesktopStatus } {
  const store = useDesktop();
  if (!store.status) throw new Error('status not loaded');
  return store as DesktopStore & { status: DesktopStatus };
}
