# Cold Turkey parity pass — shipped surfaces and verification

**Date:** 2026-11-10 · **Revision verified:** `8ea446e` · **Status:** shipped
on `main`, local only (not pushed).

This closes the Phase 5 parity pass opened by
[2026-11-07-cold-turkey-blocker-landscape-audit.md](2026-11-07-cold-turkey-blocker-landscape-audit.md).
It records what shipped, the exact checks observed on the merged tree, the
flakes seen while running them, and what still requires real Windows hardware.

---

## 1. What shipped

| Surface | Behavior | Commit(s) |
| --- | --- | --- |
| **Now / Next / Relief dashboard** (`#dashboard`) | Truthful aggregate lock end, timer/focus/focus-hours reasons, next scheduled transition, pending focus commit and undo, relief scope, live timeline, companion health, active profile name. No page URL/title leaves the dashboard. | `2bd2f83`, `c9ce502` |
| **Quiet reminders** (`#notifications`) | Three independent, silent, off-by-default reminder classes with per-class lead times; no remote push. | `1c36177` |
| **Schedule preferences + per-rule lead** | First day of week and 12/24-hour display preferences; per-focus-hours “lock settings before the window” lead (1–1,440 min), mirrored into the Rust evaluator and dashboard. | `bccb74d`, `7baa385` |
| **Named profiles** (`#profiles`) | Additive policy snapshots over the existing `settings` object. `settings` remains the Default profile; one profile is active at a time. Scoped policy overlays Default at read time; globals (blocking enabled, reminders, display prefs, resume) stay global; corrections stay device-global. | `660cdcd`, `7baa385` |
| **Protection and usage analytics** (`#usage`) | Local-day, idle-aware per-site/category counters, protection ratio, override rate, block reasons, 7/35-day views, aggregate JSON export. Computed from tab events, not history. | `eefc541` |
| **Desktop app usage** (companion) | Local-only foreground tracker separate from browser stats and `events.log`; bounded/versioned state; empty/unavailable/error states. | `76d0ae2` |
| **Typed desktop app identity** | Exact executable stem, normalized full path, and Store package family name alongside the legacy substring list; legacy entries never auto-migrate. | `8c15322` |
| **Opt-in productive-work rewards** | Only confident classifier `allowed` verdicts earn; whitelisted pages and blocks do not; bounded accrual. | `c069a3b` |
| **Versioned backup/restore** (`#backup`) | Schema-v1 export, strict envelope, repaired contents with warnings, deterministic serialization, merge/replace preview and apply, lock refusal, bounded pre-restore slot. | `b2e964b`, `7d9ceb1` |
| **Desktop startup + configurable extension-loss grace** | Autostart switch and persisted 15–300 s grace (default 60 s) read by the enforcer, with an immediate daemon→extension status publish on change. | `5d502af` |
| **Schedule overlap + duplicate UX** | Half-open weekly overlap reporting (overnight/week-wrap/timezone pins), quiet non-blocking notice, one-click duplicate with fresh id and `(copy)` label. | `e89bd44` |
| **Cross-language schedule label contract** | Optional display-only `label` preserved through TS sanitize, Rust sanitize/serialize, merge canon, backup, and UTF-16-capped consistently on both sides. | `36e411c`, `75d773e`, `4f09f84` |
| **Allowance / partner reliability** | Snapshot reconciliation with one durable writer, receipt-window handling, late-commit mirroring, partner arm pin outside generic lock state, serialized pin seeding, durable live replay tombstones. | `85a23a5`, `47f1dd1`, `8ea446e` |

Entry points: `docs/profiles.md`, `docs/backup.md`,
`docs/design-notes-desktop.md`, and the learning notes linked in §5.

---

## 2. Verification matrix (observed)

