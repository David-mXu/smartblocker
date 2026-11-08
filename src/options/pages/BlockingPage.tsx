import React, { useEffect, useState } from 'react';
import { Plus, X } from '@phosphor-icons/react';
import { api } from '../../shared/api';
import { LABELS } from '../../shared/config';
import type { HistoryScanState } from '../../shared/messages';
import { MAX_RESUME_AHEAD_MS } from '../../shared/resume';
import type { Settings } from '../../shared/settings';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { Checkbox } from '../../components/ui/checkbox';
import { Badge } from '../../components/ui/badge';
import { SettingRow, SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { cn } from '../../lib/utils';
import type { OptionsState } from '../useOptionsState';
import { displayLabel, pct } from '../format';
import { LockedNote, Page } from './Page';

const BUILTIN_LABELS = new Set<string>(LABELS);

/** Categories that are usually work, never suggested by "Block top 3". */
const PRODUCTIVE_LABELS = new Set<string>([
  'programming and software development',
  'science and education',
  'finance and investing',
  'news and politics',
]);

export const STRICTNESS_PRESETS = [
  { value: 0.65, name: 'Relaxed', description: 'Blocks only pages that are clearly distractions.' },
  { value: 0.5, name: 'Balanced', description: 'Recommended. Catches most distractions, rarely blocks work.' },
  { value: 0.4, name: 'Strict', description: 'Also blocks pages that might be distractions.' },
] as const;

export function presetFor(threshold: number) {
  return STRICTNESS_PRESETS.find((p) => Math.abs(p.value - threshold) < 0.001) ?? null;
}

const NEUTRAL_PREFIX = 'neutral: ';

/** Epoch ms → `datetime-local` input value, in the device's local zone. */
function localInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** History-scan label → plain words. */
function scanLabelName(label: string): string {
  if (label.startsWith(NEUTRAL_PREFIX)) return displayLabel(label.slice(NEUTRAL_PREFIX.length));
  const rule = /^blocked rule: "(.*)"$/.exec(label);
  if (rule) return `Your rule “${rule[1]}”`;
  return displayLabel(label);
}

export function BlockingPage({ state }: { state: OptionsState }) {
  const { settings, lock, save, now } = state;
  const locked = lock.locked;

  const [customCategory, setCustomCategory] = useState('');
  const [categoryHint, setCategoryHint] = useState('');

  // History review
  const [scan, setScan] = useState<HistoryScanState | null>(null);
  const [scanStatusText, setScanStatusText] = useState('');

  useEffect(() => {
    // Show the last review and follow live progress — the background writes
    // historyScan after every chunk, whether the scan started here or on
    // the Advanced page.
    const apply = (s: HistoryScanState | undefined) => {
      if (!s) return;
      setScan(s);
      setScanStatusText(s.status === 'running' ? 'Reviewing your history…' : '');
    };
    void api.storage.local.get('historyScan').then(({ historyScan }) =>
      apply(historyScan as HistoryScanState | undefined),
    );
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes['historyScan']) {
        apply(changes['historyScan'].newValue as HistoryScanState | undefined);
      }
    };
    api.storage.onChanged.addListener(onChanged);
    return () => api.storage.onChanged.removeListener(onChanged);
  }, []);

  if (!settings) return null;

  const labels = settings.labels;
  const blocked = new Set(settings.blockedLabels);
  const preset = presetFor(settings.blockThreshold);

  const toggleCategory = (label: string, checked: boolean) => {
    if (locked) return;
    const next = new Set(blocked);
    if (checked) next.add(label);
    else next.delete(label);
    void save({ blockedLabels: [...next] });
  };

  const addCategory = (raw: string) => {
    const label = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!label) return;
    if (labels.includes(label)) {
      setCategoryHint(`“${displayLabel(label)}” is already on the list.`);
      setCustomCategory('');
      return;
    }
    const nextDeleted = settings.deletedBuiltinLabels.filter((l) => l !== label);
    setCustomCategory('');
    setCategoryHint(`Added “${displayLabel(label)}” and turned it on.`);
    void save({
      labels: [...labels, label],
      blockedLabels: [...blocked, label],
      deletedBuiltinLabels: nextDeleted,
    });
  };

  const removeCategory = (label: string) => {
    if (locked) return;
    const nextBlocked = [...blocked].filter((l) => l !== label);
    const nextDeleted = new Set(settings.deletedBuiltinLabels);
    if (BUILTIN_LABELS.has(label)) nextDeleted.add(label);
    setCategoryHint(`Removed “${displayLabel(label)}”.`);
    void save({
      labels: labels.filter((l) => l !== label),
      blockedLabels: nextBlocked,
      deletedBuiltinLabels: [...nextDeleted],
    });
  };

  const handleScanHistory = async () => {
    setScanStatusText('Reviewing your history…');
    setScan(null);
    await api.runtime.sendMessage({ type: 'SCAN_HISTORY' });
  };

  // Ranked categories from the last scan.
  const ranked = scan
    ? Object.entries(scan.categoryCounts).sort((a, b) => b[1] - a[1])
    : [];
  const maxCount = ranked[0]?.[1] ?? 1;
  const topDistractions = ranked
    .map(([label]) => label)
    .filter((label) => labels.includes(label) && !PRODUCTIVE_LABELS.has(label))
    .slice(0, 3);
  const unblockedTop = topDistractions.filter((l) => !blocked.has(l));
  const showBlockTop = scan?.status === 'done' && unblockedTop.length > 0;

  const handleBlockTop = () => {
    if (locked) return;
    const next = new Set(blocked);
    for (const l of topDistractions) next.add(l);
    void save({ blockedLabels: [...next] });
  };

  return (
    <Page
      title="Blocking"
      description="SmartBlocker reads each page's title on this device and blocks the ones that look like a distraction. Whole sites stay open — only the distracting pages are blocked."
    >
      <SettingsSection title="Protection" aria-label="Protection">
        <SettingsGroup>
          <SettingRow
            label="Block distracting pages"
            description={
              locked ? <LockedNote reason={lock.reason} className="mt-0.5" /> : 'Turn off to pause all blocking.'
            }
            htmlFor="enabled-toggle"
            control={
              <Switch
                id="enabled-toggle"
                checked={settings.enabled}
                disabled={locked}
                onChange={(e) => void save({ enabled: e.target.checked })}
              />
            }
          />
          <SettingRow
            label="Typed confirmation for overrides"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                'Requires a 15-second pause and retyping a sentence before a page is released. Not available while a lock is active.'
              )
            }
            htmlFor="surrender-mode-toggle"
            control={
              <Switch
                id="surrender-mode-toggle"
                checked={settings.surrenderMode === 'phrase'}
                disabled={locked}
                onChange={(e) =>
                  void save({ surrenderMode: e.target.checked ? 'phrase' : 'off' })
                }
              />
            }
          />
          <SettingRow
            label="Turn blocking back on"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : !settings.enabled && settings.resumeMode !== 'off' ? (
                <span className="text-accent-soft">
                  Blocking is paused — it turns back on{' '}
                  {settings.resumeMode === 'startup'
                    ? 'next time the browser starts'
                    : settings.resumeMode === 'schedule'
                      ? 'when your next focus hours begin'
                      : settings.resumeAt !== null
                        ? `at ${new Date(settings.resumeAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
                        : 'at the time you pick'}
                  .
                </span>
              ) : (
                'If you pause blocking, SmartBlocker can switch it back on for you — so a quick break doesn’t become the whole afternoon.'
              )
            }
            htmlFor="resume-mode"
            control={
              <Select
                id="resume-mode"
                value={settings.resumeMode}
                disabled={locked}
                onChange={(e) => {
                  const mode = e.target.value as Settings['resumeMode'];
                  void save({
                    resumeMode: mode,
                    // Pre-fill a sane instant the first time a time-based
                    // mode is picked (setSettings clamps it to 24h).
                    ...(mode === 'time' && (settings.resumeAt === null || settings.resumeAt <= now)
                      ? { resumeAt: now + 3_600_000 }
                      : {}),
                  });
                }}
              >
                <option value="off">Never</option>
                <option value="startup">When the browser restarts</option>
                <option value="schedule">When focus hours begin</option>
                <option value="time">At a set time</option>
              </Select>
            }
          />
          {settings.resumeMode === 'time' && (
            <SettingRow
              label="Turn back on at"
              description="Any time in the next 24 hours."
              htmlFor="resume-at"
              control={
                <Input
                  id="resume-at"
                  type="datetime-local"
                  disabled={locked}
                  min={localInputValue(now)}
                  max={localInputValue(now + MAX_RESUME_AHEAD_MS)}
                  value={settings.resumeAt !== null ? localInputValue(settings.resumeAt) : ''}
                  onChange={(e) => {
                    const t = new Date(e.target.value).getTime();
                    if (Number.isFinite(t)) void save({ resumeAt: t });
                  }}
                />
              }
            />
          )}
          <SettingRow
            label="Hide distractions in search results"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                'Folds away distracting YouTube videos, plus video carousels, games and shopping boxes on Google, Bing and other search engines, so a search doesn’t turn into a detour.'
              )
            }
            htmlFor="mask-search-elements-toggle"
            control={
              <Switch
                id="mask-search-elements-toggle"
                checked={settings.maskSearchElements}
                disabled={locked}
                onChange={(e) => void save({ maskSearchElements: e.target.checked })}
              />
            }
          />
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-col gap-0.5">
              <span id="strictness-label" className="text-sm font-medium text-foreground">
                How strict
              </span>
              <span className="text-[13px] text-muted-foreground">
                How sure SmartBlocker must be that a page is a distraction before it blocks it.
              </span>
            </div>
            <div
              role="radiogroup"
              aria-labelledby="strictness-label"
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              {STRICTNESS_PRESETS.map((p) => {
                const checked = preset?.value === p.value;
                return (
                  <label
                    key={p.name}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring/70',
                      checked ? 'border-primary/70 bg-muted' : 'border-border hover:bg-muted',
                      locked ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="strictness"
                        value={p.value}
                        checked={checked}
                        disabled={locked}
                        onChange={() => void save({ blockThreshold: p.value })}
                        className="sr-only"
                      />
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-3.5 items-center justify-center rounded-full border',
                          checked ? 'border-primary' : 'border-faint',
                        )}
                      >
                        {checked && <span className="size-1.5 rounded-full bg-primary" />}
                      </span>
                      <span className="text-sm font-medium text-foreground">{p.name}</span>
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">{p.description}</span>
                  </label>
                );
              })}
            </div>
            {!preset && (
              <p className="m-0 text-xs text-muted-foreground">
                Custom ({pct(settings.blockThreshold)}) — set exactly on{' '}
                <a href="#advanced" className="text-foreground underline underline-offset-2">
                  Advanced
                </a>
                . Pick a level above to switch back.
              </p>
            )}
          </div>
        </SettingsGroup>

      </SettingsSection>

      <SettingsSection
        title="What to block"
        description="Checked categories are blocked. Unchecked ones are recognized but left alone."
        aside={
          <span className="text-xs tabular-nums text-faint">
            {blocked.size} of {labels.length} blocked
          </span>
        }
      >
        <SettingsGroup className="overflow-hidden">
          <ul id="label-list" className="m-0 grid list-none grid-cols-1 gap-px bg-border p-0 sm:grid-cols-2">
            {labels.map((label) => {
              const isChecked = blocked.has(label);
              return (
                <li
                  key={label}
                  className="group/row flex min-h-11 items-center gap-3 bg-card px-4 py-2 transition-colors hover:bg-muted sm:last:odd:col-span-2"
                >
                  <Checkbox
                    id={`lbl-${label}`}
                    checked={isChecked}
                    disabled={locked}
                    onChange={(e) => toggleCategory(label, e.target.checked)}
                  />
                  <label
                    htmlFor={`lbl-${label}`}
                    className={cn(
                      'label-name min-w-0 flex-1 text-sm leading-snug select-none',
                      locked ? 'cursor-default' : 'cursor-pointer',
                      isChecked ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {displayLabel(label)}
                  </label>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => removeCategory(label)}
                    title={`Remove ${displayLabel(label)}`}
                    aria-label={`Remove ${displayLabel(label)}`}
                    className="delete-label-btn flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-[opacity,color] hover:text-destructive-soft focus-visible:opacity-100 disabled:hidden pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          <SettingRow
            label="Also block adults-only sites instantly"
            description={
              locked ? (
                <LockedNote reason={lock.reason} className="mt-0.5" />
              ) : (
                'Sites that label themselves adults-only, and every .xxx address, are blocked before the page is even checked.'
              )
            }
            htmlFor="block-adult-toggle"
            control={
              <Switch
                id="block-adult-toggle"
                checked={settings.blockAdult}
                disabled={locked}
                onChange={(e) => void save({ blockAdult: e.target.checked })}
              />
            }
          />
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <label htmlFor="custom-category-input" className="text-sm font-medium text-foreground">
              Add your own category
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="text"
                id="custom-category-input"
                value={customCategory}
                disabled={locked}
                placeholder="e.g. cooking and recipes"
                onChange={(e) => {
                  setCustomCategory(e.target.value);
                  setCategoryHint('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory(customCategory);
                  }
                }}
              />
              <Button
                id="add-category-btn"
                variant="secondary"
                disabled={locked || !customCategory.trim()}
                onClick={() => addCategory(customCategory)}
                className="shrink-0"
              >
                <Plus weight="bold" className="size-3.5" />
                Add
              </Button>
            </div>
            <p role="status" aria-live="polite" className="m-0 text-xs text-faint">
              {locked
                ? lock.reason
                : categoryHint || 'A few words work best — “cooking and recipes” beats “cooking”.'}
            </p>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Find your distractions"
        description="Review your recent browsing history on this device to see which categories take up your time. Nothing leaves this device."
      >
        <SettingsGroup>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button id="scan-btn" variant="secondary" size="sm" onClick={() => void handleScanHistory()}>
                Review my history
              </Button>
              <Button
                id="block-top-btn"
                variant="outline"
                size="sm"
                disabled={locked}
                title={locked ? lock.reason : undefined}
                style={{ display: showBlockTop ? 'inline-flex' : 'none' }}
                onClick={handleBlockTop}
              >
                Block the top {topDistractions.length}
              </Button>
              <span id="scan-status" role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {scanStatusText}
              </span>
            </div>

            <div id="scan-out" style={{ display: scan ? 'block' : 'none' }}>
              {scan && (
                <div className="flex flex-col gap-3">
                  <p className="m-0 text-xs text-muted-foreground tabular-nums">
                    {scan.status === 'running'
                      ? `Checked ${scan.done} of ${scan.total} pages…`
                      : scan.status === 'error'
                        ? 'The review stopped early.'
                        : `Checked ${scan.done} pages in ${(scan.elapsedMs / 1000).toFixed(1)}s.`}
                  </p>
                  {scan.error && <p className="m-0 text-xs text-destructive-soft">Error: {scan.error}</p>}
                  {scan.status === 'done' && scan.total === 0 && (
                    <p className="m-0 text-xs text-muted-foreground">
                      {scan.historyCount === 0
                        ? 'No browsing history found.'
                        : `Found ${scan.historyCount} pages in your history, but they were all on your allowed sites, already reviewed, or too generic to tell.`}
                    </p>
                  )}
                  {ranked.length > 0 && (
                    <ol className="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border bg-background p-0">
                      {ranked.slice(0, 10).map(([label, n], i) => {
                        const isBlocked = blocked.has(label);
                        return (
                          <li key={label} className="flex flex-col gap-1.5 px-3 py-2">
                            <div className="flex items-center gap-3">
                              <span className="w-4 shrink-0 text-right font-mono text-xs tabular-nums text-faint">
                                {i + 1}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                                {scanLabelName(label)}
                              </span>
                              {isBlocked && <Badge variant="destructive">Blocked</Badge>}
                              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                {n} {n === 1 ? 'page' : 'pages'}
                              </span>
                            </div>
                            <div aria-hidden className="ml-7 h-0.5 rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-muted-foreground/60"
                                style={{ width: `${Math.max(4, (n / maxCount) * 100)}%` }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {showBlockTop && (
                    <p className="m-0 text-xs text-muted-foreground">
                      “Block the top {topDistractions.length}” also blocks{' '}
                      {unblockedTop.map((l) => displayLabel(l)).join(', ')}.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </SettingsGroup>
      </SettingsSection>
    </Page>
  );
}
