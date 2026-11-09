import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { getSettings, setSettings, type Settings } from '../shared/settings';
import { getProfilesState } from '../shared/profile-store';
import { PROFILES_STORAGE_KEY, type ProfilesState } from '../shared/profiles';
import { getLockState, getLockStatus } from '../shared/lock';
import { EMPTY_LOCK_STATE, type LockState, type LockStatus } from '../shared/lock-math';
import type { CompanionStatusResponse } from '../shared/messages';
import type { CompanionSnapshot } from '../shared/companion-protocol';
import {
  commitFocusSessionIfDue,
  getPendingFocusSession,
  type PendingFocusSession,
} from '../shared/focus-session';
import { lockBannerText, lockReasonText, lockShortText } from './format';

// The options page's single source of state: settings, lock state, the
// pending focus session, companion status and the global "Saved" message.
// Every page reads from here; storage.onChanged keeps it in sync with the
// popup, the background and other options tabs.

export type SettingsPatch = Partial<Settings>;

export interface LockInfo {
  status: LockStatus;
  locked: boolean;
  passwordArmed: boolean;
  /** "Locked: focus session — unlocks in 3h 12m (3:40 PM)". */
  banner: string;
  /** "Locked · 3h 12m" (header pill). */
  short: string;
  /** "Locked until 3:40 PM" (next to disabled controls). */
  reason: string;
}

export interface SaveStatus {
  text: string;
  error: boolean;
  visible: boolean;
}

export interface ModelProgress {
  text: string;
  visible: boolean;
}

const UNLOCKED: LockStatus = {
  breakActive: false,
  breakStartedAt: null,
  breakNotBefore: null,
  breakEndsAt: null,
  settingsLocked: false,
  forceBlocking: false,
  reasons: [],
  until: null,
};

export interface OptionsState {
  settings: Settings | null;
  profiles: ProfilesState | null;
  lock: LockInfo;
  /** Full persisted lock state (schedules, category schedules, gates). */
  lockState: LockState;
  refreshLock: () => Promise<void>;
  /** Reload profiles + effective settings after a profile mutation. */
  refreshProfiles: () => Promise<void>;
  /** Persist a patch (optimistic). Resolves false when the write was refused. */
  save: (patch: SettingsPatch) => Promise<boolean>;
  saveStatus: SaveStatus;
  /** Show a message in the global status slot (e.g. schedule/lock results). */
  flash: (text: string, error?: boolean) => void;
  pendingFocus: PendingFocusSession | null;
  refreshPendingFocus: () => Promise<void>;
  companion: CompanionSnapshot | null;
  incognitoAllowed: boolean;
  modelProgress: ModelProgress;
  /** Ticks every second — use for countdowns. */
  now: number;
}

