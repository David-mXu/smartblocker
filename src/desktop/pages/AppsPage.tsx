import React, { useCallback, useEffect, useState } from 'react';
import { ArrowsClockwise, LockSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { errorText, invoke, type RunningApp } from '../api';
import { friendlyAppName, normalizeAppName, splitAppNames } from '../apps';
import { lockedUntilText } from '../format';
import { FormMessage, LockedNote, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

// Blocked apps: the list the companion closes during any lock. Add-only while
// locked (the Rust command refuses removals; the UI disables them up front
// and still surfaces the refusal text if a lock starts mid-click).

export function AppsPage() {
  const { status, now, refresh } = useStatus();
  const [msg, setMsg] = useState<Message>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = status.lock.settingsLocked;
  const list = status.appBlocklist;

  const save = useCallback(
    async (next: string[], ok: string): Promise<boolean> => {
      setSaving(true);
      try {
        await invoke('set_app_blocklist', { apps: next });
        setMsg({ tone: 'ok', text: ok });
        return true;
      } catch (e) {
        setMsg({ tone: 'error', text: errorText(e) });
        return false;
      } finally {
        setSaving(false);
        void refresh();
      }
    },
    [refresh],
  );

  const addNames = async (raw: string[]) => {
    const added: string[] = [];
    const dupes: string[] = [];
    for (const r of raw) {
      const n = normalizeAppName(r);
      if (!n.ok) {
        setMsg({ tone: 'error', text: n.error });
        return false;
      }
      if (list.includes(n.value) || added.includes(n.value)) dupes.push(n.value);
      else added.push(n.value);
    }
    if (added.length === 0) {
      if (dupes.length) setMsg({ tone: 'ok', text: `${friendlyAppName(dupes[0])} is already blocked` });
      return true;
    }
    return save(
      [...list, ...added],
      added.length === 1 ? `Added ${friendlyAppName(added[0])}` : `Added ${added.length} apps`,
    );
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const names = splitAppNames(draft);
    if (names.length === 0) return;
    if (await addNames(names)) setDraft('');
  };

  const remove = (name: string) =>
    save(
      list.filter((n) => n !== name),
      `Removed ${friendlyAppName(name)}`,
    );

  const lockedText = lockedUntilText(status.lock, now);

  return (
    <Page
      title="Blocked apps"
      description="These apps are closed automatically while any lock is on — a focus session, focus hours or a settings lock. The rest of the time they run normally."
    >
      <SettingsSection
        title="Your blocked apps"
        aside={
          list.length > 0 ? (
            <span className="text-xs tabular-nums text-faint">
              {list.length} {list.length === 1 ? 'app' : 'apps'}
            </span>
          ) : undefined
        }
      >
        <SettingsGroup>
          <form className="flex flex-col gap-2 px-4 py-3.5" onSubmit={onSubmit}>
            <label htmlFor="app-input" className="text-sm font-medium">
              Add an app by name
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="app-input"
                value={draft}
                placeholder="steam, or paste Steam.exe"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[13px]"
                aria-describedby="apps-msg"
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (msg?.tone === 'error') setMsg(null);
                }}
              />
              <Button type="submit" variant="secondary" disabled={saving || !draft.trim()} className="shrink-0">
                Add
              </Button>
            </div>
          </form>

          {list.length === 0 ? (
            <p className="m-0 px-4 py-4 text-[13px] text-faint">
              No apps yet. Add games, chat or video apps you want closed while you focus.
            </p>
          ) : (
            <ul id="app-list" aria-label="Blocked apps" className="m-0 flex max-h-[300px] list-none flex-col divide-y divide-border overflow-y-auto p-0">
              {list.map((name) => (
                <li key={name} className="app-row flex shrink-0 items-center justify-between gap-3 py-2 pl-4 pr-2">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{friendlyAppName(name)}</span>
                    <span className="truncate font-mono text-xs text-faint">{name}.exe</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="app-remove size-7"
                    aria-label={`Remove ${friendlyAppName(name)}`}
                    title={locked ? `${lockedText} — you can add apps, not remove them` : `Remove ${friendlyAppName(name)}`}
                    disabled={locked || saving}
                    onClick={() => void remove(name)}
                  >
                    {locked ? <LockSimple className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsGroup>
        <div className="flex flex-col gap-1 px-1">
          {locked && <LockedNote>{lockedText} — you can add apps, not remove them</LockedNote>}
          {/* A refusal that races a lock start says the same as the note above. */}
          <FormMessage
            id="apps-msg"
            message={locked && msg?.tone === 'error' && msg.text.startsWith('Locked:') ? null : msg}
          />
        </div>
      </SettingsSection>

      <RunningAppsPicker blocked={list} onAdd={(name) => void addNames([name])} saving={saving} />
    </Page>
  );
}

function RunningAppsPicker({
  blocked,
  onAdd,
  saving,
}: {
  blocked: string[];
  onAdd: (name: string) => void;
  saving: boolean;
}) {
  const [apps, setApps] = useState<RunningApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setApps(await invoke('list_running_apps'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const candidates = (apps ?? []).filter((a) => !a.isBrowser);
  const browsersHidden = (apps ?? []).length - candidates.length;
  const visible = q
    ? candidates.filter((a) => a.name.includes(q) || friendlyAppName(a.name).toLowerCase().includes(q))
    : candidates;

  return (
    <SettingsSection
      title="Add from running apps"
      description="Apps open on this computer right now."
      aside={
        <Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading} aria-label="Refresh running apps">
          <ArrowsClockwise className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          Refresh
        </Button>
      }
    >
      <SettingsGroup>
        <div className="relative px-3 py-2.5">
          <MagnifyingGlass
            aria-hidden
            className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-faint"
          />
          <Input
            id="running-search"
            type="search"
            aria-label="Search running apps"
            placeholder={apps ? `Search ${candidates.length} running apps` : 'Search running apps'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        {error ? (
          <p role="alert" className="m-0 px-4 py-3 text-[13px] text-destructive-soft">
            Couldn’t list running apps. {error}
          </p>
        ) : apps === null ? (
          <p className="m-0 px-4 py-3 text-[13px] text-faint" aria-busy="true">
            Looking at what’s running…
          </p>
        ) : visible.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[13px] text-faint">
            {q ? `Nothing running matches “${query}”. You can still add it by name above.` : 'No apps found.'}
          </p>
        ) : (
          <ul id="running-list" aria-label="Running apps" className="m-0 flex max-h-[264px] list-none flex-col divide-y divide-border overflow-y-auto p-0">
            {visible.map((a) => {
              const isBlocked = blocked.includes(a.name);
              return (
                <li key={a.name} className="running-row flex h-10 shrink-0 items-center justify-between gap-3 pl-4 pr-2">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm">{friendlyAppName(a.name)}</span>
                    <span className="truncate font-mono text-xs text-faint">{a.name}.exe</span>
                  </span>
                  {isBlocked ? (
                    <span className="pr-2.5 text-xs text-faint">Already blocked</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="running-add"
                      aria-label={`Add ${friendlyAppName(a.name)}`}
                      disabled={saving}
                      onClick={() => onAdd(a.name)}
                    >
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>
      {browsersHidden > 0 && (
        <p className="m-0 px-1 text-xs text-faint">
          Browsers aren’t listed here — SmartBlocker handles them on the{' '}
          <a href="#browsers" className="text-muted-foreground underline decoration-faint/60 underline-offset-2 hover:text-foreground">
            Browsers
          </a>{' '}
          page.
        </p>
      )}
    </SettingsSection>
  );
}
