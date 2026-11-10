# Named profiles

Named profiles are an additive layer over the existing settings. They let one
install keep separate policy sets (categories, sites, rules, break/surrender
behavior and a native app association) and switch between them manually.

The key compatibility rule is simple: **the existing `settings` storage object
is the Default profile**. An install that never creates a named profile has
byte-for-byte the same storage it had before this feature.

## Scope

One profile is active at a time (`activeProfileId`; `null` = Default). The
active named profile replaces Default only for these fields
(`PROFILE_POLICY_FIELDS` in `src/shared/profiles.ts`):

- category `labels`, `blockedLabels`, `deletedBuiltinLabels`
- `blockThreshold`
- `whitelist`, `whitelistVersion`, `blocklist`
- `titleRules`, `channelBlocklist`, `channelAllowlist`
- `focusGoal`, `useTabContext`
- `blockAdult`, `maskSearchElements`
- `surrenderMode`
- `blockMessage` (the optional plain-text note on block screens)
- `breakMode`, `breakDelayMinutes`, `breakDurationMinutes`, `breakTextLength`

These stay global (`PROFILE_GLOBAL_FIELDS`) and are never overwritten by a
switch:

- `enabled` — switching profiles never turns blocking off
- `onboarded`
- `shareFeedback`
- `resolveEmbedTitles`
- `resumeMode`, `resumeAt`
- `notificationPrefs` (quiet reminder toggles and leads)
- `firstDayOfWeek`, `hour24` (display-only preferences)

Deliberately excluded from snapshots: lock state, password hash/KDF material,
local AI corrections/centroids, feedback, usage statistics, onboarding state
and any other runtime or secret state. A profile is a policy snapshot, not a
backup of the whole extension.

## Storage

| Key | Meaning |
| --- | --- |
| `settings` | Default profile and every global field. The single source of truth for global state. |
| `profiles:v1` | `{ version, activeProfileId, profiles, defaultAppBlocklist, defaultAppBlocklistUpdatedAt }` |

`src/shared/settings.ts` composes effective settings:

```
effective = stored Default/global fields
          + (active named profile's scoped policy, if any)
```

`setSettings()` splits a patch by scope. Scoped fields are written into the
active profile snapshot; global fields are written once into `settings`.
While Default is active, scoped fields are written into `settings` as before.
This keeps one source of truth for each field and avoids dual writes.

The in-memory caches of `settings.ts` and `profile-store.ts` invalidate on the
relevant `storage.onChanged` events, so the popup, options page, background
service worker and offscreen document converge without a reload.

## Validation and migration

`src/shared/profiles.ts` is pure (no browser APIs) and loaded directly by
`scripts/profiles-test.mjs` under Node type stripping.

- Missing, corrupt or unknown-version data becomes the empty state (Default
  active). An existing install therefore loses nothing.
- A v0 array or `{ profiles: [...] }` shape is upgraded in place.
- Duplicate ids get fresh ids, duplicate names get a numeric suffix, and the
  reserved name "Default" becomes "Default profile".
- Unknown/runtime fields are dropped; wrong-typed fields fall back to the
  caller's baseline.
- Policy defaults come from `config.ts` and `breaks.ts`, never pasted values.
- Bounds: 12 named profiles, 48-character names, 40 labels, 1,000 policy-list
  entries, 500 title rules, 300 channel rules, 500-character focus goal, and
  threshold 0.3–0.9.
- The v1→v2 whitelist migration and canonical-label migration live in
  `profiles.ts`, so Default and every named profile share one implementation.

Every operation accepts a `locked` flag. `createProfile`, `duplicateProfile`,
`renameProfile`, `deleteProfile` and `activateProfile` all refuse with
`code: 'locked'` while `settingsLocked`; `profile-store.ts` obtains that flag
from the real lock store before every mutation. Deleting the active profile
falls back to Default. Activation is always manual and explicit.

## Native app association

Each profile carries `appBlocklist` and `appBlocklistUpdatedAt`. Default's
association is `defaultAppBlocklist` / `defaultAppBlocklistUpdatedAt` in
`profiles:v1`. The companion remains the authority for its own enforced
config; the extension only associates that list with the active profile.

The bridge in `src/background/companion.ts` reconciles with
`reconcileAppBlocklist()`:

- equal lists are already converged (the stamps do not cause churn);
- a newer daemon stamp wins and is adopted into the active profile;
- a newer local stamp is pushed with `appBlocklistUpdate`;
- on a non-zero tie the daemon wins; on a 0/0 tie a non-empty local list is
  the user's first intent and is pushed, so a never-synchronized desktop list
  is never wiped by `[]`.

Synchronization runs on connect, on every companion status, after profile
storage changes, and on the 20-second heartbeat. The periodic retry also picks
up edits made in the desktop UI, which writes the daemon config directly.

Protocol additions (mirrored in `companion/crates/smartblocker-core/src/protocol.rs`):

- `CompanionStatus.appBlocklist?` / `appBlocklistUpdatedAt?` (optional for
  older daemons; an older daemon's absence leaves profiles untouched)
- `appBlocklistUpdate { appBlocklist, appBlocklistUpdatedAt }` from an
  authenticated extension

The daemon applies additions while `settingsLocked` and refuses removals,
preserving current entries and learning new ones. The Tauri
`set_app_blocklist` command applies the same rule rather than refusing a mixed
edit. Timestamps are monotonic (`max(now, incoming, current)`) so a later
activation cannot look older than an already-synchronized list.

## UI

`src/options/pages/ProfilesPage.tsx`, route `#profiles`:

- Default appears first and is clearly labeled the fallback.
- Named rows show the scoped summary and associated app count, with Activate,
  Duplicate, Rename and two-step Delete.
- Creating a profile copies the active policy and app association but does not
  switch to it.
- A global `#active-profile-banner` names the active profile on every page, so
  it is never ambiguous where an edit will land.
- While locked, all profile actions and the create control disable and show
  `#profiles-lock-note` with the real lock reason.
- The Desktop apps section shows the active association and connection state;
  apps are edited in the desktop app, not duplicated in options.

The stable DOM IDs are listed in `docs/design-notes.md` §7.

## Verification

```bash
npm run typecheck
node scripts/profiles-test.mjs
SB_SKIP_BUILD=1 node scripts/e2e-profiles.mjs   # after npm run build:chrome
cargo test -p smartblocker-core --lib
cargo test -p smartblocker-nm-host
```

`scripts/e2e-profiles.mjs` drives the real Chrome options page: create,
activate, the global banner, a scoped edit that leaves `settings` untouched,
duplicate, rename, two-step delete, locked disabling, and switching back to
Default. It writes `docs/audits/assets/2026-11-09-profiles.png`.

The full Rust workspace test currently requires `libdbus-1-dev`/`pkg-config`
for the Tauri shell; the core and NM-host crates have no such dependency.
