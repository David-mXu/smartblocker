# Whitelist safe-allow anchor and the backup spread path

## The problem

SmartBlocker exempts whitelisted sites from classification entirely — a
whitelist entry is an **allow** rule, the strongest thing the product stores.
Runtime verification (2026-11, before this fix) showed that a user-enterable
bare host glob like `*a*` passed every validation layer:

```
isValidWildcardWhitelistEntry('*a*') → true
isWhitelisted('https://facebook.com/', ['*a*'])          → true
isWhitelisted('https://store.steampowered.com/app/1', ['*a*']) → true
isWhitelisted('https://nasa.gov/', ['*a*'])               → true
```

`*com` was even broader: it matched **every** `.com` host, because the
anchored match only required the host to *end* with the literal "com". A
second, quieter copy of the same hole existed in the backup import: any text in
an imported file's `whitelist` arrays was unioned into settings with no
grammar check at all, so a crafted backup could spread the same glob into
every profile without ever touching the editor's validation.

## Root cause and concepts

- **Allow vs. block asymmetry.** A sloppy *block* rule overreaches and blocks
  an extra page — annoying, recoverable, loud. A sloppy *allow* rule silently
  disarms the whole product. Allow grammars need stricter anchors than "looks
  structurally plausible".
- The wildcard grammar in `src/shared/titles.ts` had two gates for
  scheme/path rules (`kind: 'url'`): `isHostGlob` (label *shape*: lengths,
  charset, no empty labels) and `hasLiteralHostConstraint` (a *safe-allow
  anchor*: the rule must be pinned to a complete literal DNS host). Host-only
  rules (`kind: 'host'`) ran only the shape gate. One alphanumeric character
  anywhere — `a` — satisfied it, so `*a*` parsed to a "valid" rule that
  anchored on nothing.
- The anchor philosophy already in the codebase: **take the text after the
  last `*`; it must be a fully-qualified literal host** (`something.tld`
  multi-label, final label ≥ 2 chars, or `localhost`). That guarantees a glob
  carves out at most one registrable domain family (`*.example.com`,
  `foo*.example.net`), never "everything sharing a few characters".

## What was changed

### 1. `src/shared/titles.ts` — the grammar itself

In `parseWhitelistWildcard`, after the unchanged `*.example.com` suffix-sugar
branch, a host-only glob must now pass the same `hasLiteralHostConstraint`
gate URL rules always used. Exact new rule, in words:

> A star-bearing host-only allow entry is valid only if the text after its
> last `*` is a complete star-free literal DNS host (multi-label, final label
> ≥ 2 characters, e.g. `.example.com`), or — for star-free oddities left after
> fragment stripping — the whole entry is a literal host.

Previously accepted shapes that now reject: `*a*`, `*.co*`, `*e*st*`,
`*.*foo`, `*com` (all of .com), `a*`, `*a`, `*mail*`, `google.*` (any TLD),
`*.example.*` (example in *every* TLD — deliberately rejected: the safe
direction, and `https://example.*/`-style URL rules were already rejected for
the same reason). Still accepted: `*.example.com`, `foo*.example.com`,
`*example.com`, `*localhost`, and every plain star-free hostname (those never
enter the wildcard parser; they keep legacy domain+subdomain semantics).

Because `src/shared/domains.ts` `normalizeDomain` already routes star-bearing
input through `isValidWildcardWhitelistEntry`, the ListEditor's existing
"needs a specific website host with its wildcard" error surfaces with no UI
change. And since the runtime matcher (`matchingWhitelistEntries`) parses
stored rules through the same function, legacy over-broad entries already in
storage silently stop matching — stricter, never looser.

### 2. `src/shared/backup.ts` — the spread path

New helper `safeWhitelistEntries` filters every whitelist entry through
`isValidWildcardWhitelistEntry` (star-free entries untouched). It runs on
**every import spread path**: the merge union (both the imported side and the
already-stored side), brand-new imported profiles, and the replace path for
the default settings and each named profile. Dropped entries produce a warning
string in the existing drop-and-warn style —
`Dropped the allowed-site wildcard “*a*” from the imported backup; it exempts
far more than one site.` — which flows into `BackupAppliedState.warnings`
and therefore the import preview, matching how the file already reports
schedule/profile repairs. The gate fires at *apply*, not *parse*: the parsed
document keeps the entry so the preview can show it being dropped.

### 3. `scripts/backup-test.mjs` — the exhaustiveness tripwire

`BACKUP_GLOBAL_FIELDS` in `backup.ts` was one-directional: the `tsc`
`satisfies readonly (keyof Settings)[]` on it catches "a listed field no
longer exists on Settings", but the reverse direction — a future Settings
field nobody adds to the backup list — meant the field silently never entered
backups.

`settings.ts` imports browser APIs, so it can't be imported under Node type
stripping — instead the test reads the file's source text and parses the keys
out of `export interface Settings { … }` (a deliberate, self-checking runtime
mirror: entries and declarations must agree in *both* directions, and the
hand-run simulation below confirmed a hypothetical new field trips it). The
assertion: every Settings key must belong to `PROFILE_POLICY_FIELDS`
(policy-carried), `BACKUP_GLOBAL_FIELDS` (backup-carried global), or the one
documented exclusion `onboarded` (transient wizard state, see
`docs/backup.md`). Missing membership in either direction fails the test.

## Alternatives and tradeoffs

- **Reject at match time only?** That alone fixes blocking today (and is what
  makes the change safe for rules already in storage), but the editor and
  import would still *accept* the entry, leaving an inert rule the user
  believes works. Both layers fixed.
- **Gating the local side of the merge union** silently deletes a stored
  legacy entry on the next import. Chosen deliberately: the entry is inert
  after fix 1 anyway, the action is always accompanied by a warning, and
  keeping it would let a crafted backup launder an old hole back in.
- **`*.example.*`**: could have been kept (it names one domain across TLDs),
  but it fails the stated anchor rule and its URL-rule twin was already
  rejected; rejecting is strictly the safe direction. Rejected here; revisit
  only with real user demand.

## Verification

All observed directly, in this order:

1. Pre-fix live check (Node one-liner against the real `titles.ts`) — the
   misleading `true`s quoted in the problem section.
2. `node scripts/wildcards-test.mjs` — 25 passed (22 existing + 3 new:
   over-broad never validate/match/enter the editor; confirming-allow shapes
   survive; every `DEFAULT_WHITELIST` sentinel entry is star-free and still
   exempts its hosts, while SERPs stay classified).
3. `node scripts/backup-test.mjs` — 24 passed (19 existing + 5 new: parse
   keeps holes, gate applies default+profile files, gate applies local
   entries, replace+preview warn, safe globs survive; plus the
   BACKUP_GLOBAL_FIELDS exhaustiveness tripwire). A simulated extra Settings
   key (`hypotheticalNewGlobal`) was confirmed to trip the new test.
4. `node scripts/rules-test.mjs` — 65 passed; `node scripts/rta-test.mjs` —
   17 passed (titles.ts is load-bearing for both import graphs).
5. `npm run typecheck` — clean. (One transient failure mid-run came from a
   concurrent teammate's in-progress edit to `lock.ts`/`lock-math.ts`, not
   from these files; it cleared once their edit landed.)
