import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import { DEFAULT_ALLOWANCE_CONFIG, deriveAllowance, type AllowanceConfig } from '../../shared/allowance-math';
import { allowanceLocalDayKey } from '../../shared/allowance-store';
import type { AllowanceAuthorityState, AllowanceCommand } from '../../shared/allowance-state';
import type { AllowanceResponse, RewardStatusResponse } from '../../shared/messages';
import type { RewardAccrualStatus } from '../../shared/reward-accrual';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { LockedNote, Page } from './Page';
import { FocusCycleSection } from './FocusCycleSection';
import type { OptionsState } from '../useOptionsState';

const MINUTE = 60_000;
const emptyAuthority: AllowanceAuthorityState = { version: 1, revision: 0, categories: {}, receipts: [] };
const id = () => crypto.randomUUID().replaceAll('-', '');
const minutes = (ms: number) => Math.floor(ms / MINUTE).toLocaleString();
const rewardReasonText: Record<RewardAccrualStatus['reason'], string> = {
  earning: 'Earning now from the focused productive page.',
  disabled: 'Paused — SmartBlocker is disabled.',
  'not-locked': 'Paused — start a lock or focus session to earn.',
  break: 'Paused — an explicit break is active.',
  'focus-cycle': 'Paused — a focus/Pomodoro program already awards its completed work.',
  idle: 'Paused — you appear idle.',
  unfocused: 'Paused — no focused browser window.',
  'not-productive': 'Paused — the current page has no confident productive classifier verdict.',
  relief: 'Paused — the current page is an allowance or break relief page.',
  unconfigured: 'Enable earning and save a category configuration.',
  'cap-reached': 'Daily reward cap reached for every earning category.',
  unavailable: 'Paused — browser focus/idle evidence is unavailable.',
  unknown: 'Waiting for the first activity checkpoint.',
};
function NumberField({ id, label, value, onChange, disabled, max = 1440 }: {
  id: string; label: string; value: number; onChange: (value: number) => void;
  disabled: boolean; max?: number;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="min-w-28">{label}</span>
      <Input
        id={id} type="number" min={0} max={max} step={1} value={value}
        disabled={disabled} className="w-24 tabular-nums"
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </label>
  );
}

