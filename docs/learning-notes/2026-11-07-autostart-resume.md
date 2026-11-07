# Learning note — autostart-resume (auto re-enable after disabling blocking)

Date: 2026-11-07 · Scope: Phase 5 batch 1, roadmap item 4. Evidence:
`docs/audits/2026-11-07-cold-turkey-blocker-landscape-audit.md` §1.3
("Autostart blocks … closes the 'I forgot to turn my block back on' relapse
path"). Developed in the `f4-autostart-resume` worktree.

## 1. Problem / feature goal

Cold Turkey sells "Autostart Blocks": blocks that re-start themselves on
sign-in/wake, at a time of day, or at the next scheduled window. SmartBlocker
had *no* way to re-arm itself once the user flipped the master toggle off —
the classic relapse loop. This feature adds an **optional auto-resume**:
while the user has picked a resume mode and blocking is off, the extension
turns the master toggle back on automatically.

## 2. Key concepts

- **Derived state instead of persisted flags.** "Armed" is not a stored bit:
  `ARMED ⇔ settings.resumeMode !== 'off' && settings.enabled === false`.
  This follows the lock system's doctrine — MV3 service workers sleep and
  die, so correctness must always re-derive from stored values; alarms are
  promptness-only.
- **Promptness-only alarms** (borrowed from `lock-enforcer.ts`): the
  one-shot `resume-at` alarm can be missed or late without harm, because
  every service-worker (SW) start re-derives the target and fires overdue
  resumes immediately ("missed-while-asleep" semantics).
- **`storage.session` as a browser-session marker.** Session storage
  survives SW reaps but dies with the browser process, so
  *absent-at-SW-boot ≈ cold browser start*. That distinguishes a real
  browser start from a mid-session SW restart, which the WebExtensions API
  otherwise cannot tell apart.
- **Single-writer clamp.** The 24-hour cap on `resumeAt` lives in
  `setSettings` (the one settings choke point), not in the UI, so every
  writer — options page, popup, background, future surfaces — is covered.

## 3. What was built (in order)

1. **`src/shared/resume.ts`** (new, pure, erasable-syntax-only): mode
   normalization (unknown stored values degrade to `'off'`), the
   `clampResumeAt` write-clamp (invalid → null = disarm; >24h → now+24h),
   and `nextResumeAt` / `nextScheduleStart`. The schedule derivation
   deliberately consumes ONLY lock-math's *public* builders
   (`currentWindowEnd`, `nextBoundary`, `EMPTY_LOCK_STATE`) so the
   overnight/timezone rules stay single-sourced and mirrored with Rust.
   Trick: schedule windows are half-open `[start, end)`; while `t` is inside
   a window, `nextBoundary` returns its *end*, so we hop `t` to the end and
   re-ask. Once nothing contains `t`, the earliest boundary is provably a
   *start* (an end is only pushed with its own strictly-smaller start).
2. **`src/shared/settings.ts`** (additive): `resumeMode` (default `'off'`)
   and `resumeAt` (default `null`) on `Settings` + `DEFAULTS`, plus the
   centralized clamp in `setSettings`. Legacy installs pick up defaults via
   the existing spread-merge.
3. **`src/background/resume-enforcer.ts`** (new): the state machine.
   - FIRED → `setSettings({enabled: true, resumeAt: null})` + quiet OS
     notification. Guarded by a re-entrancy flag and the `enabled` re-check
     so racing triggers (alarm + onStartup + SW boot) are idempotent.
   - Never fires while **any** lock is active (`getLockStatus().settingsLocked`;
     locks enforce blocking anyway): a *timed* lock defers the resume to
     `lock.until + 1000`; an *indefinite password lock* drops it.
     The `setSettings` call is try/caught so it never fights the lock-throw.
   - CLEARED: a `storage.onChanged` listener sees `enabled` go false→true
     and nulls a stale `resumeAt` (mode survives for next time); also nulls
     it when the mode is set back to `'off'`. Auto-resume's own write
     already carries `resumeAt: null`, so the FIRED path no-ops here.
4. **`src/background/index.ts`**: `initResumeEnforcer()` called synchronously
   with the other listeners; it registers `runtime.onStartup` at SW top
   level (load-bearing MV3 constraint #4).
5. **`src/options/pages/BlockingPage.tsx`**: an "Auto-resume" group in the
   Protection section beside the master toggle — a Select (Off / On browser
   startup / At next scheduled block / At a specific time), a
   `datetime-local` input shown only for "time" (`min`/`max` set to now /
   now+24h), and a faint "Armed — …" status line while disabled. Saves go
   through `useOptionsState.save`, which already try/catches the lock-throw.
6. **`scripts/resume-test.mjs`** (new): 24 pure-math tests in the
   lock-math-test style — all modes, overdue-clamp (past instant → now),
   no-schedule → null, cap-to-24h, week wraparound, overlapping-window
   stacks, tz-pinned rules, inclusive/exclusive window edges.
7. Docs: CLAUDE.md (command + module bullets), design-notes.md §7 (the
   `#resume-mode` / `#resume-at` DOM-id contract), this note.

**The `.ts` extension wrinkle.** Node type-stripping resolves relative
imports only with explicit extensions (verified by probe on Node 24:
extensionless *runtime* imports fail; `import type` is erased before
resolution, which is why build-input.ts gets away with it). So `resume.ts`
imports `'./lock-math.ts'` WITH the extension, and `tsconfig.json` gained
one line: `"allowImportingTsExtensions": true` (requires `noEmit`, already
set; Vite resolves both forms — build confirms).

## 4. Decisions, alternatives, trade-offs

- **'startup' = next BROWSER session, not next SW boot.** A plain SW
  restart must not fire it: navigation wakes the SW constantly (the
  blocker's listeners run even while blocking is off), so
  fire-on-any-SW-boot would collapse "on browser startup" into "within
  minutes" and make the mode useless. Implementation: `runtime.onStartup`
  (primary, MV3-idiomatic) + the `storage.session` cold-boot marker as the
  catch-up for a browser start whose onStartup never reached us. The task
  spec floated "resume immediately on SW start"; I deviated deliberately and
  documented why — an SW wake is not observable as a browser start without
  a session marker, and the marker gives the honest distinction. Trade-off:
  an armed 'startup' resume does NOT fire if the browser stays open for
  days (correct per CT's sign-in semantics; 'schedule'/'time' cover
  day-scale control).
- **Notification is guarded, not permitted.** The task barred manifest
  edits, and neither manifest carries `"notifications"` — so
  `api.notifications` is `undefined` at runtime and the notification
  no-ops today (logged in code + CLAUDE.md). It lights up automatically if
  the permission is ever added. Text: "Blocking resumed automatically",
  `silent: true`.
- **'schedule' + currently-inside-a-window:** the user can't disable during
  a forced window (setSettings throws), but a window can *start* while an
  armed resume waits. The alarm then fires mid-window, sees
  `settingsLocked`, and defers to the window's end (+1s) — force-blocking
  covered the window, and the toggle flips on right after. Net UX equals
  CT's "resume at next scheduled block".
- **Overlapping-schedule stacks:** `nextScheduleStart` hops window *ends*
  with a generous iteration cap (`16 + 8 × rules.length`) that degrades to
  "inert" rather than looping on a pathological ruleset.
- Left open: popup doesn't show the armed state (only the options page);
  no e2e wiring (feature is storage/alarm-driven; Playwright suites were
  out of scope by spec).

## 5. Verification (observed)

- `node scripts/resume-test.mjs` → **24 passed, 0 failed**.
- `node scripts/lock-math-test.mjs` → 77 passed, 0 failed (lock-math
  untouched; cross-language fixtures still pass).
- `npm run typecheck` → clean (includes the new tsconfig flag).
- `npm run build` → chrome + firefox built; `resume-at`/`auto-resume`
  present in both background bundles, the UI strings in the options bundle.
- `npm run eval` → PASS, no regressions (15,874 cases; classifier surface
  untouched, as expected — run anyway per task).
- Note: `npm ci` in this environment needs `--ignore-scripts` (one
  postinstall reaches a blocked CDN at 127.0.0.1:443); all gates run fine
  without it.

Files: `src/shared/resume.ts`, `src/background/resume-enforcer.ts`,
`scripts/resume-test.mjs` (new); `src/shared/settings.ts`,
`src/background/index.ts`, `src/options/pages/BlockingPage.tsx`,
`tsconfig.json`, `CLAUDE.md`, `docs/design-notes.md` (touched).
