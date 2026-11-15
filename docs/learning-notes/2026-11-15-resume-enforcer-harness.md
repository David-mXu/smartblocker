# Testing the auto-resume enforcer without a browser: a Node harness over the real module

## The problem

The auto-resume feature ("autostart-resume", `src/background/resume-enforcer.ts`) argues its correctness from a state machine: settings are the source of truth, alarms are only for promptness, and every state is re-derived from storage on every event. Two events made that worth pinning directly:

- On 2026-11-14 fresh installs started shipping with `enabled: false` **pre-onboarding**, and the enforcer gained an onboarded gate (`readArmedPlan` returns `null` when `!settings.onboarded`, and `resumeNow` re-checks because the alarm-listener path bypasses the plan read). A gate in a background event handler is exactly the kind of thing that regresses silently: nothing throws, blocking just flips on when it should not.
- The feature had no dedicated harness. Its coverage was typecheck plus the pure math in `scripts/resume-test.mjs` (`src/shared/resume.ts`) — none of which executes the chrome-event wiring: alarms, `runtime.onStartup`, `storage.onChanged`, the `storage.session` cold-boot marker.

The goal: a `node scripts/resume-enforcer-test.mjs` that drives the **real** `resume-enforcer.ts` — including the genuine `settings.ts` and `lock.ts` it imports — with no source seam if possible.

## The core idea: mock the API at the global, import the module for real

`src/shared/api.ts` binds a single `api` object at **import time**:

```ts
export const api: typeof chrome =
  typeof browser !== 'undefined' ? browser : chrome;
```

That means the harness does not need to intercept module imports at all. It installs a plain-object `globalThis.chrome` **before** dynamically importing `src/background/resume-enforcer.ts`, and the whole import graph (enforcer → settings → lock → profile-store → …) runs against the mock through the same code paths production uses. `scripts/usage-stats-test.mjs` already proved this pattern for `usage-stats-tracker.ts`; this note applies it to an event-driven module with no exported constructor to drive — where every observable behavior is behind *listeners the module registers itself*.

Two prerequisites from the repo's Node-test conventions:

- **Relative `.ts` resolution**: production sources import each other extensionless (Vite style). A `node:module` `registerHooks` resolver retries every failing relative specifier with `.ts` appended — the same hook as in `usage-stats-test.mjs`.
- **No source changes were needed.** "Import at module level, mock at the global" fully replaces the seam; the enforcer's private functions (`syncResume`, `resumeNow`, `readArmedPlan`) are all reachable through the three listeners (`alarms.onAlarm`, `runtime.onStartup`, `storage.onChanged`) plus the init boot block — which is precisely the production surface.

## The three design problems and how the harness solves them

### 1. The enforcer fires async chains and forgets them

Nearly every entry point is `void (async () => …)()` — the alarm listener, the init boot block, the storage-change handler. A test that awaits its own `emit()` has *not* awaited the enforcer. Worse, the enforcer's own writes wake its own `storage.onChanged` listener, so chains re-enter themselves (idempotently — that is part of what gets pinned).

The harness wraps **every mocked async method** in a `track()` helper that keeps a global `pending` counter above zero while any mock call is in flight. Because each chain's first operation is always a storage or alarms call, a chain that has been spawned but not finished always holds at least one tracked promise. `settle()` then drains macrotask-by-macrotask (`setImmediate`) until `pending` reaches zero and *stays* zero across one further quiet macrotask (post-`await` tails can issue new calls). Terminates iff the enforcer is loop-free — a free tripwire.

### 2. A module remembers its listeners; tests re-run `initResumeEnforcer`

`initResumeEnforcer()` is the module's export: it registers listeners and runs a boot block that reads the cold-boot marker. Simulating an SW boot means calling it again — but every call *appends* another listener set, so later events would fan out to the whole stack and count-based assertions would rot.

