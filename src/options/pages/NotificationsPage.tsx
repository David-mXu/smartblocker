import React, { useEffect, useState } from 'react';
import { Input } from '../../components/ui/input';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { Switch } from '../../components/ui/switch';
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_NOTIFICATION_MINUTES,
  MIN_NOTIFICATION_MINUTES,
  NOTIFICATION_PREFS_VERSION,
  type NotificationPrefs,
} from '../../shared/notifications';
import type { OptionsState } from '../useOptionsState';
import { LockedNote, Page } from './Page';

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_NOTIFICATION_MINUTES;
  return Math.min(
    MAX_NOTIFICATION_MINUTES,
    Math.max(MIN_NOTIFICATION_MINUTES, Math.round(value)),
  );
}

/** Local draft so the field can be cleared while typing; the committed value
 *  is still clamped by the shared preference sanitizer. */
function MinuteInput({
  id,
  value,
  disabled,
  label,
  onChange,
}: {
  id: string;
  value: number;
  disabled: boolean;
  label: string;
  onChange: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    const next = clampMinutes(Number.isFinite(parsed) ? parsed : value);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <Input
      id={id}
      type="number"
      min={MIN_NOTIFICATION_MINUTES}
      max={MAX_NOTIFICATION_MINUTES}
      step={1}
      value={draft}
      disabled={disabled}
      aria-label={label}
      className="w-20 text-right tabular-nums"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

export function NotificationsPage({ state }: { state: OptionsState }) {
  const prefs: NotificationPrefs = state.settings?.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS;
  const locked = state.lock.locked;

  const savePrefs = (next: NotificationPrefs) => {
    if (locked) return;
    void state.save({
      notificationPrefs: { ...next, version: NOTIFICATION_PREFS_VERSION },
    });
  };

  const patchSchedule = (patch: Partial<NotificationPrefs['scheduleStartingSoon']>) =>
    savePrefs({
      ...prefs,
      scheduleStartingSoon: { ...prefs.scheduleStartingSoon, ...patch },
    });
  const patchBreak = (patch: Partial<NotificationPrefs['breakEndingSoon']>) =>
    savePrefs({
      ...prefs,
      breakEndingSoon: { ...prefs.breakEndingSoon, ...patch },
    });
  const patchAllowance = (patch: Partial<NotificationPrefs['allowanceLow']>) =>
    savePrefs({
      ...prefs,
      allowanceLow: { ...prefs.allowanceLow, ...patch },
    });

  return (
    <Page
      title="Notifications"
      description="Quiet browser reminders, off by default. They give you a moment's warning before focus hours begin, a break ends, or an allowance runs out. They never make a sound."
    >
      <SettingsSection
        title="Reminders"
        description="Sent by the browser itself, so they still work when no SmartBlocker page is open. Each reminder fires once per event."
      >
        {locked && (
          <LockedNote
            reason={`${state.lock.reason} — reminders can't change until then.`}
            className="px-1"
          />
        )}
        <SettingsGroup>
          <SettingRow
            label="Focus hours starting soon"
            description="A reminder before your weekly focus hours begin. Includes category focus hours; uses the hours on the Focus hours page."
            control={
              <div className="flex items-center gap-2">
                <Switch
                  id="notify-schedule-toggle"
                  checked={prefs.scheduleStartingSoon.enabled}
                  disabled={locked}
                  onChange={(event) =>
                    patchSchedule({ enabled: event.target.checked })
                  }
                />
                <MinuteInput
                  id="notify-schedule-lead"
                  value={prefs.scheduleStartingSoon.leadMinutes}
                  disabled={locked || !prefs.scheduleStartingSoon.enabled}
                  label="Minutes before focus hours"
                  onChange={(leadMinutes) => patchSchedule({ leadMinutes })}
                />
                <span className="text-xs text-faint">min before</span>
              </div>
            }
          />
          <SettingRow
            label="Break ending soon"
            description="A reminder before a break ends and blocking resumes, including a delayed break."
            control={
              <div className="flex items-center gap-2">
                <Switch
                  id="notify-break-toggle"
                  checked={prefs.breakEndingSoon.enabled}
                  disabled={locked}
                  onChange={(event) =>
                    patchBreak({ enabled: event.target.checked })
                  }
                />
                <MinuteInput
                  id="notify-break-lead"
                  value={prefs.breakEndingSoon.leadMinutes}
                  disabled={locked || !prefs.breakEndingSoon.enabled}
                  label="Minutes before a break ends"
                  onChange={(leadMinutes) => patchBreak({ leadMinutes })}
                />
                <span className="text-xs text-faint">min before</span>
              </div>
            }
          />
          <SettingRow
            label="Allowance nearly used up"
            description="A reminder before a running allowance ends, so you can wrap up. One reminder per allowance."
            control={
              <div className="flex items-center gap-2">
                <Switch
                  id="notify-allowance-toggle"
                  checked={prefs.allowanceLow.enabled}
                  disabled={locked}
                  onChange={(event) =>
                    patchAllowance({ enabled: event.target.checked })
                  }
                />
                <MinuteInput
                  id="notify-allowance-threshold"
                  value={prefs.allowanceLow.thresholdMinutes}
                  disabled={locked || !prefs.allowanceLow.enabled}
                  label="Minutes left on an allowance"
                  onChange={(thresholdMinutes) =>
                    patchAllowance({ thresholdMinutes })
                  }
                />
                <span className="text-xs text-faint">min left</span>
              </div>
            }
          />
        </SettingsGroup>
        <p className="m-0 px-1 text-xs text-faint">
          If your browser or operating system blocks SmartBlocker&apos;s
          notifications, reminders are simply skipped. Blocking, locks, and
          allowance accounting are unaffected.
        </p>
      </SettingsSection>
    </Page>
  );
}
