# Named profiles: additive policy snapshots without breaking existing installs

## The problem

SmartBlocker had exactly one settings object. Everything — categories, allowed
sites, block rules, title/channel rules, break settings, adult blocking and the
desktop app blocklist — belonged to that single global policy. Users wanted
named profiles (for example Work and Evening) that could be switched manually,
without losing the configuration they already had.

The hard constraint was compatibility: an existing install must keep behaving
and storing data exactly as before until the user explicitly creates and
activates a profile. A naive design ("move settings into profiles") would
rewrite every install's storage and risk losing settings during migration.

## The model

### Default is not a copied profile

The existing `settings` storage key *is* the Default profile. `profiles:v1`
holds only named snapshots and the active id:

```text
settings      -> Default policy + every global field
profiles:v1   -> { activeProfileId, profiles[], defaultAppBlocklist, ... }
```

With no `profiles:v1` key, the active id is `null` and `settings` is read
exactly as before. Creating a named profile copies a policy snapshot, but does
not activate it and does not touch `settings`.

### Scope split, not a full copy

A profile replaces Default only for the fields listed in
`PROFILE_POLICY_FIELDS` (`src/shared/profiles.ts`). Everything else stays
global. The most important global field is `enabled`: switching to a profile
can never silently pause blocking. Others include onboarding, feedback
sharing, oEmbed resolution and auto-resume.

Effective settings are composed on read:

```text
effective = stored Default/global fields + active profile's scoped policy
```

On write, `setSettings()` splits the patch by scope. A scoped edit goes into
the active profile snapshot; a global edit goes once into `settings`. This
avoids two sources of truth for the same field. While Default is active, the
old write path is unchanged.

Lock state, passwords/KDF material, corrections, centroids, feedback, usage
statistics and onboarding state are deliberately not in a profile. They are
runtime or secret state, not policy.

### Versioned reads, never throws

`sanitizeProfilesState()` accepts missing, corrupt or older-shaped data and
returns a usable state. It repairs duplicate ids/names, reserves the name
"Default", drops unknown fields and clamps every bounded list/number. The
v1→v2 whitelist migration and canonical-label migration moved into
`profiles.ts` so Default and named profiles use one implementation.

### Lock semantics

Every profile operation takes an explicit `locked` flag. Create, duplicate,
rename, delete and activate return `code: 'locked'` while settings are locked.
`profile-store.ts` obtains the flag from the real lock store before each
mutation, and the UI disables the controls with the real lock reason.

Activation is the dangerous one: replacing a policy during a lock could weaken
it. Refusing the switch is the conservative choice. Deleting the active
profile falls back to Default, which is also refused while locked.

A raw storage write from devtools can still bypass this, exactly like every
other soft-lock setting. The desktop companion remains the hard enforcer.

### Native app association and timestamps

A profile also carries `appBlocklist` and `appBlocklistUpdatedAt`. The
companion owns the enforced list in its config; the extension associates that
list with whichever profile is active.

The two sides converge with `reconcileAppBlocklist()`:

- equal lists: already converged, regardless of stamps;
- daemon stamp newer: adopt into the active profile;
- local stamp newer: push `appBlocklistUpdate`;
- non-zero tie: daemon wins;
- 0/0 tie with a non-empty local list: push, because a never-synchronized
  desktop list must not be wiped by `[]`.

Activation bumps the timestamp only for an association that has synchronized
before. A never-synced association stays at 0, so an existing desktop list can
populate it on first connect instead of being replaced.

The daemon applies additions while locked and keeps every current entry;
removals wait. The Tauri app-list command uses the same union rule, so adding
an app still works mid-lock.

## Implementation trail

1. **Read the existing contract first.** `settings.ts`, `lock.ts`,
   `useOptionsState.ts`, `companion.ts`, `companion-protocol.ts` and the Rust
   `protocol.rs`/`daemon.rs`/`store.rs` defined the constraints. The lock
   import direction (`settings` → `lock`, never the reverse) ruled out putting
   profile logic inside `lock.ts`.
