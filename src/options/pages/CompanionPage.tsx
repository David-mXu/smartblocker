import React from 'react';
import { Check, Minus } from '@phosphor-icons/react';
import type { CompanionSnapshot } from '../../shared/companion-protocol';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { ExtensionGraceNotice } from '../../components/ExtensionGraceNotice';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { Page } from './Page';

interface CompanionView {
  state: CompanionSnapshot['state'];
  text: string;
  flags: { label: string; ok: boolean }[];
}

// Strings here are part of the e2e contract ("Get SmartBlocker Companion —
// coming with the Pro release", "Connected — hardcore mode active…").
function describeCompanion(snapshot: CompanionSnapshot | null): CompanionView {
  if (!snapshot) return { state: 'connecting', text: 'Checking…', flags: [] };
  const { state, status } = snapshot;
  if (state === 'not-installed') {
    return { state, text: 'Get SmartBlocker Companion — coming with the Pro release', flags: [] };
  }
  if (state === 'connecting') return { state, text: 'Connecting…', flags: [] };
  if (state === 'disconnected') {
    return {
      state,
      text: status
        ? `Installed but not running (companion v${status.companionVersion})`
        : 'Disconnected — reconnecting…',
      flags: [],
    };
  }
  return {
    state,
    text: 'Connected — hardcore mode active' + (status ? ` (companion v${status.companionVersion})` : ''),
    flags: status
      ? [
          {
            label: `${status.enforcement.appBlocking ? 'Active' : 'Inactive'}: App blocking`,
            ok: status.enforcement.appBlocking,
          },
          {
            label: `${status.enforcement.watchdog ? 'Active' : 'Inactive'}: Browser watchdog`,
            ok: status.enforcement.watchdog,
          },
          {
            label: status.enforcement.policyProtected
              ? 'Active: Policy protection'
              : 'Inactive: Policy protection (unavailable until store release)',
            ok: status.enforcement.policyProtected,
          },
        ]
      : [],
  };
}

export function CompanionPage({ state }: { state: OptionsState }) {
  const view = describeCompanion(state.companion);
  const connected = view.state === 'connected';

  return (
    <Page
      title="Desktop app"
      description="An optional desktop app that makes locks hold outside the browser: it closes distracting apps and browsers opened without SmartBlocker."
    >
      <SettingsSection title="Status">
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className={cn('size-2 shrink-0 rounded-full', connected ? 'bg-success' : 'bg-faint')}
              />
              <div
                id="companion-status"
                role="status"
                aria-live="polite"
                className={cn(
                  'text-sm',
                  connected
                    ? 'companion-connected font-medium text-foreground'
                    : 'companion-muted text-muted-foreground',
                )}
              >
                {view.text}
              </div>
            </div>
            <ul
              id="companion-enforcement"
              style={{ display: view.flags.length > 0 ? 'flex' : 'none' }}
              className="m-0 list-none flex-col gap-1.5 p-0 pl-[18px] text-[13px] text-muted-foreground"
            >
              {view.flags.map((f) => (
                <li key={f.label} className="flex items-center gap-2">
                  {f.ok ? (
                    <Check weight="bold" aria-hidden className="size-3.5 text-success" />
                  ) : (
                    <Minus weight="bold" aria-hidden className="size-3.5 text-faint" />
                  )}
                  <span>{f.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </SettingsGroup>
        <ExtensionGraceNotice
          id="companion-grace"
          locked={state.lock.locked}
          companion={state.companion}
          now={state.now}
        />
      </SettingsSection>

      <SettingsSection title="What it adds">
        <SettingsGroup>
          <ul className="m-0 flex list-none flex-col gap-2 px-4 py-3.5 text-[13px] text-muted-foreground">
            <li>Keeps your locks, focus sessions and focus hours in force even if the extension is removed.</li>
            <li>Closes apps you've blocked while a lock is on.</li>
            <li>Closes browsers or private windows that run without SmartBlocker during a lock.</li>
          </ul>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
