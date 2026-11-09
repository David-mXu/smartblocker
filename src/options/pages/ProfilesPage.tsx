import React, { useState } from 'react';
import { Check, Copy, PencilSimple, Plus, Stack, Trash, X } from '@phosphor-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { friendlyAppName, summarizeApps } from '../../shared/apps';
import {
  activeAppAssociation,
  activeProfile,
  extractProfilePolicy,
  MAX_NAMED_PROFILES,
  MAX_PROFILE_NAME_LENGTH,
  type Profile,
  type ProfilePolicy,
} from '../../shared/profiles';
import {
  activateNamedProfile,
  createNamedProfile,
  deleteNamedProfile,
  duplicateNamedProfile,
  renameNamedProfile,
} from '../../shared/profile-store';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { LockedNote, Page } from './Page';

// Named profiles are additive: the Default profile is the existing `settings`
// object and stays the fallback. This page never edits policy directly — every
// policy edit on another page lands in whichever profile is active.

function profileSummary(policy: ProfilePolicy): string {
  const categories = `${policy.blockedLabels.length} ${
    policy.blockedLabels.length === 1 ? 'category' : 'categories'
  }`;
  const sites = `${policy.whitelist.length} ${policy.whitelist.length === 1 ? 'site' : 'sites'} allowed`;
  const rules = policy.blocklist.length + policy.titleRules.length;
  return `${categories} · ${sites} · ${Math.round(policy.blockThreshold * 100)}% threshold${
    rules > 0 ? ` · ${rules} ${rules === 1 ? 'rule' : 'rules'}` : ''
  }`;
}

function appsSummary(profile: Profile | null, state: OptionsState['profiles']): string {
  const count = profile ? profile.appBlocklist.length : (state?.defaultAppBlocklist.length ?? 0);
  if (count === 0) return 'No desktop apps';
  return summarizeApps(profile ? profile.appBlocklist : (state?.defaultAppBlocklist ?? []), 2);
}

function operationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProfilesPage({ state }: { state: OptionsState }) {
  const { profiles, settings, lock, companion, refreshProfiles } = state;
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  if (!profiles || !settings) return null;

  const active = activeProfile(profiles);
  const association = activeAppAssociation(profiles);
  const locked = lock.locked;

  const announce = (text: string, error = false) => {
    setMsg(text);
    setMsgError(error);
  };

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setPendingDeleteId(null);
    try {
      await action();
      await refreshProfiles();
      announce(success);
    } catch (error) {
      await refreshProfiles();
      announce(operationMessage(error), true);
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const policy = active ? active.policy : extractProfilePolicy(settings);
    void run(
      async () => {
        await createNamedProfile({
          name,
          policy,
          appBlocklist: association.apps,
          appBlocklistUpdatedAt: association.updatedAt,
        });
        setName('');
      },
      'Profile created. Activate it when you want to switch.',
    );
  };

  const activate = (id: string | null, label: string) => {
    setEditingId(null);
    void run(async () => {
      await activateNamedProfile(id);
    }, `${label} is now active.`);
  };

  const duplicate = (profile: Profile) => {
    setEditingId(null);
    void run(async () => {
      await duplicateNamedProfile(profile.id);
    }, `Copied “${profile.name}”.`);
  };

  const beginRename = (profile: Profile) => {
    setPendingDeleteId(null);
    setEditingId(profile.id);
    setEditName(profile.name);
    announce('');
  };

  const saveRename = (profile: Profile) => {
    void run(async () => {
      await renameNamedProfile(profile.id, editName);
      setEditingId(null);
    }, `Renamed to “${editName.trim()}”.`);
  };

  const remove = (profile: Profile) => {
    if (pendingDeleteId !== profile.id) {
      setPendingDeleteId(profile.id);
      announce(`Click Delete again to remove “${profile.name}”.`);
      return;
    }
    setPendingDeleteId(null);
    if (editingId === profile.id) setEditingId(null);
    void run(async () => {
      await deleteNamedProfile(profile.id);
    }, `Deleted “${profile.name}”.`);
  };

  const appStatus = (() => {
    const connection = companion?.state ?? 'connecting';
    if (connection === 'connected') {
      return association.updatedAt === 0
        ? 'Connected. This profile has no desktop app list yet; the desktop app can fill it in.'
        : 'Connected. These apps are closed while a lock is on.';
    }
    if (connection === 'disconnected') {
      return 'Desktop app installed but not running. This saved list applies when it reconnects.';
    }
    if (connection === 'not-installed') {
      return 'Desktop app not installed. This list is saved for when it is.';
    }
    return 'Checking the desktop app…';
  })();

  return (
    <Page
      title="Profiles"
      description="Save different sets of categories, sites, rules and desktop apps, then switch between them. Your Default profile stays as the fallback."
    >
      {locked && <LockedNote id="profiles-lock-note" reason={lock.reason} className="px-1" />}

      <SettingsSection
        title="Your profiles"
        description="One profile is active at a time. Switching replaces the protected categories, sites, rules and desktop apps — never the master Blocking switch."
        aside={
          <span className="text-xs tabular-nums text-faint">
            {profiles.profiles.length} of {MAX_NAMED_PROFILES} named
          </span>
        }
      >
        <div id="profiles-list" className="flex flex-col gap-2">
          <SettingsGroup id="profile-default" className="profile-row" data-active={!active}>
            <div className="flex flex-col gap-3 px-4 py-3.5 min-[520px]:flex-row min-[520px]:items-center min-[520px]:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Default</span>
                  {!active && (
                    <Badge variant="commit" dot>
                      Active
                    </Badge>
                  )}
                  <span className="text-xs text-faint">fallback</span>
                </div>
                <p className="m-0 text-[13px] text-muted-foreground">
                  {!active
                    ? profileSummary(extractProfilePolicy(settings))
                    : 'The settings SmartBlocker used before profiles. Activate it any time.'}
                </p>
                {profiles.defaultAppBlocklist.length > 0 && (
                  <p className="m-0 text-xs text-faint">{appsSummary(null, profiles)}</p>
                )}
              </div>
              {active && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    className="profile-activate"
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    title={locked ? lock.reason : 'Activate the Default profile'}
                    onClick={() => activate(null, 'Default')}
                  >
                    Activate
                  </Button>
                </div>
              )}
            </div>
          </SettingsGroup>

          {profiles.profiles.map((profile) => {
            const isActive = profiles.activeProfileId === profile.id;
            return (
              <SettingsGroup
                key={profile.id}
                className="profile-row"
                data-active={isActive}
                data-profile-id={profile.id}
              >
                <div className="flex flex-col gap-3 px-4 py-3.5 min-[520px]:flex-row min-[520px]:items-center min-[520px]:justify-between">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {editingId === profile.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          id="profile-rename-input"
                          value={editName}
                          maxLength={MAX_PROFILE_NAME_LENGTH}
                          autoFocus
                          disabled={locked || busy}
                          aria-label={`New name for ${profile.name}`}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveRename(profile);
                            if (event.key === 'Escape') setEditingId(null);
                          }}
                          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring/70 disabled:cursor-not-allowed disabled:opacity-45"
                        />
                        <Button
                          size="xs"
                          disabled={locked || busy}
                          onClick={() => saveRename(profile)}
                        >
                          Save
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{profile.name}</span>
                        {isActive && (
                          <Badge variant="commit" dot>
                            Active
                          </Badge>
                        )}
                      </div>
                    )}
                    <p className="m-0 text-[13px] text-muted-foreground">
                      {profileSummary(profile.policy)}
                    </p>
                    <p className="m-0 text-xs text-faint">
                      {appsSummary(profile, profiles) || 'No desktop apps'}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {!isActive && (
                      <Button
                        className="profile-activate"
                        variant="outline"
                        size="sm"
                        disabled={locked || busy}
                        title={locked ? lock.reason : `Activate ${profile.name}`}
                        onClick={() => activate(profile.id, profile.name)}
                      >
                        <Check weight="bold" className="size-3.5" />
                        Activate
                      </Button>
                    )}
                    <Button
                      className="profile-duplicate"
                      variant="ghost"
                      size="icon"
                      disabled={locked || busy}
                      title={locked ? lock.reason : `Duplicate ${profile.name}`}
                      aria-label={`Duplicate ${profile.name}`}
                      onClick={() => duplicate(profile)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      className="profile-rename"
                      variant="ghost"
                      size="icon"
                      disabled={locked || busy}
                      title={locked ? lock.reason : `Rename ${profile.name}`}
                      aria-label={`Rename ${profile.name}`}
                      onClick={() => beginRename(profile)}
                    >
                      <PencilSimple className="size-3.5" />
                    </Button>
                    <Button
                      className={cn(
                        'profile-delete',
                        pendingDeleteId === profile.id && 'text-destructive-soft',
                      )}
                      variant="ghost"
                      size={pendingDeleteId === profile.id ? 'sm' : 'icon'}
                      disabled={locked || busy}
                      title={locked ? lock.reason : `Delete ${profile.name}`}
                      aria-label={
                        pendingDeleteId === profile.id
                          ? `Confirm delete ${profile.name}`
                          : `Delete ${profile.name}`
                      }
                      onClick={() => remove(profile)}
                    >
                      {pendingDeleteId === profile.id ? 'Confirm' : <Trash className="size-3.5" />}
                    </Button>
                  </div>
                </div>
              </SettingsGroup>
            );
          })}
        </div>

        <div className="flex flex-col gap-2.5 px-1 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="profile-name" className="sr-only">
              New profile name
            </label>
            <input
              id="profile-name"
              value={name}
              maxLength={MAX_PROFILE_NAME_LENGTH}
              disabled={locked || busy}
              placeholder="e.g. Work, Evening, Exams"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) create();
              }}
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-ring/70 disabled:cursor-not-allowed disabled:opacity-45"
            />
            <Button
              id="profile-create"
              disabled={locked || busy || !name.trim() || profiles.profiles.length >= MAX_NAMED_PROFILES}
              title={locked ? lock.reason : undefined}
              onClick={create}
            >
              <Plus weight="bold" className="size-3.5" />
              Create profile
            </Button>
          </div>
          <p className="m-0 text-xs text-faint">
            A new profile copies the active settings and desktop apps. It does not switch until you
            activate it.
          </p>
          <span
            id="profile-msg"
            role="status"
            aria-live="polite"
            className={cn(
              'min-h-4 text-xs font-medium',
              msgError ? 'text-destructive-soft' : 'text-success-soft',
            )}
          >
            {msg}
          </span>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Desktop apps"
        description={`The app list carried by ${active ? `“${active.name}”` : 'the Default profile'}. The desktop app closes these while a lock is on.`}
        aside={
          <span className="text-xs tabular-nums text-faint">
            {association.apps.length} {association.apps.length === 1 ? 'app' : 'apps'}
          </span>
        }
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <p id="profile-apps-status" className="m-0 text-[13px] text-muted-foreground">
              {appStatus}
            </p>
            <ul id="profile-apps-list" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {association.apps.length === 0 ? (
                <li className="text-[13px] text-faint">No desktop apps associated yet.</li>
              ) : (
                association.apps.map((app) => (
                  <li
                    key={app}
                    title={app}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                  >
                    {friendlyAppName(app)}
                  </li>
                ))
              )}
            </ul>
            <p className="m-0 text-xs text-faint">
              Apps are added and removed in the SmartBlocker desktop app. Additions are always
              allowed while locked; removals wait until the lock ends.
            </p>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