Environment: WSL2 (`Linux 5.15.167.4-microsoft-standard-WSL2`), Node
`v24.22.2`, npm `11.19.1`, Rust/cargo `1.96.1`, Playwright `1.60.0`
(Chromium channel), `x86_64-pc-windows-msvc` target installed. All commands
ran on `8ea446e` against a clean worktree unless noted.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **pass**, no diagnostics |
| Pure Node suites | **35 suites, 721 checks, 0 failed** |
| `npm run build:chrome` | **pass** |
| `npm run build:firefox` | **pass** |
| `npm run build:desktop` | **pass** (desktop frontend; not the Tauri executable) |
| `npm run eval` | **PASS: no regressions** — 15,874 cases; top-1 95.4%, productive FP 0.4%, must-block recall 97.6%, collateral FP 0.0%, decision accuracy 98.7%, all unchanged |
| `cargo test` (default members) | **322 passed, 0 failed** — 316 core unit, 4 shared fixtures, 2 nm-host/daemon |
| `cargo clippy --all-targets -- -D warnings` | **pass** |
| `cargo fmt --all -- --check` | **pass** |
| `cargo check --target x86_64-pc-windows-msvc` | **pass** (compile check only) |
| Real Chromium e2e | **13 suites, 353 checks, 0 failed** on the final revision |

### Pure suites (35)

| Suite | Checks | Suite | Checks |
| --- | ---: | --- | ---: |
| `allowance-activity-test` | 3 | `allowance-boundary-test` | 4 |
| `allowance-bridge-test` | 18 | `allowance-math-test` | 28 |
| `allowance-relief-test` | 6 | `allowance-state-test` | 13 |
| `allowance-store-test` | 11 | `app-targets-test` | 8 |
| `backup-test` | 18 | `blocker-policy-epoch-test` | 4 |
| `breaks-test` | 14 | `category-relief-guard-test` | 8 |
| `category-schedule-math-test` | 17 | `companion-background-test` | 14 |
| `companion-blocking-test` | 10 | `companion-idle-storage-test` | 1 |
| `dashboard-test` | 19 | `focus-cycle-test` | 14 |
| `force-redirect-rule-test` | 4 | `grace-math-test` | 24 |
| `lock-math-test` | 180 | `lock-types-test` | 24 |
| `notifications-test` | 33 | `partner-pin-test` | 8 |
| `partner-protocol-test` | 5 | `preferences-test` | 6 |
| `profiles-test` | 17 | `resume-test` | 25 |
| `reward-accrual-test` | 16 | `rta-test` | 17 |
| `rules-test` | 65 | `schedule-overlaps-test` | 23 |
| `surrender-test` | 12 | `usage-stats-test` | 30 |
| `wildcards-test` | 22 | | |

`companion-idle-storage-test` prints one named check rather than a count; it is
included as 1.

### Real Chromium suites (13)

| Suite | Checks | What it proves |
| --- | ---: | --- |
| `e2e-test` | 29 | Extension boots, model loads, real pages block/allow, popup path |
| `e2e-dashboard-test` | 29 | Live dashboard data, profile name, timeline, lock reactivity, mobile width, privacy |
| `e2e-backup` | 53 | Export, file import, preview, merge/replace, lock refusal, pre-restore recovery |
| `e2e-profiles` | 24 | Profile create/switch/delete, scoped overlay, globals preserved, lock guard |
| `e2e-schedule-ux` | 29 | Overlap notice/silence/live update, duplicate persistence, lock-disabled controls |
| `e2e-schedule-prefs` | 24 | First-day/24-hour rendering and focus-hours lead behavior |
| `e2e-notifications` | 17 | Reminder toggles, leads, silence, persistence |
| `e2e-usage-ui` | 33 | 7/35-day views, site/category tables, export, empty states |
| `e2e-reward-test` | 16 | Earn only on confident productive verdicts, daily cap, fallback authority |
| `e2e-partner-test` | 15 | Signed arm/release, replay refusal, UI never shows private material |
| `e2e-allowance-test` | 11 | Category allowance grant/relief, deterministic block immunity, fallback |
| `e2e-allowance-daemon-test` | 9 | Real Chromium + nm-host + daemon + second authenticated client |
| `e2e-companion-test` | 64 | Real Linux companion loop: pairing, ordinary blocking round-trip, locks, schedules, app kill, grace |

