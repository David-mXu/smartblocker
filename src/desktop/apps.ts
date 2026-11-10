// Typed app-target keys, match previews, and normalization re-exports for the
// desktop Blocked apps list. Name normalization itself lives in shared/apps.ts
// so profiles, the native bridge and this UI share one implementation.
//
// Pure (no React/DOM) so Node can unit-test it directly.
import type { AppTarget, RunningApp } from './api';
import { normalizeAppName } from '../shared/apps.ts';

export {
  appBlocklistEqual,
  appBlocklistKey,
  friendlyAppName,
  MAX_APP_BLOCKLIST,
  normalizeAppBlocklist,
  normalizeAppName,
  splitAppNames,
  summarizeApps,
  type AppNameResult,
} from '../shared/apps.ts';

/** Human label for one saved typed target. */
export function targetKindLabel(target: AppTarget): string {
  switch (target.kind) {
    case 'exactStem':
      return 'Exact app';
    case 'exePath':
      return 'Exact path';
    case 'msixPackage':
      return 'Microsoft Store app';
  }
}

/** What the target actually pins, for the blocked-apps list. */
export function targetDetail(target: AppTarget): string {
  switch (target.kind) {
    case 'exactStem':
      return `${target.stem}.exe`;
    case 'exePath':
      return target.path;
    case 'msixPackage':
      return target.familyName;
  }
}

/** Canonical dedupe key shared with the Rust side's `AppTarget::key`. */
export function targetKey(target: AppTarget): string {
  switch (target.kind) {
    case 'exactStem':
      return `exactStem:${target.stem}`;
    case 'exePath':
      return `exePath:${pathKey(target.path)}`;
    case 'msixPackage':
      return `msixPackage:${target.familyName.toLowerCase()}`;
  }
}

/** Deterministic comparison key; the backend stores already-normalized
 * paths, this only makes mock/manual values behave the same way. */
export function pathKey(path: string): string {
  let value = path.trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/');
  value = value.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const unc = value.startsWith('//');
  value = value.replace(/\/+/g, '/');
  if (unc && !value.startsWith('//')) value = `/${value}`;
  return value.replace(/\/+$/, '').toLowerCase();
}

/** Exact identity for a running app: package first, then full path, then
 * stem. This mirrors the Rust precedence and avoids guessing from a pid. */
export function exactTargetFor(app: RunningApp): AppTarget {
  if (app.packageFamily) {
    return { version: 1, kind: 'msixPackage', familyName: app.packageFamily };
  }
  if (app.exePath) {
    return { version: 1, kind: 'exePath', path: app.exePath };
  }
  return { version: 1, kind: 'exactStem', stem: app.name };
}

/** Exact-stem target for the manual "add by name" form. */
export function exactStemTarget(raw: string): AppTarget | null {
  const normalized = normalizeAppName(raw);
  return normalized.ok ? { version: 1, kind: 'exactStem', stem: normalized.value } : null;
}

export function targetMatchesApp(target: AppTarget, app: RunningApp): boolean {
  switch (target.kind) {
    case 'exactStem':
      return target.stem.toLowerCase() === app.name.toLowerCase();
    case 'exePath':
      return app.exePath !== undefined && pathKey(target.path) === pathKey(app.exePath);
    case 'msixPackage':
      return (
        app.packageFamily !== undefined &&
        target.familyName.toLowerCase() === app.packageFamily.toLowerCase()
      );
  }
}

export function legacyMatchesApp(entry: string, app: RunningApp): boolean {
  const needle = entry.trim().toLowerCase();
  return needle.length > 0 && app.name.toLowerCase().includes(needle);
}

/** Why a running app is already covered, or null. Exact wins over legacy,
 * matching the backend's matcher precedence. */
export function blockedBy(
  app: RunningApp,
  legacy: string[],
  targets: AppTarget[],
): { kind: 'exact' | 'legacy'; index: number } | null {
  const exact = targets.findIndex((target) => targetMatchesApp(target, app));
  if (exact >= 0) return { kind: 'exact', index: exact };
  const contains = legacy.findIndex((entry) => legacyMatchesApp(entry, app));
  if (contains >= 0) return { kind: 'legacy', index: contains };
  return null;
}

/** Apps a target would close right now (for the picker preview). */
export function targetCoverage(target: AppTarget, apps: RunningApp[]): RunningApp[] {
  return apps.filter((app) => targetMatchesApp(target, app));
}

export function legacyCoverage(entry: string, apps: RunningApp[]): RunningApp[] {
  return apps.filter((app) => legacyMatchesApp(entry, app));
}

function listedNames(apps: RunningApp[], limit = 3): string {
  const names = apps.slice(0, limit).map((app) => `${app.name}.exe`);
  const rest = apps.length - names.length;
  return rest > 0 ? `${names.join(', ')} + ${rest} more` : names.join(', ');
}

/** Short, explicit warning shown under a running-app row before adding it. */
export function collisionSummary(app: RunningApp, apps: RunningApp[], mode: 'exact' | 'legacy'): string {
  if (mode === 'legacy') {
    const covered = legacyCoverage(app.name, apps);
    const extras = covered.filter((candidate) => candidate.name !== app.name);
    if (extras.length > 0) {
      return `Contains match also closes ${listedNames(extras)}. Any future app containing “${app.name}” will match too.`;
    }
    return `Contains match closes any app whose name contains “${app.name}”, including future apps.`;
  }

  const target = exactTargetFor(app);
  const covered = targetCoverage(target, apps);
  if (target.kind === 'exePath') {
    const siblings = apps.filter(
      (candidate) => candidate.name === app.name && candidate.exePath !== undefined && pathKey(candidate.exePath) !== pathKey(target.path),
    );
    if (siblings.length > 0) {
      return `Exact path closes this install only. ${listedNames(siblings)} will stay open.`;
    }
    return 'Exact path closes only this executable, even if another app has the same name.';
  }
  if (target.kind === 'msixPackage') {
    return `Microsoft Store identity closes this package (${covered.length} running process${covered.length === 1 ? '' : 'es'}), not another calculator from a different publisher.`;
  }
  const sameStem = covered.filter((candidate) => candidate.name === app.name);
  return sameStem.length > 1
    ? `Exact name closes all ${sameStem.length} running ${app.name}.exe processes.`
    : `Exact name closes only ${app.name}.exe.`;
}

/** The picker's default exact choice, labelled for the button. */
export function exactChoiceLabel(app: RunningApp): string {
  return app.packageFamily ? 'This Store app' : app.exePath ? 'This exact app' : 'This exact name';
}

/** Compact name for overview prose and list labels ("Steam", "Spotify"). */
export function targetSummaryName(target: AppTarget): string {
  if (target.kind === 'exactStem') return target.stem;
  if (target.kind === 'exePath') {
    const base = pathKey(target.path).split('/').pop() ?? target.path;
    return base.replace(/\.exe$/, '');
  }
  // Package family = <package name>_<publisher id>; the last dotted part of
  // the package name is the app-facing name ("microsoft.windowsterminal_..."
  // -> "windowsterminal" -> "Windows Terminal" via FRIENDLY).
  const packageName = target.familyName.split('_')[0];
  return packageName.split('.').pop() || packageName;
}
