import React from 'react';
import { ListEditor } from '../../components/ui/list-editor';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

export function SitesPage({ state }: { state: OptionsState }) {
  const { settings, lock, save } = state;
  if (!settings) return null;

  return (
    <Page
      title="Sites"
      description="Rules that skip the page check entirely. Changes save as soon as you make them."
    >
      <SettingsSection
        title="Always allow"
        description="Subdomains are included — github.com also allows gist.github.com. Allowed sites are never checked."
        aside={
          <span className="text-xs tabular-nums text-faint">
            {settings.whitelist.length} {settings.whitelist.length === 1 ? 'site' : 'sites'}
          </span>
        }
      >
        <SettingsGroup>
          <div className="px-4 py-3.5">
            <ListEditor
              id="whitelist"
              mode="domain"
              items={settings.whitelist}
              onChange={(next) => void save({ whitelist: next })}
              inputLabel="Add an allowed site"
              placeholder="example.com"
              addLabel="Add site"
              emptyText="No allowed sites. Every site is checked."
              disabled={lock.locked}
              disabledReason={lock.reason}
            />
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Always block"
        description="Any page whose address or title contains one of these is blocked instantly."
        aside={
          <span className="text-xs tabular-nums text-faint">
            {settings.blocklist.length} {settings.blocklist.length === 1 ? 'rule' : 'rules'}
          </span>
        }
      >
        <SettingsGroup>
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            <p className="m-0 text-[13px] text-muted-foreground">
              Matches anywhere in the address or title, ignoring capitals — “/cart” and “black friday”
              both work.
            </p>
            <ListEditor
              id="blocklist"
              mode="keyword"
              items={settings.blocklist}
              onChange={(next) => void save({ blocklist: next })}
              inputLabel="Add a blocked word or address"
              placeholder="e.g. reddit.com/r/all or black friday"
              addLabel="Add rule"
              emptyText="Nothing here yet. Add a word or address to block it every time."
              disabled={lock.locked}
              disabledReason={lock.reason}
            />
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