The harness's `swBoot()` distinguishes the first call (keep the listeners — they are the production surface under test) from later ones: snapshot listener-array lengths, call init, then **truncate the arrays back** to remove only the copies this call registered. The boot block still ran; the permanent set stays exactly one. The module caches in `settings.ts`/`lock.ts` sit at fixed earlier indices and are untouched. This keeps deltas like "the alarm fire creates exactly one replacement alarm" exact.

### 3. Cache freshness and change-notification reality

The mocked `storage.local.set` does what real Chrome does: emits `storage.onChanged` with cloned `oldValue`/`newValue` diffs — including for the enforcer's **own** writes. That is load-bearing twice over: it invalidates the module-level in-memory caches in `settings.ts`/`lock.ts` (a stale cache would serve the previous settings for the rest of the run), and it exercises the re-entrant idempotence the state machine promises. Seeds go in through a `putCrossContext()` helper that writes the map directly and emits the same diff shape — modeling the options page or popup writing from another context, which is the only thing the enforcer can actually observe. A controlled `Date.now()` (leaving `new Date(t)`-style schedule math to `TZ=UTC` determinism) lets tests jump across resume instants and lock ends.

## What the harness pins (observed behavior, not intent)

Each assertion is a delta of write/`toggle`/alarm-operation counters, so only the enforcer's own actions count (raw seeds bypass them):

1. **Onboarded gate, both paths.** A pre-onboarding install with a fully-armed-looking plan arms nothing, toggles nothing, preserves the plan; a stale fired alarm bails, clears, and writes nothing. The identical state on an onboarded install arms at the exact stored instant and fires normally. Unknown modes normalize to `off`.
2. **Lock deferral.** A timed lock re-arms the one-shot alarm at `lock.until + 1000` with zero settings writes; an indefinite password lock (until `null`) clears the alarm instead, and the plan survives in settings — after the unlock, the *lockState change listener's* `syncResume` fires the overdue plan (one enabling write). Subsequent lock churn toggles nothing.
3. **Startup semantics.** `runtime.onStartup` fires armed `startup` plans (and nothing for `time` plans); an SW reap with the `storage.session` marker present stays inert; a cold boot (session storage wiped) fires via the boot catch-up and recreates the marker.
4. **Missed-while-asleep + disarm.** Future instants arm exactly; overdue instants fire at the next sync. A manual re-enable performs exactly one disarm write (`resumeAt → null`, mode kept), a subsequent stale alarm writes nothing, and a fresh disable+instant re-arms exactly once (a null instant never arms).
5. **Schedule targeting.** The alarm lands on `nextScheduleStart`'s real window start — a 15-minute settings-lock lead does not move it — a mid-window fire defers to window end + 1s (the schedule is itself a settings lock), and the resume completes after the window.

One subtlety worth remembering: `syncResume` still **arms** time-mode alarms while locked (arming is harmless; only firing is gated). Two harness failures on the first run were this exact behavior leaking into count deltas — the fix was to snapshot after the lock seed, not to change the source.

## Alternatives and tradeoffs

- **A test seam (injectable `api`)** was allowed if import failed — it did not, so no source line changed. Keeping production import-shaped is worth more than a marginally cleaner mock.
- **Playwright e2e** exercises the real SW but cannot jump a clock or observe alarm `when` values; the Node harness complements the battery rather than replacing it.
- **Fan-out truncation** assumes later SW boots only need their boot block, not extra live listeners. If a future test needs two *live* SW generations, the helper needs a rethink — the current tests do not.

## Verification

- `node scripts/resume-enforcer-test.mjs` — **18 passed, 0 failed** (after the two snapshot-placement fixes documented above).
- `node scripts/resume-test.mjs` (pure `shared/resume.ts` core) — 25 passed, 0 failed, unchanged.
- `npm run typecheck` — clean (`tsc --noEmit`, the harness is `.mjs` and needs no TS).
- `git`: only `scripts/resume-enforcer-test.mjs` added; zero changes under `src/`.
