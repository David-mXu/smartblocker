# 2026-11-06 — P1 integration receipt (four parallel teams)

Companion note to the four team notes:
[recorded-pid-kill-immunity-watchdog-respawn](2026-11-06-recorded-pid-kill-immunity-watchdog-respawn.md) (#6/#7),
[p1-overrides-sanitizer](2026-11-06-p1-overrides-sanitizer.md) (#14/#16),
[p1-privacy-failclosed](2026-11-06-p1-privacy-failclosed.md) (#9/#13/#17),
[clock-anchor-tz-pinning](2026-11-06-clock-anchor-tz-pinning.md) (#10/#26).

## How the work was split (and why no conflicts)

Four agents in parallel, partitioned strictly by file:

| Team | Findings | Owned files | Deliberately NOT owned |
|---|---|---|---|
| A | #6, #7 | `enforcer.rs`, `registration.rs`, `procwatch.rs`, new `supervisor.rs`, daemon-crate `main.rs`, `companion/README.md`, `e2e-companion-test.mjs` | core `daemon.rs` (Team D) — supervisor wiring went into the daemon *crate*'s main.rs instead |
| B | #14, #16 | `overrides.ts`, `sanitize-page.ts`, new e2e script | `blocker.ts` (Team C) except ONE ≤3-line call-site |
| C | #9, #13, #17 | `blocker.ts`, `blockscreen.ts`, `settings.ts`, options/popup UI, `manifests/*`, `PRIVACY.md`, bundled font/SVG assets, new e2e script | `overrides.ts`, `sanitize-page.ts`, Rust |
| D | #10, #26 | `lock-math.ts` ↔ `lock_math.rs`/`merge.rs` mirror + fixtures, `lock.ts`, `lock-enforcer.ts`, core `daemon.rs` | daemon-crate `main.rs` (Team A) |

The one planned collision (`daemon.rs` — A's supervisor wiring vs D's clock
guard) was dissolved up front by giving the wiring to the daemon *crate*'s
`main.rs` (a background thread calls core's new `supervisor.rs` — no core
edit needed). The one accepted overlap (`blocker.ts`, B's call-site inside
C's file) was bounded to ≤3 lines with "re-read right before editing" — it
landed cleanly. Both extensions teams wrote e2e scripts but were forbidden
from running `npm run build*` (dist/ clobbering); builds + e2e runs were
centralized here. Integration edits applied on top: host param threaded to
the remaining `isOverridden` call sites + `addOverride` in `index.ts`, and
`resolveEmbedTitles: true` seeded in `e2e-test.mjs` (its SERP/embed sections
exercise the historical oEmbed path, which is now opt-in default-OFF).

## Decisions (user-approved beforehand)

- #9 oEmbed toggle `resolveEmbedTitles` **defaults OFF**; never fires for
  nocookie/facades even when on; strictly last-resort after DOM/URL titles.
- #13 fail-closed scope: **hard locks only** (forceBlocking or password
  lock); timer-only and normal mode stay byte-identical fail-open.
- #6 decoys (protected-stem, not in recorded PID set) are **killed during
  locks** with `decoy-immune`/`decoy-killed` events.

## Key concept worth remembering

**Fixed-offset vs IANA timezone pinning (#26):** the ideal fix is IANA tz
pinning, but the Rust mirror builds offline and no tzdb crate is vendored —
so `ScheduleRule` pins `tzOffsetMinutes` (fixed offset) stamped by the only
write path. Honest trade: a rule pinned before a DST change fires one hour
off civil time afterward, forever — chosen over leaving a 1-line tz bypass.
If a tzdb crate ever lands in the vendor cache, the `tzName` field is already
there to upgrade to real IANA evaluation.

## Verification (this integration, after ALL four teams' edits)

- `npm run typecheck` — clean
- `npm run build:chrome` — clean; dist has local woff2, zero
  googleapis/gstatic/picsum refs, `extension_pages` CSP present
- `node scripts/lock-math-test.mjs` — 77/77 (45 fixture cases incl. new tz +
  clamp + tombstone families)
- cargo gate — 97+4+2 tests, clippy `-D warnings`, fmt — clean
- Companion red-team PoC re-run — 9/9 defenses hold (P0 regression check)
- `e2e-test.mjs` — ALL PASSED (after seeding `resolveEmbedTitles: true`;
  its SERP/embed sections exercise the historical oEmbed path)
- `e2e-companion-test.mjs` — ALL PASSED incl. new decoy-kill and
  mutual-respawn cases
- `e2e-p1-overrides-sanitizer.mjs` + `e2e-p1-privacy-failclosed.mjs` — three
  failures on first integration run; ALL THREE were test-harness bugs, not
  product bugs (details below), fixed by the integrator and re-run green.

## The three harness bugs (worth remembering)

1. **ZWSP/homoglyph override FAIL → missing charset.** Playwright
   `route.fulfill({ contentType: 'text/html' })` without `charset=utf-8`
   makes Chromium decode the body as Latin-1, so the test's fullwidth/ZWSP
   title bytes became mojibake (`ï¼³…`) before the extension ever saw them.
   Product normalization was correct (reproduced char-for-char in Node).
   Evidence: dumping the runtime `tabs.title` in the SW showed the garbled
   bytes directly. **Lesson for unicode test fixtures: always declare
   charset in fulfilled HTML.**
2. **Font assertion FAIL → `document.fonts.check()` semantics.** `check()`
   reports *loaded* state; with `font-display: swap` + `unicode-range` the
   woff2 loads lazily, so check() is false on perfectly wired pages. Switched
   to `document.fonts.load(font, 'Hg')` which triggers the fetch — proving
   both the @font-face declaration AND the bundled asset (under the new
   CSP) — then assert `status === 'loaded'`.
3. **#16 trusted-Show timeout → wrong selector depth.** The reveal button
   lives inside `.smartblocker-mask-bar`; the locator used the child
   combinator (`#embed-wrap > .smartblocker-mask-reveal`) instead of
   descendant, so it never matched. The synthetic-click assertion two blocks
   above found the same button with `querySelector` (descendant) — the
   inconsistency inside the same file was the tell.
