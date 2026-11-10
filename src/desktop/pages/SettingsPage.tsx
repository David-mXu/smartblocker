import React, { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Callout, SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { Switch } from '../../components/ui/switch';
import { errorText, invoke, type LicenseInfo } from '../api';
import { formatEndTime, formatTime, lockedUntilText } from '../format';
import { DurationPicker, resolveMinutes, type DurationValue, type Preset } from '../components/DurationPicker';
import { FormMessage, LockedNote, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

export function SettingsPage() {
  return (
    <Page title="Settings">
      <LockSection />
      <LicenseSection />
      <ConnectionSection />
      <GraceSection />
      <AboutSection />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Lock settings for a time (timer lock)
// ---------------------------------------------------------------------------

const LOCK_PRESETS: Preset[] = [
  { mins: 30, label: '30m', name: '30 minutes' },
  { mins: 60, label: '1h', name: '1 hour' },
  { mins: 240, label: '4h', name: '4 hours' },
];

function LockSection() {
  const { status, now, refresh } = useStatus();
  const [value, setValue] = useState<DurationValue>({ choice: 60, customHours: '8', customMinutes: '0' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const resolved = resolveMinutes(value);
  const end = 'minutes' in resolved ? now + resolved.minutes * 60_000 : null;
  const locked = status.lock.settingsLocked;
  const daemonDown = !status.daemon.running;
  // Monotonic: a shorter lock than the current one changes nothing.
  const wouldExtend = end !== null && (status.lock.until === null || end > status.lock.until);

  const lock = async () => {
    if (!('minutes' in resolved)) return;
    setBusy(true);
    setMsg(null);
    try {
      await invoke('start_timer_lock', { minutes: resolved.minutes });
      setConfirming(false);
      setMsg({ tone: 'ok', text: `Settings locked until ${formatEndTime(now + resolved.minutes * 60_000, now)}.` });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection
      id="lock-settings"
      title="Lock settings for a while"
      description="Until it ends, you can add blocked apps but not remove them, and blocked apps and unprotected browsers are closed."
    >
      <SettingsGroup>
        <div className="flex flex-col gap-4 px-4 py-4">
          <DurationPicker
            idPrefix="lock"
            label="Lock length"
            presets={LOCK_PRESETS}
            value={value}
            onChange={(v) => {
              setValue(v);
              setConfirming(false);
            }}
            disabled={busy}
          />
          {confirming && end !== null ? (
            <Callout tone="commit" id="lock-confirm" className="flex flex-col gap-3">
              <p className="m-0 tabular-nums">
                Lock settings until <strong className="font-semibold">{formatEndTime(end, now)}</strong>? It can’t be
                shortened or cancelled once it starts.
              </p>
              <div className="flex items-center gap-2">
                <Button id="lock-confirm-btn" variant="commit" size="sm" onClick={lock} disabled={busy}>
                  Lock until {formatEndTime(end, now)}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </Callout>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                id="lock-timer-btn"
                variant="outline"
                onClick={() => setConfirming(true)}
                disabled={busy || daemonDown || !('minutes' in resolved) || !wouldExtend}
              >
                {locked ? 'Extend lock…' : 'Lock settings…'}
              </Button>
              <p className="m-0 min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">
                {daemonDown
                  ? 'The companion isn’t running, so settings can’t be locked.'
                  : 'error' in resolved
                    ? resolved.error
                    : !wouldExtend
                      ? `Already locked past ${formatEndTime(end!, now)} — choose a longer time to extend.`
                      : `Until ${formatEndTime(end!, now)}. You’ll confirm first.`}
              </p>
            </div>
          )}
        </div>
      </SettingsGroup>
      <FormMessage message={msg} className="px-1" />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Pro license
// ---------------------------------------------------------------------------

function licenseSummary(l: LicenseInfo, now: number): { badge: React.ReactNode; text: string } {
  const date = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  switch (l.state) {
    case 'valid':
      return {
        badge: (
          <Badge variant="success" dot>
            Pro
          </Badge>
        ),
        text: l.expiresAtMs ? `Active until ${date(l.expiresAtMs)}` : 'Active, never expires',
      };
    case 'grace':
      return {
        badge: (
          <Badge variant="warning" dot>
            Pro, expired
          </Badge>
        ),
        text: `Expired ${l.expiresAtMs ? date(l.expiresAtMs) : ''} — Pro keeps working for a few more days. Paste a renewed key to continue.`,
      };
    case 'expired':
      return {
        badge: (
          <Badge variant="warning" dot>
            Expired
          </Badge>
        ),
        text: `Expired ${l.expiresAtMs ? date(l.expiresAtMs) : ''}. Paste a renewed key to turn Pro back on.`,
      };
    case 'invalid':
      return {
        badge: (
          <Badge variant="destructive" dot>
            Invalid key
          </Badge>
        ),
        text: 'The saved key isn’t valid. Paste your key again.',
      };
    case 'dev-open':
      return { badge: <Badge dot>Developer mode</Badge>, text: 'All Pro features are on for development.' };
    case 'none':
    default:
      void now;
      return { badge: <Badge dot>Free</Badge>, text: 'No Pro key on this computer. If you bought Pro, paste your key below.' };
  }
}

function LicenseSection() {
  const { status, now, refresh } = useStatus();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const l = status.license;
  const summary = licenseSummary(l, now);
  const locked = status.lock.settingsLocked;
  // Rust refuses changing or removing an existing key mid-lock; adding a first key is fine.
  const keyFrozen = locked && l.keyHint !== null;

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const info = await invoke('set_license_key', { key: key.trim() });
      setKey('');
      setMsg({ tone: 'ok', text: info.pro ? 'Key verified — Pro is on.' : 'Key saved.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const clear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await invoke('set_license_key', { key: '' });
      setMsg({ tone: 'ok', text: 'Key removed.' });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection id="license" title="Pro license">
      <SettingsGroup>
        <SettingRow
          label="Plan"
          description={
            <span id="license-status" className="tabular-nums">
              {summary.text}
              {l.keyHint && (
                <>
                  {' '}
                  <span className="font-mono text-xs text-faint">Key {l.keyHint}</span>
                </>
              )}
            </span>
          }
          control={summary.badge}
        />
        <form className="flex flex-col gap-2 px-4 py-3.5" onSubmit={verify}>
          <label htmlFor="license-key" className="text-sm font-medium">
            {l.keyHint ? 'Replace your key' : 'License key'}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="license-key"
              value={key}
              disabled={keyFrozen}
              placeholder="SBPRO1.…"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[13px]"
              onChange={(e) => {
                setKey(e.target.value);
                if (msg?.tone === 'error') setMsg(null);
              }}
            />
            <Button id="license-verify" type="submit" disabled={busy || keyFrozen || !key.trim()} className="shrink-0">
              Verify key
            </Button>
          </div>
          {l.keyHint && (
            <div className="flex items-center justify-between gap-3 pt-1">
              {locked ? (
                <LockedNote>{lockedUntilText(status.lock, now)} — the key can’t be changed or removed</LockedNote>
              ) : (
                <span className="text-xs text-faint">Removing the key turns Pro features off on this computer.</span>
              )}
              <Button id="license-clear" variant="ghost" size="xs" onClick={clear} disabled={busy || locked}>
                Remove key
              </Button>
            </div>
          )}
        </form>
      </SettingsGroup>
      <FormMessage id="license-msg" message={msg} className="px-1" />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Browser connection + start with Windows
// ---------------------------------------------------------------------------

function ConnectionSection() {
  const { status, refresh } = useStatus();
  const [busy, setBusy] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const [autostartMsg, setAutostartMsg] = useState<Message>(null);

  const repair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const result = await invoke('install_integration');
      // Preserve the shell's per-browser and autostart outcomes verbatim;
      // never replace them with an all-browser success claim.
      setMsg({ tone: 'ok', text: result });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const setAutostart = async (enabled: boolean) => {
    setAutostartBusy(true);
    setAutostartMsg(null);
    try {
      const result = await invoke('set_autostart', { enabled });
      setAutostartMsg({
        tone: 'ok',
        text: result
          ? 'Start with Windows is on.'
          : 'Start with Windows is off. Repair still turns it on for detected browsers.',
      });
    } catch (e) {
      setAutostartMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setAutostartBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection title="Browser connection">
      <SettingsGroup>
        <SettingRow
          label="Repair browser connections"
          description="Repairs and verifies registration only for detected browsers, then enables startup. This does not install an extension or prove that one is connected."
          control={
            <Button id="settings-repair" variant="secondary" size="sm" onClick={repair} disabled={busy}>
              Repair
            </Button>
          }
        />
        <SettingRow
          label="Start with Windows"
          htmlFor="autostart-toggle"
          description={
            <span id="autostart-status">
              {status.testMode
                ? 'Unchanged — test mode does not inspect or modify startup settings'
                : status.autostart
                  ? 'On — starts when you sign in to Windows'
                  : 'Off — repairing a detected browser connection turns it on'}
            </span>
          }
          control={
            <Switch
              id="autostart-toggle"
              checked={!status.testMode && status.autostart}
              disabled={status.testMode || autostartBusy}
              aria-busy={autostartBusy}
              aria-describedby="autostart-status"
              onChange={(e) => void setAutostart(e.target.checked)}
            />
          }
        />
      </SettingsGroup>
      <FormMessage id="settings-repair-msg" message={msg} className="px-1" />
      <FormMessage id="autostart-msg" message={autostartMsg} className="px-1" />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Extension-loss grace
// ---------------------------------------------------------------------------

function GraceSection() {
  const { status, refresh } = useStatus();
  const [seconds, setSeconds] = useState(String(status.extensionLossGraceSeconds));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const min = status.extensionLossGraceMinSeconds;
  const max = status.extensionLossGraceMaxSeconds;

  // Follow daemon/store refreshes (the field is the same value this page
  // saves), without clobbering an in-progress edit.
  useEffect(() => {
    setSeconds(String(status.extensionLossGraceSeconds));
  }, [status.extensionLossGraceSeconds]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(seconds);
    if (seconds.trim() === '' || !Number.isSafeInteger(parsed)) {
      setMsg({ tone: 'error', text: 'Use a whole number of seconds.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const effective = await invoke('set_extension_loss_grace_seconds', { seconds: parsed });
      setSeconds(String(effective));
      setMsg({
        tone: 'ok',
        text:
          parsed === effective
            ? `Saved — the extension-loss grace is ${effective} seconds.`
            : `Saved — ${effective} seconds (allowed ${min}–${max}).`,
      });
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <SettingsSection
      title="Enforcement timing"
      description="How the companion treats a browser whose SmartBlocker extension stops responding during a lock."
    >
      <SettingsGroup>
        <SettingRow
          label="Extension-loss grace"
          htmlFor="extension-grace-seconds"
          description={
            <span id="extension-grace-status" className="tabular-nums">
              {status.extensionLossGraceSeconds} seconds between the warning and closing the browser. Allowed{' '}
              {min}–{max} whole seconds; the default is 60.
            </span>
          }
          control={
            <form className="flex items-center gap-2" noValidate onSubmit={save}>
              <Input
                id="extension-grace-seconds"
                type="number"
                min={min}
                max={max}
                step={1}
                inputMode="numeric"
                value={seconds}
                disabled={busy}
                aria-describedby="extension-grace-status"
                onChange={(e) => {
                  setSeconds(e.target.value);
                  if (msg?.tone === 'error') setMsg(null);
                }}
                className="w-20 tabular-nums"
              />
              <Button id="extension-grace-save" type="submit" variant="secondary" size="sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </form>
          }
        />
      </SettingsGroup>
      <FormMessage id="extension-grace-msg" message={msg} className="px-1" />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection() {
  const { status } = useStatus();
  const d = status.daemon;
  return (
    <SettingsSection title="About">
      <SettingsGroup>
        {status.testMode && (
          <SettingRow
            label="Test mode"
            description="Nothing is closed and nothing is registered with your browsers or Windows. Data is kept in a separate folder."
            control={
              <Badge variant="warning" dot>
                Test mode
              </Badge>
            }
          />
        )}
        <SettingRow
          label="Companion"
          description={
            <span className="tabular-nums">
              {d.running
                ? `Running${d.startedAtMs ? ` since ${formatTime(d.startedAtMs)}` : ''}${d.pid ? ` · process ${d.pid}` : ''}`
                : 'Not running'}
            </span>
          }
          control={
            d.running ? (
              <Badge variant="success" dot>
                Running
              </Badge>
            ) : (
              <Badge variant="warning" dot>
                Stopped
              </Badge>
            )
          }
        />
        <SettingRow
          label="Extension removal protection"
          description="Stops SmartBlocker from being removed or turned off in your browsers."
          control={status.policyProtected ? <Badge variant="success" dot>On</Badge> : <Badge dot>Off</Badge>}
        />
        <SettingRow
          label="Version"
          control={<span className="font-mono text-[13px] tabular-nums text-muted-foreground">{status.version}</span>}
        />
        <SettingRow
          stacked
          label="Data folder"
          description="Settings, the lock and the activity log are stored here."
        >
          <code
            id="data-dir"
            className="block select-all break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"
          >
            {status.dataDir}
          </code>
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