export function AllowancePage({ state }: { state: OptionsState }) {
  const [authority, setAuthority] = useState<AllowanceAuthorityState>(emptyAuthority);
  const [source, setSource] = useState<AllowanceResponse['source']>();
  const [rewardStatus, setRewardStatus] = useState<RewardAccrualStatus | null>(null);
  const [category, setCategory] = useState('');
  const [config, setConfig] = useState<AllowanceConfig>(DEFAULT_ALLOWANCE_CONFIG);
  const [configDirty, setConfigDirty] = useState(false);
  const loadedConfigCategory = useRef('');
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const labels = state.settings?.labels ?? [];

  useEffect(() => {
    if (!category && labels.length > 0) setCategory(labels[0]);
    if (category && !labels.includes(category)) setCategory(labels[0] ?? '');
  }, [category, labels]);

  const load = useCallback(async () => {
    const response = (await api.runtime.sendMessage({ type: 'GET_ALLOWANCE_AUTHORITY' })) as AllowanceResponse;
    if (!response.ok || !response.state) throw new Error(response.error ?? 'Could not load allowance state.');
    setAuthority(response.state);
    setSource(response.source);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage(String(error)));
    const timer = setInterval(() => void load().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = (await api.runtime.sendMessage({
          type: 'GET_REWARD_STATUS',
        })) as RewardStatusResponse;
        if (response.ok && response.status) setRewardStatus(response.status);
      } catch {
        /* a status refresh must never replace a command result */
      }
    };
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!category) return;
    const stored = authority.categories[category]?.config;
    if (loadedConfigCategory.current !== category) {
      // Wait for the first authority read before offering defaults, then load
      // once per selected category.
      if (!stored && !loaded) return;
      loadedConfigCategory.current = category;
      setConfigDirty(false);
      setConfig(stored ?? DEFAULT_ALLOWANCE_CONFIG);
      return;
    }
    // The one-second authority poll must not erase unsaved edits; once the
    // user changes a field, only Save (or a category switch) replaces them.
    if (!configDirty && stored) setConfig(stored);
  }, [authority, category, loaded, configDirty]);

  const nowMs = Date.now();
  const observation = { nowMs, dayKey: allowanceLocalDayKey(new Date(nowMs)) };
  const current = authority.categories[category];
  const derived = current
    ? deriveAllowance(current.ledger, current.config, observation)
    : null;
  const liveGrant = derived?.grant &&
    !['ended', 'idle-closed'].includes(derived.grant.status)
    ? derived.grant
    : null;
  const rewardProgress = rewardStatus?.progress.find((entry) => entry.category === category);
  const rewardWorkMs = rewardProgress?.workMs ?? config.rewardWorkMs ?? 5 * MINUTE;
  const rewardAwardMs = rewardProgress?.awardMs ?? config.rewardAwardMs ?? MINUTE;
  const rewardProgressMs = rewardProgress?.progressMs ?? 0;
  const rewardPercent = rewardWorkMs > 0
    ? Math.min(100, Math.max(0, (rewardProgressMs / rewardWorkMs) * 100))
    : 0;

  const execute = async (command: AllowanceCommand, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      const response = (await api.runtime.sendMessage({ type: 'ALLOWANCE_COMMAND', command })) as AllowanceResponse;
      if (!response.state) throw new Error(response.error ?? response.reason ?? 'Command failed.');
      setAuthority(response.state);
      setSource(response.source);
      if (!response.ok) throw new Error(response.reason ?? 'Command refused.');
      if (command.kind === 'configure') {
        const savedConfig = response.state.categories[command.category]?.config;
        if (savedConfig) setConfig(savedConfig);
        setConfigDirty(false);
      }
      setMessage(response.duplicate ? 'Command was already applied.' : success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const action = (kind: AllowanceCommand['kind'], grantId = id(), durationMs?: number) => ({
    kind,
    operationId: id(),
    category,
    grantId,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...observation,
  }) as AllowanceCommand;
  const configure = () => execute({
    kind: 'configure', operationId: id(), category, config,
  }, 'Category relief settings saved.');
  const field = (key: keyof typeof config, value: number) => {
    setConfigDirty(true);
    setConfig((previous) => ({ ...previous, [key]: value }));
  };
  const disabled = !loaded || busy || !category;

  return (
    <Page
      title="Breaks & allowance"
      description="Relief is separate from lock deadlines and deterministic rules. Allowance consumes daily minutes while its clock runs; limited openings close after inactivity; Pomodoro relief is a separate free fixed interval."
    >
      <SettingsSection
        title="Category relief"
        description={source === 'daemon'
          ? 'Powered by the desktop daemon’s shared per-category pools.'
          : source === 'pending'
            ? 'Establishing the desktop authority. Commands wait for initialization before use.'
            : 'Extension-only fallback. Pools are local to this browser profile, not synchronized by the desktop daemon.'}
        aside={<Badge variant={source === 'daemon' ? 'success' : 'outline'}>
          {source === 'daemon' ? 'Daemon authority' : source === 'pending' ? 'Initializing' : 'Browser-only'}
        </Badge>}
      >
        {state.lock.locked && <LockedNote reason="Relief configuration cannot change during a lock. Grant usage never shortens the lock." className="px-1" />}
        <SettingsGroup>
          <SettingRow label="Category" description="Each category has independent daily minutes, openings, rewards, and waiting escalation.">
            <select
              id="allowance-category" value={category}
              disabled={disabled}
              onChange={(event) => setCategory(event.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
            >
              {labels.map((label) => <option key={label} value={label}>{label}</option>)}
            </select>
          </SettingRow>
          <div className="flex flex-wrap gap-x-5 gap-y-3 px-4 py-4">
            <NumberField id="allowance-minutes" label="Daily minutes" max={1440} disabled={disabled || state.lock.locked}
              value={Math.floor(config.dailyAllowanceMs / MINUTE)} onChange={(v) => field('dailyAllowanceMs', v * MINUTE)} />
            <NumberField id="allowance-openings" label="Daily openings" max={10000} disabled={disabled || state.lock.locked}
              value={config.dailyOpenings} onChange={(v) => field('dailyOpenings', v)} />
            <NumberField id="allowance-reward-cap" label="Reward cap (min)" max={1440} disabled={disabled || state.lock.locked}
              value={Math.floor(config.rewardCapMs / MINUTE)} onChange={(v) => field('rewardCapMs', v * MINUTE)} />
            <NumberField id="allowance-wait-base" label="Wait base (sec)" max={3600} disabled={disabled || state.lock.locked}
              value={Math.floor(config.waitingBaseMs / 1000)} onChange={(v) => field('waitingBaseMs', v * 1000)} />
            <NumberField id="allowance-wait-step" label="Wait step (sec)" max={3600} disabled={disabled || state.lock.locked}
              value={Math.floor(config.waitingStepMs / 1000)} onChange={(v) => field('waitingStepMs', v * 1000)} />
            <NumberField id="allowance-wait-max" label="Wait cap (sec)" max={3600} disabled={disabled || state.lock.locked}
              value={Math.floor(config.waitingMaxMs / 1000)} onChange={(v) => field('waitingMaxMs', v * 1000)} />
            <NumberField id="opening-idle" label="Idle close (sec)" max={3600} disabled={disabled || state.lock.locked}
              value={Math.floor((config.openingInactivityMs ?? 120_000) / 1000)} onChange={(v) => field('openingInactivityMs', v * 1000)} />
            <NumberField id="opening-lifetime" label="Maximum opening (min)" max={1440} disabled={disabled || state.lock.locked}
              value={Math.floor((config.openingMaxLifetimeMs ?? 1_800_000) / MINUTE)} onChange={(v) => field('openingMaxLifetimeMs', v * MINUTE)} />
          </div>
          <SettingRow
            label="Earn reward from productive work"
            description="Opt-in. While SmartBlocker is enabled and a lock/focus session is active, focused non-idle time on a confidently productive classifier verdict adds work toward this category's reward pool. Whitelisted pages (no classifier verdict), overridden/relieved pages, breaks, and blocked or fail-closed pages do not earn. Each completed unit is credited through the authoritative allowance command path, up to the reward cap."
          >
            <Switch
              id="reward-earning"
              checked={config.rewardEarning === true}
              disabled={disabled || state.lock.locked}
              onChange={(event) => {
                setConfigDirty(true);
                setConfig((previous) => ({ ...previous, rewardEarning: event.target.checked }));
              }}
            />
          </SettingRow>
          {config.rewardEarning === true && (
            <div className="flex flex-wrap gap-x-5 gap-y-3 px-4 py-4">
              <NumberField id="reward-work-minutes" label="Work per unit (min)" max={1440} disabled={disabled || state.lock.locked}
                value={Math.max(1, Math.floor((config.rewardWorkMs ?? 5 * MINUTE) / MINUTE))}
                onChange={(v) => field('rewardWorkMs', Math.max(1, v) * MINUTE)} />
              <NumberField id="reward-award-minutes" label="Reward per unit (min)" max={1440} disabled={disabled || state.lock.locked}
                value={Math.max(1, Math.floor((config.rewardAwardMs ?? MINUTE) / MINUTE))}
                onChange={(v) => field('rewardAwardMs', Math.max(1, v) * MINUTE)} />
            </div>
          )}
          <SettingRow label="Apply configuration" description="Changes reset at local midnight, not mid-day. They never edit a running lock.">
            <Button id="allowance-save" disabled={disabled || state.lock.locked} onClick={() => void configure()}>Save settings</Button>
          </SettingRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Productive-work reward"
        description="Live status for the selected category. Work is counted in bounded local checkpoints and only while the conditions above hold."
        aside={<Badge variant={rewardStatus?.earning ? 'success' : 'outline'} id="reward-status-badge">
          {rewardStatus?.earning ? 'Earning now' : 'Paused'}
        </Badge>}
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-4">
            <p id="reward-status" role="status" className="m-0 text-[13px] text-muted-foreground">
              {rewardStatus ? rewardReasonText[rewardStatus.reason] : 'Waiting for the first activity checkpoint.'}
            </p>
            <div className="flex items-baseline justify-between gap-4 text-[13px] text-muted-foreground">
              <span>
                Earned today <span className="tabular-nums text-foreground">{minutes(derived?.earnedRewardMs ?? 0)}</span> / {minutes(config.rewardCapMs)} min
              </span>
              <span id="reward-progress-label" className="tabular-nums">
                {Math.min(rewardWorkMs, rewardProgressMs) / MINUTE > 0
                  ? `${(Math.min(rewardWorkMs, rewardProgressMs) / MINUTE).toFixed(1)} / ${(rewardWorkMs / MINUTE).toFixed(0)} min`
                  : `0 / ${(rewardWorkMs / MINUTE).toFixed(0)} min`}
                {' → '}{minutes(rewardAwardMs)} min
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
              <div
                id="reward-progress-bar"
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${rewardPercent}%` }}
              />
            </div>
            {rewardProgress?.pending && (
              <p className="m-0 text-xs text-faint">An earned award is awaiting authoritative acknowledgement; retries reuse the exact command.</p>
            )}
            <p className="m-0 text-xs text-faint">
              The reward balance is always authoritative (desktop daemon or this browser profile's fallback). Restarts and stale gaps are undercounted, never invented.
            </p>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Current pool"
        description={derived
          ? `${minutes(derived.remainingMs)} min remaining · ${minutes(derived.reservedMs)} min reserved · ${derived.openingsRemaining} openings left · next wait ${Math.ceil(derived.nextWaitingDelayMs / 1000)}s · reward ${minutes(derived.earnedRewardMs)} min`
          : 'Save a configuration before using relief.'}
      >
        <SettingsGroup>
          <SettingRow label="Relief duration" description="Requested minutes are capped to the unreserved pool. Waiting time is not charged.">
            <Input id="relief-duration" type="number" min={1} max={1440} value={durationMinutes}
              disabled={disabled || Boolean(liveGrant)} className="w-24"
              onChange={(event) => setDurationMinutes(event.target.valueAsNumber)} />
          </SettingRow>
          <div className="flex flex-wrap gap-2 px-4 py-4">
            <Button disabled={disabled || Boolean(liveGrant)} onClick={() => void execute(action('request', id(), Math.max(1, durationMinutes) * MINUTE), 'Allowance requested.')}>
              <Play className="size-3.5" />Use allowance
            </Button>
            <Button variant="secondary" disabled={disabled || Boolean(liveGrant)} onClick={() => void execute(action('opening-start'), 'Limited opening started.')}>
              <Play className="size-3.5" />Open a session
            </Button>
            <Button variant="outline" disabled={disabled || Boolean(liveGrant)} onClick={() => void execute(action('pomodoro-start', id(), 5 * MINUTE), 'Pomodoro relief started.')}>
              <Play className="size-3.5" />Pomodoro break (5 min)
            </Button>
            {liveGrant?.kind === 'allowance' && (
              <Button variant="secondary" disabled={disabled} onClick={() => void execute(action('cancel', liveGrant.id), 'Allowance ended; unused time was refunded.')}>
                <Square className="size-3.5" />End allowance
              </Button>
            )}
            {liveGrant?.kind === 'opening' && (
              <Button variant="secondary" disabled={disabled} onClick={() => void execute(action('opening-close', liveGrant.id), 'Opening closed.')}>
                <Square className="size-3.5" />Close opening
              </Button>
            )}
          </div>
          {liveGrant && (
            <p className="m-0 px-4 pb-4 text-xs text-muted-foreground">
              {liveGrant.kind} {liveGrant.status} · ends {new Date(liveGrant.endsAtMs).toLocaleTimeString()}
              {liveGrant.kind === 'allowance' ? ' · wall-clock time, including idle' : ''}
            </p>
          )}
        </SettingsGroup>
        <p id="allowance-msg" role="status" className="m-0 px-1 text-xs text-muted-foreground">{message}</p>
        <p className="m-0 px-1 text-xs text-faint">Revision {authority.revision} · reset at local midnight · deterministic rules and classifier-unavailable fail-closed screens are never relaxed.</p>
      </SettingsSection>
      <FocusCycleSection category={category} />
    </Page>
  );
}
