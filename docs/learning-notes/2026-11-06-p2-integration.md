# 2026-11-06 — P2 integration receipt (five parallel teams)

Companion note to the four team notes:
[p2-rust-hardening](2026-11-06-p2-rust-hardening.md) (#20/#22/#23/#24/#25, IPC+enforcer+license),
[p2-dnr-force-redirect](2026-11-06-p2-dnr-force-redirect.md) (#4 DNR),
[p2-kdf-modelpin-senderid](2026-11-06-p2-kdf-modelpin-senderid.md) (#19/#21/#34),
and the worker note at `~/agentic-notes/smart-blocker/2026-11-06-feedback-worker-rate-limit-retention.md` (#18/#32).
Team H (PoC ports + CI + doc sweep) wrote no note by design; its work is covered below.

## How the work was split

| Team | Findings | Owned surface |
|---|---|---|
| E | #20, #22, #23, #24, #25 | `smartblocker-core` daemon/ipc/license/enforcer + daemon-crate main.rs + companion/README + companion e2e |
| F | #18, #32 | `feedback-worker/**` + PRIVACY retention subsection |
| G1 | #4 P2 addendum | `src/blocked/`, `force-redirect.ts`, `blockscreen-ui.ts`, blocker.ts redirect hook, manifests, DNR e2e |
| G2 | #19, #21, #34 | `lock.ts` (KDF), `config.ts`/`classifier.ts`/offscreen (pins), `index.ts` (sender.id), KDF/modelpin e2e |
| H | PoC ports, CI, docs | `scripts/security-companion-test.py`, `scripts/e2e-security-blockscreen.mjs`, `.github/workflows/security.yml`, README sweep |

## User-approved decisions that shaped P2

- **DNR redirect in force mode only.** Non-force blocks keep the P0-hardened
  injected overlay byte-identical; only `lock.forceBlocking` (Frozen Turkey /
  schedule window) redirects to the extension-owned `blocked.html`.
- **#25 stronger option:** OS kills in EVERY armed phase (`settings_locked`),
  not just force — a plain 2-minute timer now closes blocklisted apps.
- **#23:** dev-flag browser pair tolerated only while the paired extension is
  healthy; Electron/WebView2 documented as a platform-limited residual rather
  than claimed as covered.
- **#24 behavior change (needs explicit user ratification):** `is_pro` now
  FAILS CLOSED on a missing key; `SBPRO_DEV_OPEN=1` is the dev escape hatch.
  Previously a missing key meant "pro" while the store flow was unfinished.

## Integration fixes applied centrally

1. **§C1 of `e2e-p1-privacy-failclosed.mjs` migrated to DNR** (G1 flagged the
   handoff): the fail-closed force case no longer waits for
   `#smartblocker-overlay[data-smartblocker-reason]` — it waits for the
   redirect to `blocked.html?reason=classifier-unavailable`, asserts protocol
   + path + reason param, then reads `body` textContent directly (the block
   page is a trusted extension document — no shadow-root piercing needed).
   C2 gained a `blocked.html` URL assertion because a wrong force-redirect
   ALSO has overlay-count 0. The backoff assertion survived unchanged
   (`sabotageCalls >= 2`) because G1 kept the retry-before-loud design: the
   redirect attaches only after the exponential retries exhaust, and recovery
   mid-backoff releases the session rule (`clearForceRedirectRule`).
2. **Stale `SingletonLock` cleanup:** a leftover headless chromium from a
   team run held `.e2e-profile`, crashing all four shared-profile suites at
   launch. Killed the stale instance, removed Singleton{Lock,Cookie,Socket}.
   Symptom worth remembering: `Failed to create a ProcessSingleton … File
   exists` with zero PASS lines — the crash happens BEFORE any test prints.

## Design notes worth remembering

- **DNR rule hygiene:** session rules are tabId-scoped with anchored `|url|`
  conditions (priority 1000, IDs ≥ 1M), released on unlock / verdict-clear /
  tab-close, and `clearAllForceRedirectRules` re-reads the LIVE session
  ruleset so a rule added by a now-dead SW instance can never leak past the
  lock. Fail-open on rule-index reads would have been a bypass hole.
- **blocked.html trusts nothing:** query params are attacker-influenceable
  (the page is web-accessible by DNR requirement), so reason comes from an
  enum allowlist, numbers are clamped, strings capped, EVERYTHING renders via
  `textContent`, and bypass buttons are never rendered regardless of a forged
  `locked=0`.
- **KDF v2 without a format marker:** both sanitizers enforce
  `^[0-9a-f]{64}$` on `passwordHash` (daemon treats it as opaque), so v2 is
  ALSO bare 64-hex; the version marker lives in the separate `lockKdf`
  storage key (`{salt, iterations:210000, v:2}`) which never enters
  `lockStateSync`. Migration = legacy verify succeeds → silent re-arm with a
  fresh `passwordTs`.
- **PING/PONG for liveness:** a squatter holding the companion socket
  previously looked alive to a raw-connect probe. The probe is now an
  authenticated companion-internal ping (pong carries pid + start mono);
  wrong/absent answer = dead = respawn. Same change killed the bogus
  relay-disconnect event spam each probe used to cause.

## Verification (central, after ALL teams landed)

- `npm run typecheck` clean; `npm run build:chrome` clean (blocked.html +
  self-hosted woff2 in dist); `lock-math-test.mjs` 77/77.
- cargo gate: 118 tests, clippy `-D warnings` clean, fmt clean, both bins build.
- E2E chain: see the results appended below.
- Doc verification: H's README armed-phase bullet checked against E's
  `enforcer.rs` (`else if status.settings_locked` → armed kills; idle kills
  nothing) — matches, no flip needed.

## Final e2e matrix (all green)

- `scripts/e2e-test.mjs` — ALL PASSED (extension boot → overlay → blocklist →
  history scan).
- `scripts/e2e-p1-overrides.mjs` — ALL PASSED.
- `scripts/e2e-p1-privacy-failclosed.mjs` — ALL PASSED (incl. the §C1 DNR
  migration this phase: frozen-turkey force blocks now assert the redirect
  to `blocked.html?reason=classifier-unavailable`, not an injected overlay).
- `scripts/e2e-p2-dnr.mjs` — ALL PASSED.
- `scripts/e2e-p2-kdf-modelpin-senderid.mjs` — ALL PASSED.
- `scripts/security-companion-test.py` — 9/9.
- `scripts/e2e-security-blockscreen.mjs` — ALL PASSED.
- Worker harness (`feedback-worker/test/local-test.mjs` + rate-limit suite) —
  45/45.
- `scripts/e2e-companion-test.mjs` — ALL PASSED (final clean run9 with the
  widened polls + diagnostics in place; run8 was ALL PASSED too).

## Post-integration flake hardening (debugging trail)

Three e2e-companion failures chased to ground; **zero product bugs**, all
test/environment-side:

1. **PING "frame timeout" — my own repro script's FrameStream was the bug,
   not the shipped one.** The suite's `FrameStream` accumulates from
   construction and polls the buffer (frame-coalescing-safe). The standalone
   debug script I'd written lazily attached the `data` listener per-read and
   dropped coalesced greeting+pong bytes → reproduced "no pong" against a
   healthy daemon. Evidence chain: `[daemon-debug]` instrumentation showed
   `ping → pong queued → writer wrote len=54 ok=true` while the client
   reported timeout. Daemon instrumentation removed afterwards; binary
   verified string-free.
2. **`daemon-seeded lock merged back` FAIL / `distraction blocked` FLIP —
   one expired timestamp, two opposite signatures.** The seed was
   `frozenUntil + 60_000` measured from an arm captured *before* the kill
   sections; by section (c) the "extended" deadline lay minutes in the past.
   - When already expired: the extension's lock-enforcer correctly
     expiry-swept the merged lock → merge poll FAIL; the gaming page then
     took the *non-force* path and got the injected overlay, so the (either-
     generation-accepted) distraction check PASSED — masking the real cause.
   - When still marginal: force-redirect vs overlay race made the earlier
     run's distraction FAIL equally time-derived.
   Fix: seed relative to `Date.now() + 120_000` (the thing actually under
   test is "daemon-seeded lock survives extension wipe", not calendar math).
3. **`frozen turkey persisted within 5s` flake.** One run lost the 5s window
   (SW relaunch at boot + notification traffic from the armed-kill section
   immediately before the arm); the next run on identical code passed
   instantly. These polls assert sync *integrity* (value equality), not a
   latency SLA → widened to 15s, and on failure the suite now logs the
   daemon's actual persisted `lock-state.json` because `DATA_DIR` is
   rmSync'd at exit (previously the evidence evaporated).

Also added permanently: a diagnostics dump on the distraction check (tab
URL, overlay count, merged lockState, live DNR session rules) — future
flake reports here will be self-describing.

**Lesson:** when one element (a seeded deadline) is shared by several later
assertions, anchor it to *now at the point of use*, never to a value
captured sections earlier; and make failing polls dump the other side's
state before cleanup deletes it.
