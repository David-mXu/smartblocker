import React from 'react';
import { Select } from '../../components/ui/select';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { Switch } from '../../components/ui/switch';
import {
  orderedWeekdays,
  sortDaysForDisplay,
} from '../../shared/display-prefs';
import type { OptionsState } from '../useOptionsState';
import { minutesToClock } from '../format';
import { LockedNote, Page } from './Page';

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Display-only preferences. Changing these never touches schedule evaluation,
 *  stored minutes, or lock behavior. */
export function PreferencesPage({ state }: { state: OptionsState }) {
  const { settings, lock, save } = state;
  const locked = lock.locked;
  if (!settings) return null;

  const firstDay = settings.firstDayOfWeek;
  const hour24 = settings.hour24;
  const previewDays = sortDaysForDisplay([1, 3, 5], firstDay)
    .map((day) => DAY_SHORT[day])
    .join(', ');

  return (
    <Page
      title="Preferences"
      description="How times and days are shown across SmartBlocker. These are display settings only — your focus hours and locks work exactly the same."
    >
      <SettingsSection
        title="Date & time display"
        description="Stored schedules always use the same underlying times; only the labels change."
      >
        {locked && <LockedNote reason={lock.reason} className="px-1" />}
        <SettingsGroup>
          <SettingRow
            htmlFor="first-day-of-week"
            label="First day of the week"
            description="Changes the order of day buttons and how day lists are summarized."
            control={
              <Select
                id="first-day-of-week"
                value={String(firstDay)}
                disabled={locked}
                onChange={(event) => void save({ firstDayOfWeek: event.target.value === '1' ? 1 : 0 })}
                className="w-32"
              >
                <option value="0">Sunday</option>
                <option value="1">Monday</option>
              </Select>
            }
          />
          <SettingRow
            htmlFor="hour24-toggle"
            label="24-hour time"
            description="Show 18:30 instead of 6:30 PM. Time inputs still submit the same HH:MM values."
            control={
              <Switch
                id="hour24-toggle"
                checked={hour24}
                disabled={locked}
                onChange={(event) => void save({ hour24: event.target.checked })}
                aria-label="Use 24-hour time"
              />
            }
          />
        </SettingsGroup>
        <p
          id="preferences-preview"
          className="m-0 rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground"
        >
          Preview: <span className="text-foreground">{previewDays}</span> ·{' '}
          <span className="text-foreground">{minutesToClock(9 * 60, hour24)}</span> –{' '}
          <span className="text-foreground">{minutesToClock(17 * 60, hour24)}</span>
          <span className="sr-only">
            {' '}
            Days in order: {orderedWeekdays(firstDay).map((day) => DAY_LONG[day]).join(', ')}
          </span>
        </p>
      </SettingsSection>

      <SettingsSection
        title="Block screen"
        description="The optional note shown under the headline on block screens is configured on the Blocking page."
      >
        <p className="m-0 rounded-xl border border-border bg-card px-4 py-3.5 text-[13px] text-muted-foreground">
          {settings.blockMessage ? (
            <>
              Current note: <span className="text-foreground">“{settings.blockMessage}”</span>
            </>
          ) : (
            'No custom note yet. Add one under Blocking → Block screen message.'
          )}
        </p>
      </SettingsSection>
    </Page>
  );
}