All e2e suites use Playwright's Chromium channel with the built
`dist/chrome` extension. The two daemon suites build and run the real Rust
nm-host/daemon; they are Linux evidence, not Windows evidence.

---

## 3. Flakes observed, and how the pass was reached

The final `8ea446e` pass needed **no reruns**: all 13 suites passed in one
invocation each, with the companion suite starting from freshly cleared
extension settings. Earlier runs at `47f1dd1` exposed two flaky areas; they are
recorded here because they will recur on this host.

- **Allowance fallback e2e.** One run failed
  `baseline blocked label blocks before any grant` after the service worker
  logged `Page failed to load.` and the poll timed out. An unchanged rerun
  passed **11/11**. This is the same YouTube page-load timing flake seen in
  earlier parity work; no root cause is claimed.
- **Companion e2e.** The first run after the merges reached only **36/64**:
  the native-messaging relay never connected, so every connection-dependent
  check failed while direct socket/CLI checks passed. A relaunch reached
  **63/64**, failing only the “fresh daemon initializes from authenticated
  hello” check because the reused `.e2e-profile` still had `enabled: false`
  from the aborted run, while the check assumes a fresh install's default
  `true`. Another run reached **63/64**, failing a different block-screen
  removal assertion (a completed classifier rescue did not clear the visible
  block screen within the poll). Moving only the extension's
  `Local Extension Settings` directory aside (preserving the cached model) and
  rerunning produced **64/64**. This is test-profile carry-over plus one
  block-screen timing race, not a lock/enforcement regression.

For a deterministic companion run, clear extension settings first (§6). No
failures were suppressed or retried inside a run; every rerun was a fresh
suite invocation.

---

## 4. Manual Windows limits

The following are **not** claimed by this pass. They need a real Windows
machine and, where noted, the Tauri shell.

1. **Tauri executable.** The shell crate cannot compile on this Linux host:
   `pkg-config`, WebKitGTK, libsoup, and `libdbus-1-dev` are missing. Only the
   desktop frontend (`npm run build:desktop`) and the core/nm-host/daemon
   workspace were built. Command signatures and handler registration were
   reviewed, but the window, tray, and installer were not run.
2. **Autostart.** The registry write/readback behind the Startup switch, its
   behavior across reboot, and its interaction with “Repair” were not
   exercised. `set_autostart` deliberately returns the OS readback, so a
   plugin/registry failure surfaces as an error rather than false success.
3. **Extension-loss grace boundaries.** Unit tests cover the config clamp,
   mid-track duration change, and close boundary. Real browser closes at
   15 s/60 s/120 s/300 s, reconnect cancellation, and notification timing on
   Windows were not observed.
4. **Native messaging + Store identity.** Real Chrome/Edge/Firefox manifest
   registration, Store package identity, foreground app detection, typed
   Store package matching, and per-browser repair remain manual.
5. **Windows target check.** `cargo check --target x86_64-pc-windows-msvc`
   proves the workspace compiles for the target; it does not prove service
   behavior, ACLs, file locks, Task Manager behavior, or installer behavior.
   The acceptance matrix in
   [../design-notes-windows-verification.md](../design-notes-windows-verification.md)
   remains the authority for those rows (Phase 5 item 12).

---

## 5. Residual scope and deliberate exclusions

- **Profiles are policy overlays, not full snapshots.** They exclude lock
  state, password/KDF material, corrections/centroids, feedback, usage,
  onboarding, and runtime state. Typed desktop app targets live in the
  companion's local config; profile app association still manages the legacy
  `appBlocklist` names only.
