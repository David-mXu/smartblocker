# Corrupt auxiliary state degrades a subsystem, not the enforcer

## Why

`run_daemon` refused to start when `partner-state.json` or
`allowance-state.json` existed but could not be parsed. The refusal was
deliberate fail-closed policy — never replace a trust root, never mint a fresh
daily pool — but its blast radius was the whole daemon: a truncated file (a
crash, disk error, or a same-uid attacker) disabled every app/browser kill for
as long as it stayed corrupt, even though locking logic itself was healthy.

## What changed

- `Shared` carries `partner_unavailable` / `allowance_unavailable` reasons.
- Startup:
  - Partner load failure → an inert, never-persisted placeholder state plus the
    reason; the corrupt file is left untouched (no fresh trust root).
  - Allowance load failure (`load_allowance_or_degrade`) → `None` + reason; a
    missing file still means "fresh install" (mint allowed), while an
    unreadable one does not.
- Guards:
  - Every partner command entry point (`add-key`, `arm`, `begin`, `redeem`)
    replies with an explicit Error naming the unavailable subsystem; the
    periodic `observe_partner_at` no-ops; status hides partner state.
  - Allowance bootstrap/commands reply Error; status hides allowance. Relief
    therefore behaves as "uninitialized" (fail closed).
- Enforcement, locks, grace, watchdog and process kills are untouched.
- `daemon-start`, `partner-state-unavailable` and
  `allowance-state-unavailable` are logged so the UI's recent-events view shows
  why the subsystem is missing instead of looking merely unarmed.

## Verification

- New unit tests: partner commands refused while enforcement still merges a
  frozen lock and status reports no partner; allowance bootstrap/command refused
  with no pool minted while timer locks still merge; startup classification
  distinguishes fresh install from corrupt file.
- Full companion gate: **322 core + 4 fixtures + 2 nm-host**, clippy
  `-D warnings`, fmt.
- Companion e2e (real Chromium + daemon): 64/64 ALL PASSED.

## Residual

The placeholder partner state is never saved, so a user must repair/remove the
corrupt file (or the daemon restores from the companion's own `config.json`
pairing data where applicable) to re-enable accountability-partner features.
That is intentional: automatically minting a new trust root is the bypass we
refuse.
