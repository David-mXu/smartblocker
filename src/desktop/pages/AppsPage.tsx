import React, { useCallback, useEffect, useState } from 'react';
import { ArrowsClockwise, LockSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { Callout, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import {
  errorText,
  invoke,
  type AppState,
  type AppTarget,
  type RunningApp,
} from '../api';
import {
  blockedBy,
  collisionSummary,
  exactChoiceLabel,
  exactStemTarget,
  exactTargetFor,
  friendlyAppName,
  legacyCoverage,
  normalizeAppName,
  splitAppNames,
  targetDetail,
  targetKey,
  targetKindLabel,
  targetSummaryName,
} from '../apps';
import { lockedUntilText } from '../format';
import { FormMessage, LockedNote, Page, type Message } from '../components/Page';
import { useStatus } from '../useDesktop';

// Blocked apps: the list the companion closes during any lock. Add-only while
// locked (the Rust command refuses removals; the UI disables them up front
// and still surfaces the refusal text if a lock starts mid-click).
//
// Two storage shapes coexist:
//   - appBlocklist: legacy case-insensitive substrings ("steam" also closes
//     steamwebhelper), preserved exactly so old configs keep working;
//   - appTargets: versioned exact identities (Store package > full exe path >
//     exact stem). The picker defaults to exact and shows what each choice
//     would close before the user commits.

type MatchMode = 'exact' | 'contains';

const RUNNING_GROUPS: { state: AppState; label: string }[] = [
  { state: 'visible', label: 'On your screen' },
  { state: 'open', label: 'Open, not on your screen' },
  { state: 'background', label: 'Running in the background' },
];

export function AppsPage() {
  const { status, now, refresh } = useStatus();
  const [msg, setMsg] = useState<Message>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<MatchMode>('exact');
  const [saving, setSaving] = useState(false);
  const locked = status.lock.settingsLocked;
  const legacy = status.appBlocklist;
  const targets = status.appTargets;
  const total = legacy.length + targets.length;

  const save = useCallback(
    async (nextLegacy: string[], nextTargets: AppTarget[], ok: string): Promise<boolean> => {
      setSaving(true);
      try {
        await invoke('set_app_blocklist', { apps: nextLegacy, targets: nextTargets });
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
    const addedTargets: AppTarget[] = [];
    const addedLegacy: string[] = [];
    const dupes: string[] = [];
    for (const r of raw) {
      if (mode === 'contains') {
        const n = normalizeAppName(r);
        if (!n.ok) {
          setMsg({ tone: 'error', text: n.error });
          return false;
        }
        if (
          legacy.some((entry) => entry.toLowerCase() === n.value) ||
          addedLegacy.includes(n.value)
        )
          dupes.push(n.value);
        else addedLegacy.push(n.value);
        continue;
      }
      const target = exactStemTarget(r);
      if (!target) {
        const n = normalizeAppName(r);
        setMsg({ tone: 'error', text: n.ok ? `"${r}" doesn't look like an app name` : n.error });
        return false;
      }
      const key = targetKey(target);
      if (targets.some((existing) => targetKey(existing) === key) || addedTargets.some((existing) => targetKey(existing) === key)) {
        dupes.push(target.kind === 'exactStem' ? target.stem : targetDetail(target));
      } else {
        addedTargets.push(target);
      }
    }
    if (addedTargets.length === 0 && addedLegacy.length === 0) {
      if (dupes.length) {
        setMsg({ tone: 'ok', text: `${friendlyAppName(dupes[0])} is already blocked${mode === 'contains' ? ' by a contains match' : ''}` });
      }
      return true;
    }
    const parts: string[] = [];
    if (addedTargets.length) {
      parts.push(
        addedTargets.length === 1
          ? `Added exact ${targetDetail(addedTargets[0])}`
          : `Added ${addedTargets.length} exact apps`,
      );
    }
    if (addedLegacy.length) {
      parts.push(
        addedLegacy.length === 1
          ? `Added contains match “${addedLegacy[0]}”`
          : `Added ${addedLegacy.length} contains matches`,
      );
    }
    return save([...legacy, ...addedLegacy], [...targets, ...addedTargets], parts.join(' · '));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const names = splitAppNames(draft);
    if (names.length === 0) return;
    if (await addNames(names)) setDraft('');
  };

  const removeTarget = (index: number) =>
    save(
      legacy,
      targets.filter((_, i) => i !== index),
      `Removed ${targetKindLabel(targets[index])}`,
    );

  const removeLegacy = (index: number) =>
    save(
      legacy.filter((_, i) => i !== index),
      targets,
      `Removed contains match “${legacy[index]}”`,
    );

  const addExact = (app: RunningApp) => {
    const target = exactTargetFor(app);
    if (targets.some((existing) => targetKey(existing) === targetKey(target))) {
      setMsg({ tone: 'ok', text: `${friendlyAppName(app.name)} is already blocked by an exact target` });
      return;
    }
    void save(
      legacy,
      [...targets, target],
      `Added exact ${targetDetail(target)}`,
    );
  };

  const addContains = (app: RunningApp) => {
    if (legacy.some((entry) => entry.toLowerCase() === app.name.toLowerCase())) {
      setMsg({ tone: 'ok', text: `${friendlyAppName(app.name)} is already blocked by a contains match` });
      return;
    }
    void save(
      [...legacy, app.name],
      targets,
      `Added contains match “${app.name}” — it closes apps whose name contains it`,
    );
  };

  const lockedText = lockedUntilText(status.lock, now);

  return (
    <Page
      title="Blocked apps"
      description="These apps are closed automatically while any lock is on — a focus session, focus hours or a settings lock. The rest of the time they run normally."
    >
      <SettingsSection
        title="Your blocked apps"
        aside={
          total > 0 ? (
            <span className="text-xs tabular-nums text-faint">
              {total} {total === 1 ? 'app' : 'apps'}
            </span>
          ) : undefined
        }
      >
        <SettingsGroup>
          <form className="flex flex-col gap-2 px-4 py-3.5" onSubmit={onSubmit}>
            <label htmlFor="app-input" className="text-sm font-medium">
              Add an app by name
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="How to match this app"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as MatchMode);
                  if (msg?.tone === 'error') setMsg(null);
                }}
                className="w-[190px] shrink-0"
              >
                <option value="exact">Exact app (recommended)</option>
                <option value="contains">Contains match (legacy)</option>
              </Select>
              <Input
                id="app-input"
                value={draft}
                placeholder={mode === 'exact' ? 'steam, or paste Steam.exe' : 'steam — matches steamwebhelper too'}
                spellCheck={false}
                autoComplete="off"
                className="min-w-[160px] flex-1 font-mono text-[13px]"
                aria-describedby="app-input-help apps-msg"
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (msg?.tone === 'error') setMsg(null);
                }}
              />
              <Button type="submit" variant="secondary" disabled={saving || !draft.trim()} className="shrink-0">
                Add
              </Button>
            </div>
            <p id="app-input-help" className="m-0 text-xs text-faint">
              {mode === 'exact'
                ? 'Exact matches the executable name only — steam does not close steamwebhelper.'
                : 'Legacy contains matches any executable name containing this text, including future apps. Prefer exact unless you need the broader rule.'}
            </p>
            {mode === 'contains' && (
              <Callout tone="warning" className="px-3 py-2 text-xs">
                Contains matches are broad. “steam” also closes steamwebhelper, smartblocker-steam and any future app
                with “steam” in its executable name.
              </Callout>
            )}
          </form>

          {total === 0 ? (
            <p className="m-0 px-4 py-4 text-[13px] text-faint">
              No apps yet. Add games, chat or video apps you want closed while you focus.
            </p>
          ) : (
            <ul id="app-list" aria-label="Blocked apps" className="m-0 flex max-h-[360px] list-none flex-col divide-y divide-border overflow-y-auto p-0">
              {targets.map((target, index) => (
                <li
                  key={`target:${targetKey(target)}`}
                  data-app-kind={target.kind}
                  className="app-row flex shrink-0 items-center justify-between gap-3 py-2 pl-4 pr-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {friendlyAppName(targetSummaryName(target))}
                      </span>
                      <Badge variant="outline">{targetKindLabel(target)}</Badge>
                    </span>
                    <span className="truncate font-mono text-xs text-faint" title={targetDetail(target)}>
                      {targetDetail(target)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="app-remove size-7 shrink-0"
                    aria-label={`Remove ${targetKindLabel(target)} ${targetDetail(target)}`}
                    title={locked ? `${lockedText} — you can add apps, not remove them` : `Remove ${targetDetail(target)}`}
                    disabled={locked || saving}
                    onClick={() => void removeTarget(index)}
                  >
                    {locked ? <LockSimple className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  </Button>
                </li>
              ))}
              {legacy.map((entry, index) => (
                <li
                  key={`legacy:${entry}`}
                  data-app-kind="contains"
                  className="app-row flex shrink-0 items-center justify-between gap-3 py-2 pl-4 pr-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm font-medium">Contains “{entry}”</span>
                      <Badge variant="warning">Legacy match</Badge>
                    </span>
                    <span className="truncate text-xs text-faint">
                      Also closes apps whose executable name contains “{entry}”.
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="app-remove size-7 shrink-0"
                    aria-label={`Remove contains match ${entry}`}
                    title={locked ? `${lockedText} — you can add apps, not remove them` : `Remove contains match “${entry}”`}
                    disabled={locked || saving}
                    onClick={() => void removeLegacy(index)}
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

      <RunningAppsPicker
        blockedLegacy={legacy}
        blockedTargets={targets}
        onAddExact={addExact}
        onAddContains={addContains}
        saving={saving}
      />
    </Page>
  );
}

function RunningAppsPicker({
  blockedLegacy,
  blockedTargets,
  onAddExact,
  onAddContains,
  saving,
}: {
  blockedLegacy: string[];
  blockedTargets: AppTarget[];
  onAddExact: (app: RunningApp) => void;
  onAddContains: (app: RunningApp) => void;
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
    ? candidates.filter(
        (a) =>
          a.name.includes(q) ||
          friendlyAppName(a.name).toLowerCase().includes(q) ||
          (a.exePath ?? '').includes(q) ||
          (a.packageFamily ?? '').includes(q),
      )
    : candidates;

  return (
    <SettingsSection
      title="Add from running apps"
      description="Everything running on this computer, starting with what’s on your screen. Exact is the default; contains is the old broad rule."
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
          <div id="running-list" className="max-h-[380px] overflow-y-auto">
            {RUNNING_GROUPS.map(({ state, label }) => {
              const rows = visible.filter((a) => a.state === state);
              if (rows.length === 0) return null;
              return (
                <section key={state} aria-label={label}>
                  <h4 className="sticky top-0 z-10 m-0 flex items-baseline justify-between gap-3 border-b border-border bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground">
                    {label}
                    <span className="font-normal tabular-nums text-faint">{rows.length}</span>
                  </h4>
                  <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                    {rows.map((a) => (
                      <RunningAppRow
                        key={`${a.state}:${a.name}:${a.exePath ?? ''}:${a.packageFamily ?? ''}`}
                        app={a}
                        apps={candidates}
                        blockedLegacy={blockedLegacy}
                        blockedTargets={blockedTargets}
                        onAddExact={onAddExact}
                        onAddContains={onAddContains}
                        saving={saving}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
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

function RunningAppRow({
  app,
  apps,
  blockedLegacy,
  blockedTargets,
  onAddExact,
  onAddContains,
  saving,
}: {
  app: RunningApp;
  apps: RunningApp[];
  blockedLegacy: string[];
  blockedTargets: AppTarget[];
  onAddExact: (app: RunningApp) => void;
  onAddContains: (app: RunningApp) => void;
  saving: boolean;
}) {
  const blocked = blockedBy(app, blockedLegacy, blockedTargets);
  const exact = exactTargetFor(app);
  const exactWarning = collisionSummary(app, apps, 'exact');
  const containsWarning = collisionSummary(app, apps, 'legacy');

  return (
    <li
      data-running-name={app.name}
      className="running-row flex shrink-0 flex-col gap-1.5 px-4 py-2.5"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <span className="truncate text-sm">{friendlyAppName(app.name)}</span>
            <span className="font-mono text-xs text-faint">{app.name}.exe</span>
            {app.packageFamily && <Badge variant="outline">Store</Badge>}
            {app.count > 1 && <span className="text-xs tabular-nums text-faint">{app.count} processes</span>}
          </span>
          {app.exePath && (
            <span className="truncate font-mono text-[11px] text-faint" title={app.exePath}>
              {app.exePath}
            </span>
          )}
          {app.packageFamily && (
            <span className="truncate font-mono text-[11px] text-faint" title={app.packageFamily}>
              {app.packageFamily}
            </span>
          )}
        </span>
        {blocked ? (
          <span className="shrink-0 pr-1 text-xs text-faint">
            {blocked.kind === 'exact'
              ? `Blocked · ${targetKindLabel(blockedTargets[blocked.index])}`
              : `Blocked · contains “${blockedLegacy[blocked.index]}”`}
          </span>
        ) : (
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              variant="secondary"
              size="xs"
              className="running-add"
              aria-label={`${exactChoiceLabel(app)}: ${friendlyAppName(app.name)}`}
              disabled={saving}
              onClick={() => onAddExact(app)}
            >
              {exactChoiceLabel(app)}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="running-add-contains"
              aria-label={`Add contains match for ${friendlyAppName(app.name)}`}
              disabled={saving}
              onClick={() => onAddContains(app)}
            >
              Contains match
            </Button>
          </span>
        )}
      </div>
      {!blocked && (
        <p className="m-0 text-[11px] leading-snug text-faint">
          <span className="text-muted-foreground">Exact:</span> {exactWarning}
        </p>
      )}
      {!blocked && legacyCoverage(app.name, apps).length > 1 && (
        <p className="m-0 text-[11px] leading-snug text-warning-soft">
          Contains: {containsWarning}
        </p>
      )}
      {blocked?.kind === 'exact' && (
        <p className="m-0 text-[11px] leading-snug text-faint">
          This row is covered by {targetDetail(blockedTargets[blocked.index])}.
        </p>
      )}
      {!blocked && exact.kind !== 'exactStem' && (
        <p className="m-0 text-[11px] leading-snug text-faint">
          Chosen identity: {targetKindLabel(exact)} — {targetDetail(exact)}
        </p>
      )}
    </li>
  );
}
