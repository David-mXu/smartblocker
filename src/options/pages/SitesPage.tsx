import React, { useEffect, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { ListEditor } from '../../components/ui/list-editor';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

export function SitesPage({ state }: { state: OptionsState }) {
  const { settings, lock, save } = state;
  const extraCount = settings
    ? settings.titleRules.length + settings.channelBlocklist.length + settings.channelAllowlist.length
    : 0;
  // "More rules" starts open whenever it already holds rules, so nothing a
  // user configured is ever hidden from them.
  const [moreOpen, setMoreOpen] = useState(extraCount > 0);
  // Settings load async: open once on first load if rules exist (never
  // re-open after the user collapses it).
  const autoOpened = useRef(extraCount > 0);
  useEffect(() => {
    if (!autoOpened.current && settings) {
      autoOpened.current = true;
      if (extraCount > 0) setMoreOpen(true);
    }
  }, [settings, extraCount]);
  if (!settings) return null;
  const channelCount = settings.channelBlocklist.length + settings.channelAllowlist.length;

  return (
    <Page
      title="Sites"
      description="Sites to always allow or always block, no matter what the page is about. Changes save as soon as you make them."
    >
      <SettingsSection
        title="Always allow"
        description="Subdomains are included — github.com also allows gist.github.com. Use * for a wildcard within a specific site, like *.github.com or github.com/*/pulls. Allowed sites are never checked."
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
              both work. Use * to skip any characters, like “youtube.com*minecraft”.
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

      <details
        id="more-rules"
        open={moreOpen}
        onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group/more flex flex-col"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring/70 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">More rules</span>
            <span className="text-[13px] text-muted-foreground">
              Title patterns and YouTube channels — for when a site is mostly fine but one kind of page isn’t.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {extraCount > 0 && (
              <span className="text-xs tabular-nums text-faint">
                {extraCount} {extraCount === 1 ? 'rule' : 'rules'}
              </span>
            )}
            <CaretDown
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open/more:rotate-180"
            />
          </span>
        </summary>

        <div className="mt-6 flex flex-col gap-10">
          <SettingsSection
            title="Title patterns"
            description="Block pages whose title matches. Use * for “anything in between” — minecraft*speedrun matches “Minecraft any% speedrun”."
            aside={
              <span className="text-xs tabular-nums text-faint">
                {settings.titleRules.length} {settings.titleRules.length === 1 ? 'pattern' : 'patterns'}
              </span>
            }
          >
            <SettingsGroup>
              <div className="px-4 py-3.5">
                <ListEditor
                  id="title-rules"
                  mode="keyword"
                  items={settings.titleRules}
                  onChange={(next) => void save({ titleRules: next })}
                  inputLabel="Add a title pattern"
                  placeholder="e.g. minecraft*speedrun"
                  addLabel="Add pattern"
                  emptyText="No title patterns yet."
                  disabled={lock.locked}
                  disabledReason={lock.reason}
                />
              </div>
            </SettingsGroup>
          </SettingsSection>

          <SettingsSection
            title="YouTube channels"
            description="Decide by who made the video, not just its title. Type the channel’s handle — the @ is optional."
            aside={
              <span className="text-xs tabular-nums text-faint">
                {channelCount} {channelCount === 1 ? 'channel' : 'channels'}
              </span>
            }
          >
            <SettingsGroup>
              <SettingRow
                stacked
                label="Always block these channels"
                description="Every video from these channels is blocked, whatever it’s about."
              >
                <ListEditor
                  id="channel-blocklist"
                  mode="channel"
                  items={settings.channelBlocklist}
                  onChange={(next) => void save({ channelBlocklist: next })}
                  inputLabel="Add a channel to block"
                  placeholder="@mrbeast"
                  addLabel="Add channel"
                  emptyText="No blocked channels."
                  disabled={lock.locked}
                  disabledReason={lock.reason}
                />
              </SettingRow>
              <SettingRow
                stacked
                label="Never block these channels for their topic"
                description="For channels SmartBlocker keeps getting wrong (a science channel that looks like entertainment). Your Always block rules and blocked channels still apply."
              >
                <ListEditor
                  id="channel-allowlist"
                  mode="channel"
                  items={settings.channelAllowlist}
                  onChange={(next) => void save({ channelAllowlist: next })}
                  inputLabel="Add a channel to keep open"
                  placeholder="@veritasium"
                  addLabel="Add channel"
                  emptyText="No channels here yet."
                  disabled={lock.locked}
                  disabledReason={lock.reason}
                />
              </SettingRow>
            </SettingsGroup>
          </SettingsSection>
        </div>
      </details>
    </Page>
  );
}