2. **Made the pure core testable.** `src/shared/profiles.ts` has no browser
   APIs and uses erasable TypeScript syntax, so Node can load it directly. This
   is why the bounds, migrations, duplicate repair, activation and timestamp
   reconciliation have fast unit tests without a browser.
3. **Added a thin store.** `src/shared/profile-store.ts` owns
   `storage.local`, the cache, and the real lock check. `settings.ts` composes
   effective settings and routes scoped writes. This kept policy logic out of
   storage code and storage code out of the pure core.
4. **Built the UI around explicit state.** The Profiles page shows Default
   first, named rows with summary/app count, create/duplicate/rename/delete/
   activate, and a lock note. A global banner names the active profile on every
   page, because otherwise a user editing Sites could not tell which snapshot
   they were changing. The DOM IDs are recorded in `docs/design-notes.md` §7.
5. **Extended the companion additively.** `CompanionStatus` gained optional
   app-list fields; the extension gained `appBlocklistUpdate`; the daemon and
   Tauri command normalize, union while locked, stamp monotonically and
   broadcast status. Older daemons simply omit the fields, and older extensions
   ignore them.
6. **Tested the failure cases on purpose.** The Node suite includes corrupt
   state, duplicate ids/names, max profiles, oversized lists, runtime-field
   leakage, mutation while locked, a 0/0 app-list tie and a profile switch back
   to Default. The Chrome e2e checks that a scoped Sites edit lands in the
   active profile and *not* in `settings`.

## Alternatives and tradeoffs

- **Copy the whole settings object into every profile.** Simpler composition,
  but a profile switch could silently change `enabled`, onboarding or
  auto-resume, and global edits would need fan-out to every profile. Rejected
  in favor of the scoped overlay.
- **Make named profiles the only storage shape and migrate Default into one.**
  Cleaner long-term, but rewrites every existing install's storage and makes
  rollback risky. Rejected for additive compatibility.
- **Let activation happen during a lock.** Convenient, but a profile could
  weaken categories/sites mid-commitment. Rejected; activation is manual and
  lock-guarded.
- **Have the extension own the desktop app list outright.** Would duplicate the
  companion's config and create two authorities. Rejected; timestamps and the
  daemon's additions-only rule keep one enforced copy.
- **Mark a local push as synchronized immediately.** Tempting, but the daemon
  has not acknowledged it yet. The implementation leaves the local stamp
  unchanged and lets the authoritative status response settle it. This makes
  failed pushes retry naturally on the next heartbeat.

## Verification

Observed locally on 2026-11-09:

- `npm run typecheck` — passed.
- `node scripts/profiles-test.mjs` — 17 passed, 0 failed.
- `node scripts/e2e-profiles.mjs` — 24 Chrome UI checks passed; screenshot at
  [`docs/audits/assets/2026-11-09-profiles.png`](../audits/assets/2026-11-09-profiles.png).
- `cargo test -p smartblocker-core --lib` — 262 passed.
- `cargo test -p smartblocker-nm-host` — 2 passed.
- `cargo test --workspace` — blocked by the environment's missing
  `libdbus-1-dev`/`pkg-config` for Tauri, not by a Rust test failure.

The scoped-edit e2e reads both storage keys after editing the Sites page and
asserts that `settings.whitelist` is unchanged while the active profile's
policy contains the new site. That is the decisive check for the "no duplicated
source of truth" requirement.

## Files worth reading

- [`src/shared/profiles.ts`](../../src/shared/profiles.ts) — schema, bounds,
  migration, operations, reconciliation.
- [`src/shared/profile-store.ts`](../../src/shared/profile-store.ts) — browser
  storage and lock guard.
- [`src/shared/settings.ts`](../../src/shared/settings.ts) — effective
  composition and scoped write routing.
- [`src/options/pages/ProfilesPage.tsx`](../../src/options/pages/ProfilesPage.tsx)
  — the UI.
- [`src/background/companion.ts`](../../src/background/companion.ts) and
  [`companion/crates/smartblocker-core/src/daemon.rs`](../../companion/crates/smartblocker-core/src/daemon.rs)
  — app-list convergence.
- [`docs/profiles.md`](../profiles.md) — the reference contract.
