import { Input } from '../../components/ui/input';
import { ListEditor } from '../../components/ui/list-editor';
import { SettingRow, SettingsGroup } from '../../components/ui/settings';

// Step 2 — "What should always stay open?" Both parts are optional: the
// seeded allow list already works, so Continue with no changes is fine.

export interface StepSitesProps {
  focusGoal: string;
  whitelist: string[];
  disabled: boolean;
  disabledReason?: string;
  onFocusGoal: (goal: string) => void;
  onWhitelist: (next: string[]) => void;
}

export function StepSites({ focusGoal, whitelist, disabled, disabledReason, onFocusGoal, onWhitelist }: StepSitesProps) {
  return (
    <SettingsGroup>
      <SettingRow
        stacked
        htmlFor="welcome-focus-goal"
        label={
          <>
            What are you working on right now? <span className="font-normal text-faint">(optional)</span>
          </>
        }
        description="Pages that match your goal stay open, even on mixed sites like YouTube. You can change it any time from the toolbar button."
      >
        <Input
          id="welcome-focus-goal"
          value={focusGoal}
          maxLength={200}
          autoComplete="off"
          placeholder="e.g. Studying for my statistics exam"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onChange={(e) => onFocusGoal(e.target.value)}
        />
      </SettingRow>
      <SettingRow
        stacked
        label="Always allow"
        description="These sites are never checked. Subdomains are included — github.com also allows gist.github.com."
      >
        {/* data-enter-local: Enter in the add field adds a site, it must not continue. */}
        <div data-enter-local="">
          <ListEditor
            id="welcome-whitelist"
            mode="domain"
            items={whitelist}
            onChange={onWhitelist}
            inputLabel="Add an allowed site"
            placeholder="docs.google.com"
            addLabel="Add site"
            emptyText="No allowed sites. Every page will be checked."
            disabled={disabled}
            disabledReason={disabledReason}
          />
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
