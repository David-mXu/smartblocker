# Typed app identity for the blocked-apps list

**Date:** 2026-11-09 · **Scope:** [app_targets.rs](../../companion/crates/smartblocker-core/src/app_targets.rs), [win_meta.rs](../../companion/crates/smartblocker-core/src/win_meta.rs), [enforcer.rs](../../companion/crates/smartblocker-core/src/enforcer.rs), [store.rs](../../companion/crates/smartblocker-core/src/store.rs), [AppsPage.tsx](../../src/desktop/pages/AppsPage.tsx), [apps.ts](../../src/desktop/apps.ts), [design-notes-desktop.md](../design-notes-desktop.md)

## 1. The problem

The blocked-apps list was one string per app (`appBlocklist`), matched as a
case-insensitive substring of the executable stem. That made `steam` close
`steamwebhelper`, which is often exactly what a user wants, but it also closed
any renamed decoy or unrelated program with `steam` in its name. There was no
way to say "this Steam install" or "this Microsoft Store app" instead of "every
process whose name contains these letters".

The goal was to keep old configs working unchanged while offering three safer
identities:

- exact executable stem (`steam` matches only `steam.exe`);
- normalized full executable path (one install, not a parent folder);
- Microsoft Store package family name (the app package, independent of its
  install path).

The identity must always name a real executable or process, never an arbitrary
PID.

## 2. Concepts worth knowing

- **A process has several identities.** The executable stem is cheap and
  survives app updates; the full path distinguishes two installs of the same
  program; a Store package family name (`Microsoft.WindowsCalculator_8wekyb3d8bbwe`)
  identifies the packaged app across versions and install locations.
- **Package family name, not package full name.** Windows' `GetPackageFamilyName`
  returns `<PackageName>_<PublisherId>`. The full name also contains the version
  and architecture, so it would change on every Store update. A process outside
  a package returns `APPMODEL_ERROR_NO_PACKAGE`, which is a normal "no
  identity", not an error.
- **Normalization has to be deterministic.** Windows paths are case-insensitive,
  accept `/` and `\`, may carry `\\?\` or `\\?\UNC\` long-path prefixes, and may
  contain `.`/`..` or duplicate separators. Two spellings of the same path must
  produce the same stored value, otherwise equality matching and lock-time
  dedupe both break.
- **Precedence beats storage order.** A process can match a package target, a
  path target, a stem target and a legacy substring at once. The matcher picks
  `msixPackage > exePath > exactStem > legacy contains` explicitly, so
  reordering the config cannot change which rule is reported.
- **Versioned wire shape.** `AppTarget` is an internally tagged enum
  (`kind: "exePath"`, etc.) with a per-variant `version`. A future build can
  add semantics without an older build silently guessing; entries from a newer
  version are dropped rather than reinterpreted.
- **Lenient decoding.** One malformed entry in `config.json` used to be able to
  fail the whole file. The typed list is decoded entry by entry, failures are
  dropped, then the result is sanitized and bounded.

## 3. What was done, in order

1. **Modeled the identity first, without Windows calls.** Added
   `app_targets.rs` with `AppTarget::{ExactStem, ExePath, MsixPackage}`,
   `ProcessIdentity`, `match_process`, and pure normalization/sanitization.
   Keeping this platform-independent made every rule unit-testable on Linux.
2. **Defined exact semantics.** Exact stem reuses `procwatch::normalize_exe_stem`
   (lowercase, no `.exe`, self-updater suffix removed). Path matching is
   equality after normalization — case, separators, long-path/UNC prefixes,
   duplicate separators, `.`/`..`, trailing dots/spaces — and never a folder
   prefix. Package matching normalizes case and requires the
   `<name>_<publisher>` shape.
3. **Read live package metadata.** Added `win_meta::process_package_family(pid)`
   using `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` and
   `GetPackageFamilyName`; the non-Windows build returns `None`. The enforcer
   and picker both use it, so a Store app can be identified without guessing
   from `WindowsApps` paths.
4. **Put both lists in the config.** `CompanionConfig` now has `app_targets`
   and `app_targets_version`; `app_blocklist` stays verbatim (trimmed and
   deduped only). `load_config` sanitizes in memory, `save_config` sanitizes
   before writing, and a missing `appTargets` field reads as an empty list.
   Old configs therefore keep their substring behavior with no migration step.
5. **Changed the enforcer at the matching point only.** The existing
   browser-classification/protection order is untouched; after those checks the
   enforcer builds a `ProcessIdentity` and calls `matches_process`. Typed
   targets cannot bypass browser handling or protected-process checks.
6. **Extended lock-time healing.** Mid-lock `config.json` restoration now pins
   both legacy entries and typed targets. Targets compare by canonical key, so
   reordering or respelling the same identity is not treated as a removal, while
   a swapped identity is restored like a dropped one. New additions are learned.
7. **Made the picker explain the choice.** Running apps are grouped by
   `(stem, normalized path, package family)` so two installs are separate rows.
   Each row shows the path/package, offers "This exact app" (package first,
   then path, then stem) and "Contains match", and previews what each choice
   would close. The saved list labels exact targets and legacy warnings
   separately, and removals stay disabled while locked. The Tauri command keeps
   `targets` optional so an older UI that only sends `apps` does not erase the
   typed list.

## 4. Tradeoffs and unresolved questions

- **Legacy entries are never auto-migrated.** A typed target does not narrow an
  existing substring rule. That preserves behavior, but a user who wants the
  narrower rule must remove the legacy entry deliberately (the UI shows it as a
  warning).
- **Exact paths can age.** Apps that install into versioned folders (Discord,
  Slack, some Electron apps) may move on update, so a path target can stop
  matching. The picker prefers a Store package when available and falls back to
  the exact stem when no path is readable, but a moved non-packaged install is a
  real limitation. A path target is exact by design; a folder-prefix rule would
  reintroduce the recursion problem.
- **Normalization is lexical.** It does not resolve symlinks, junctions, 8.3
  short names, or per-user drive mappings. Doing so would require filesystem
  access during matching, which is slower and can fail for protected processes.
- **Package metadata is best-effort.** Protected or unreadable processes return
  `None`; a packaged process then falls back to path or stem identity.
- **Linux behavior is only the test/preview path.** The real target is Windows;
  POSIX normalization exists so the pure core and mock UI can be tested here.
- **Tauri shell build still needs Windows.** The Linux host cannot compile the
  shell because of its `package.metadata`/webkit requirements, so the command
  contract was verified by the core tests and the mock UI, not by running the
  real desktop binary.

## 5. Verification (observed)

- `cargo test --all-targets` (in `companion/`): 282 passed across 5 suites.
- `cargo clippy --all-targets -- -D warnings`: no issues.
- `cargo fmt --all -- --check`: clean.
- `cargo check -p smartblocker-core --target x86_64-pc-windows-msvc`: passes
  (the Windows-only `windows-sys` features and `win_meta` code compile).
- `npm run typecheck`: clean.
- `npm run test:app-targets`: 8 passed (path folding, package/path/stem
  precedence, no substring/folder fallback, legacy contains, exact-before-legacy
  display, collision preview, deterministic keys/details).
- `npm run build:desktop`: succeeds.
- Mock UI in Chromium (`?mock=unlocked#apps` and `?mock=locked#apps`):
  picker shows path/package identity, exact and contains additions work,
  collision text appears, and the locked list disables removals while still
  allowing additions.
- **Not verified:** a real Windows run with live Store apps and a real update
  that moves an install. Those remain manual checks.