export function useOptionsState(): OptionsState {
  const [settings, setLocalSettings] = useState<Settings | null>(null);
  const [profiles, setProfiles] = useState<ProfilesState | null>(null);
  const [lockStatus, setLockStatus] = useState<LockStatus>(UNLOCKED);
  const [lockState, setLockState] = useState<LockState>(EMPTY_LOCK_STATE);
  const [passwordArmed, setPasswordArmed] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<PendingFocusSession | null>(null);
  const [companion, setCompanion] = useState<CompanionSnapshot | null>(null);
  // True until loaded so we never flash a false incognito warning.
  const [incognitoAllowed, setIncognitoAllowed] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ text: 'Saved', error: false, visible: false });
  const [modelProgress, setModelProgress] = useState<ModelProgress>({ text: '', visible: false });
  const [now, setNow] = useState(() => Date.now());

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const modelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flash = useCallback((text: string, error = false) => {
    setSaveStatus({ text, error, visible: true });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => setSaveStatus((s) => ({ ...s, visible: false })),
      error ? 5000 : 2000,
    );
  }, []);

  const refreshLock = useCallback(async () => {
    const [status, state] = await Promise.all([getLockStatus(), getLockState()]);
    setLockStatus(status);
    setLockState(state);
    setPasswordArmed(Boolean(state.passwordHash));
  }, []);

  const refreshPendingFocus = useCallback(async () => {
    setPendingFocus(await getPendingFocusSession());
  }, []);

  const reloadSettings = useCallback(async () => {
    setLocalSettings(await getSettings());
  }, []);

  // Profile activation/edits change the effective policy, so reload both in
  // one pass. storage.onChanged normally drives this; this callback also
  // makes a just-finished profile action deterministic for the page that
  // initiated it.
  const refreshProfiles = useCallback(async () => {
    setProfiles(await getProfilesState());
    setLocalSettings(await getSettings());
  }, []);

  const save = useCallback(
    async (patch: SettingsPatch) => {
      // Optimistic: reflect the change immediately, roll back on refusal.
      setLocalSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        const next = await setSettings(patch);
        setLocalSettings(next);
        flash('Saved');
        return true;
      } catch {
        await reloadSettings();
        const status = await getLockStatus();
        flash(
          status.settingsLocked
            ? `Couldn't save — ${lockReasonText(status).replace(/^L/, 'l')}`
            : "Couldn't save — try again",
          true,
        );
        return false;
      }
    },
    [flash, reloadSettings],
  );

  useEffect(() => {
    const refreshCompanion = async () => {
      try {
        const resp = (await api.runtime.sendMessage({
          type: 'GET_COMPANION_STATUS',
        })) as CompanionStatusResponse;
        if (resp?.ok) {
          setIncognitoAllowed(resp.incognitoAllowed ?? true);
          if (resp.snapshot) setCompanion(resp.snapshot);
        }
      } catch {
        // Background unreachable during SW restart.
      }
    };

    void refreshProfiles();
    void refreshLock();
    void refreshPendingFocus();
    void refreshCompanion();

    const tick = setInterval(() => {
      setNow(Date.now());
      void refreshLock();
      // Any surface that notices a due focus session may commit it
      // (idempotent — the background alarm races this safely).
      void getPendingFocusSession().then(async (p) => {
        if (p && Date.now() >= p.commitAt) {
          await commitFocusSessionIfDue();
          void refreshLock();
        }
        setPendingFocus(await getPendingFocusSession());
      });
    }, 1000);
    const companionTick = setInterval(() => void refreshCompanion(), 5000);

    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes['lockState']) void refreshLock();
      if (changes['pendingFocusSession']) void refreshPendingFocus();
      if (changes['settings']) void reloadSettings();
      // Named-profile edits change the effective policy even when the Default
      // `settings` object itself did not move.
      if (changes[PROFILES_STORAGE_KEY]) void refreshProfiles();
      // The background clears grace on relay loss and publishes recovery.
      // Mirror those transitions immediately; the 5s poll is only a fallback.
      if (changes['companionSnapshot']) void refreshCompanion();
    };
    api.storage.onChanged.addListener(onStorageChanged);

    const onRuntimeMessage = (message: { type?: string; status?: string; progress?: number }) => {
      if (message?.type !== 'MODEL_PROGRESS') return;
      if (modelTimer.current) clearTimeout(modelTimer.current);
      if (message.status === 'init' || message.status === 'ready') {
        setModelProgress({ text: 'Preparing the on-device model…', visible: true });
      } else if (message.status === 'progress' && message.progress != null) {
        setModelProgress({
          text: `Downloading the on-device model: ${message.progress.toFixed(0)}%`,
          visible: true,
        });
      } else if (message.status === 'done') {
        setModelProgress({ text: 'Model ready', visible: true });
        modelTimer.current = setTimeout(() => setModelProgress((m) => ({ ...m, visible: false })), 5000);
      }
    };
    api.runtime.onMessage.addListener(onRuntimeMessage);

    return () => {
      clearInterval(tick);
      clearInterval(companionTick);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (modelTimer.current) clearTimeout(modelTimer.current);
      api.storage.onChanged.removeListener(onStorageChanged);
      api.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, [refreshLock, refreshPendingFocus, reloadSettings, refreshProfiles]);

  const locked = lockStatus.settingsLocked;
  const lock: LockInfo = {
    status: lockStatus,
    locked,
    passwordArmed,
    banner: locked ? lockBannerText(lockStatus, settings?.hour24) : '',
    short: locked ? lockShortText(lockStatus) : '',
    reason: locked ? lockReasonText(lockStatus, settings?.hour24) : '',
  };

  return {
    settings,
    profiles,
    lock,
    lockState,
    refreshLock,
    refreshProfiles,
    save,
    saveStatus,
    flash,
    pendingFocus,
    refreshPendingFocus,
    companion,
    incognitoAllowed,
    modelProgress,
    now,
  };
}