- **Backup is configuration only.** It excludes secrets, runtime/lock state,
  typed desktop targets, and usage data. Imported `resumeAt` is clamped to the
  existing 24-hour horizon.
- **Older companions may drop the optional schedule label** on reverse-sync.
  New builds preserve it; evaluation never reads it.
- **Timezone pins are fixed offsets**, so a window can drift one hour across a
  DST change. This is documented in both lock-math implementations.
- **Deferred parity items:** Device Blocks, deep Windows anti-tamper controls,
  granular global-password tab restrictions, folder/window-title app matching,
  and `file://` blocking. These remain roadmap work, not silent claims.
- **Firefox and Windows runtime breadth.** Chrome and Firefox builds pass;
  the real-browser matrix here is Chromium on Linux. The Firefox XPI suites
  are separate and were not part of this final pass.

---

## 6. Reproduce

```sh
npm run typecheck
for f in scripts/*-test.mjs; do
  case "$(basename "$f")" in e2e-*|smoke-test.mjs) continue;; esac
  node "$f" || exit 1
done

npm run build:chrome
npm run build:firefox
npm run build:desktop
npm run eval

SB_SKIP_BUILD=1 node scripts/e2e-dashboard-test.mjs
SB_SKIP_BUILD=1 node scripts/e2e-backup.mjs
SB_SKIP_BUILD=1 node scripts/e2e-profiles.mjs
node scripts/e2e-schedule-ux.mjs
node scripts/e2e-schedule-prefs.mjs
node scripts/e2e-notifications.mjs
node scripts/e2e-usage-ui.mjs
node scripts/e2e-reward-test.mjs
node scripts/e2e-partner-test.mjs
node scripts/e2e-allowance-test.mjs
node scripts/e2e-allowance-daemon-test.mjs
node scripts/e2e-companion-test.mjs

cd companion
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
cargo check --target x86_64-pc-windows-msvc
```

For a deterministic companion run after an interrupted one, move the
extension's storage directory aside first (the model cache survives):

```sh
mv ".e2e-profile/Default/Local Extension Settings/dhbhbhhcjkfdkfbloeaeedndfjfadajh" \
   /tmp/smartblocker-extension-settings-backup
```

---

## 7. Evidence index

- [2026-11-09-now-next-relief-dashboard.md](../learning-notes/2026-11-09-now-next-relief-dashboard.md)
- [2026-11-09-notifications-parity.md](../learning-notes/2026-11-09-notifications-parity.md)
- [2026-11-09-schedule-prefs-lock-lead.md](../learning-notes/2026-11-09-schedule-prefs-lock-lead.md)
- [2026-11-09-named-profiles.md](../learning-notes/2026-11-09-named-profiles.md)
- [2026-11-09-usage-protection-analytics.md](../learning-notes/2026-11-09-usage-protection-analytics.md)
- [2026-11-09-desktop-usage-analytics.md](../learning-notes/2026-11-09-desktop-usage-analytics.md)
- [2026-11-09-app-target-identity.md](../learning-notes/2026-11-09-app-target-identity.md)
- [2026-11-09-productive-work-rewards.md](../learning-notes/2026-11-09-productive-work-rewards.md)
- [2026-11-09-backup-restore.md](../learning-notes/2026-11-09-backup-restore.md)
- [2026-11-10-desktop-autostart-and-configurable-grace.md](../learning-notes/2026-11-10-desktop-autostart-and-configurable-grace.md)
- [2026-11-10-schedule-overlap-warning-and-duplicate.md](../learning-notes/2026-11-10-schedule-overlap-warning-and-duplicate.md)
- [2026-11-10-item10-bridge-focus-resilience.md](../learning-notes/2026-11-10-item10-bridge-focus-resilience.md)
- [2026-11-08-idle-aware-usage-statistics.md](../learning-notes/2026-11-08-idle-aware-usage-statistics.md)
