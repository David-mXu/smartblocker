# Popup + Options UX Overhaul: Structure, Flow, and a Safe "Undo" for an Uncancellable Lock

**Date:** 2026-11-07 · **Scope:** [src/popup/](../../src/popup/), [src/options/](../../src/options/) (shell, `pages/`, `welcome/`), [src/components/ui/list-editor.tsx](../../src/components/ui/list-editor.tsx), [src/shared/tab-status.ts](../../src/shared/tab-status.ts), [src/shared/focus-session.ts](../../src/shared/focus-session.ts), [src/shared/domains.ts](../../src/shared/domains.ts), [src/shared/labels.ts](../../src/shared/labels.ts), [src/background/blocker.ts](../../src/background/blocker.ts), [src/background/index.ts](../../src/background/index.ts), e2e scripts, [docs/design-notes.md](../design-notes.md) §5/§7

## 1. The goal

"Complete UX overhaul of popup and options page, making it user friendly,
simple and easy to use." Earlier the same day, the *Lamplight* pass
(see [2026-11-07-lamplight-ui-redesign.md](2026-11-07-lamplight-ui-redesign.md))
had already fixed the **visual** layer (tokens, fonts, row components). What
remained was **structure and flow**:

- **Popup** read like a developer HUD: model name, "System 1.5", "Active Tab
  Centroid Correction", and half the space spent on diagnostics (Test Pair,
  Latency Log, a telemetry console). It never told you anything about *the
  page you were on* — the question people actually open a blocker's popup to
  answer.
- **Options** was one ~3,200–3,800px scroll with nine sections at equal
  weight; locks and passwords sat beside category checkboxes; the
  allow/block lists were raw textareas that only saved when you remembered a
  header button.
- **First run** was a one-line banner.

## 2. Concepts worth knowing

- **Progressive disclosure:** show the few common actions up front and move
  rare/expert ones behind a deliberate step ("Advanced"). The popup keeps
  only *this page*, *focus goal*, *focus session*; diagnostics moved to
  options → Advanced; the exact threshold slider moved behind named presets.
- **Information architecture (IA):** how content is grouped and navigated.
  We moved from a single scroll to a sidebar with one page visible at a time
  (hash routes like `options.html#sites`) — the pattern of Linear/Notion
  settings found in the Lazyweb references.
- **Explaining an AI decision without jargon:** Apple's ML guidelines and
  Google PAIR recommend translating confidence into words. The popup maps a
  score to "very likely" (≥0.85) / "likely" (≥0.65) / "possibly", and always
  names the *reason* (category, your allow list, your block rule, paused).
- **Autosave vs explicit save:** GitHub Primer's rule — don't mix them in one
  form. Toggles, presets, categories and list rows autosave (with a polite
  "Saved" status); the only explicit saves are multi-field forms ("Edit as
  text" → Save list / Cancel, "Save focus hours").
- **Monotonic state / CRDT-style merge:** the lock store (`lockState`) only
  ever *extends* — the extension and the Rust desktop companion merge it
  with `max()`, so any "shorten" operation would be undone by the next sync
  (and would be a security hole). That constraint shaped the undo design.

## 3. What was done, in order

1. **Inventory before redesign.** Read both React apps, the design notes and
   the e2e suites; screenshotted the real built extension with Playwright
   (`chrome-extension://…/popup.html` in a persistent context with
   `--load-extension`). Why Playwright: repeatable before/after captures of
   the actual bundle. Mapped which DOM ids the e2e suites click — that list
   decided routing details later.
2. **Asked the user the decisions that were theirs** (Lazyweb + web research
   could inform but not decide them): sidebar IA, popup = "this page" +
   quick actions, diagnostics → Advanced, keep dark palette, rename "Frozen
   Turkey" → "Focus session", 3-step wizard, list editor, a 60-second undo,
   and presets for sensitivity.
3. **Coordinated with a concurrent session.** Another Claude session was
   mid-way through the Lamplight redesign on the same files; we waited for it
   to finish (cross-session message + idle notification), checkpoint-committed
   (`abddfc7`), and built on top instead of colliding.
4. **Research (two background agents).** Lazyweb MCP (called over its HTTP
   endpoint, token never printed) gave 22 product references — Opal session
   setup/onboarding/blocks, Linear settings, Alma hold-to-commit, Sleep Cycle
   + Motion schedules, Threads/Dealfront list editors, Bing presets — and web
   research gave ~80 primary sources (Chrome/Firefox extension docs, NN/g,
   Primer, GOV.UK, Apple HIG, PAIR, WCAG 2.2). Reports:
   [docs/ux-research/2026-11-07/](../ux-research/2026-11-07/).
5. **Shared foundations first (lead), so parallel builders never edit the
   same file:**
   - [`tab-status.ts`](../../src/shared/tab-status.ts): the background records
     the final decision per tab in `storage.session` under one key per tab
     (`tabStatus:<id>` — separate keys avoid read-modify-write races between
     tabs). Hooked in `blocker.ts` at the YouTube-browsing early return and
     right before `logSample` (skipping stale verdicts), in the `OVERRIDE`
     handler, and cleared on `tabs.onRemoved`.
   - [`domains.ts`](../../src/shared/domains.ts): allowed sites are *hosts*
     (`https://www.YouTube.com/watch?v=1` → `youtube.com`), always-block
     entries are *substrings* (only trimmed/lowercased, ≥3 chars) — mirroring
     how `isWhitelisted` vs `matchedBlocklistEntry` actually match.
   - [`ListEditor`](../../src/components/ui/list-editor.tsx): add field +
     multi-paste, removable rows, search past 8 entries, "Edit as text",
     `role="status"` messages ("Added …", "… is already listed").
   - [`focus-session.ts`](../../src/shared/focus-session.ts): the undo (below).
   - First install opens `options.html#welcome`; a wizard stub fixed the
     component contract for the builders.
6. **Three builder agents in parallel** from one written spec
   (`.ux-shots/TEAM-SPEC.md`, gitignored): options shell + 8 pages, popup,
   wizard — each owning disjoint files, building under `flock` because the
   background Vite build wipes `dist/`. Each screenshotted every state and
   iterated. The lead reviewed screenshots and sent back one copy fix
   ("Starts in 0:42" was misleading — see §4).
7. **Integration fixes by the lead:** one shared [`labels.ts`](../../src/shared/labels.ts)
   (three surfaces had diverged; options showed "Movies and **tv** shows"),
   an 8-second timeout around `classify()` in `REPORT_FN` so a stalled model
   download can't hang the popup's Report button, e2e suites re-pointed to
   `options.html#advanced|#privacy|#locks|#blocking|#companion` (only the
   active page renders, and Playwright won't click hidden elements), design
   notes §5/§7 and CLAUDE.md rewritten to match.

## 4. Key decision: an undo window for an *uncancellable* lock

The user wanted a 60-second "oops" window after starting a focus session.
The naive approach — let Undo shorten `frozenUntil` — breaks the core
invariant: `lockState` merges by `max()` across the extension and the Rust
companion, so the companion would re-sync the old value (and "shorten a
lock" would become an API an attacker could abuse).

**Chosen: deferred commit.** Start writes `pendingFocusSession { until,
commitAt }` (end time fixed at the click) and a one-shot alarm; nothing is
written to `lockState`, so nothing syncs. When the window closes, the
background calls `startFrozenTurkey(until - now)`. Undo just deletes the
pending record. Commit also runs on SW start and popup open, and is
idempotent (extend-only), so races are harmless.

*Tradeoff:* during those 60 seconds settings are not locked yet (that is
what an undo window means). Normal blocking is already on, so copy says
**"Locks in 0:42"** — the builder's first draft said "Starts in 0:42 / Then
blocks distractions", which falsely implied nothing was blocked.

Rejected: changing `lock-math.ts` + `merge.rs` + shared fixtures to support a
cancel tombstone — far more surface in security-critical code for the same
user-visible result.

## 5. Other tradeoffs and loose ends

- `#save-btn` removed (everything autosaves); the e2e "options frozen while
  locked" check now asserts `#enabled-toggle` is disabled + `#lock-status`.
- `storage.session` needs Chrome 102+/Firefox 115+; where missing,
  `tab-status.ts` no-ops and the popup derives what it can.
- The popup has no incognito warning (it never did; CLAUDE.md claimed so —
  corrected). The warning lives on options → Locks and wizard step 3.
- Live check in the user's Edge: SmartBlocker isn't currently loaded there
  (`ERR_BLOCKED_BY_CLIENT`), and loading unpacked needs a native file dialog
  — left to the user. During that check a browser-use cleanup closed an
  unrelated user tab (`current_tab()` in a new invocation is not the tab you
  opened); it was reopened. Lesson: close tabs by explicit `target_id`.

## 6. Verification (observed)

- `npm run typecheck` clean; `npm run build` clean.
- Lamplight hex grep (`design-notes.md` §6) empty for all touched `.tsx`.
- Builder agents' Playwright runs against the built extension: every
  contract id present on its page; no horizontal overflow at 390px; zero
  external requests; popup fixed 516px in all unlocked states; wizard
  persistence read back from `chrome.storage.local` after each step; popup
  flows (allow/remove site, focus goal, chip arrow keys, start → undo →
  commit-on-reopen) pass.
- `domains.ts` edge cases exercised under Node type stripping (URLs, `*.`
  wildcards, trailing dots, invalid input, dedupe).
- E2E (sequential): `e2e-test` 25 PASS, `e2e-p1-privacy-failclosed` 18,
  `e2e-p2-kdf-modelpin` 19, `e2e-p2-dnr` 21, `e2e-p1-overrides-sanitizer` 11,
  `e2e-security-blockscreen` 10, `e2e-companion-test` 23 (real daemon, now
  opening `options.html#companion`) — **0 FAIL**.
- Lead integration check (`.ux-shots/lead/integration.mjs`, gitignored) in a
  fresh profile with the real model: a route-faked "I spent 100 days in
  Hardcore Minecraft" watch page recorded `tabStatus` `{kind: "blocked",
  label: "video games"}`; a Rust-lifetimes page recorded `allowed /
  programming`; the popup rendered "rustacean.example — Allowed — Looks like
  programming and software development"; a due `pendingFocusSession` wrote
  nothing to `lockState` until the `focus-session-commit` alarm fired, then
  `frozenUntil` ≈ now+1h and the pending record was cleared. ALL PASSED.
- Not verified: the live Edge session (extension not installed there), and
  Firefox (no Firefox run in this pass; `storage.session` fallback is
  code-reviewed only).

## 7. Follow-up: keeping the IA simple as features keep arriving

**Symptom.** A few hours after the overhaul shipped, another session added
five features straight into the new pages (adult-only sites, search-result
masking, auto-resume, title rules, YouTube channel rules). A fresh-eyes QA
pass (re-running the builders' screenshot scripts against the current tree)
showed the regressions the overhaul had removed: jargon ("RTA meta tag",
"Deterministic rules", "smart classifier", "stored lowercase"), a separate
"Auto-resume — the #1 relapse path" box, and a Sites page that had grown to
four stacked lists (~2,000px on a phone).

**Root cause.** Nothing in the codebase tells a feature author *where* a new
control belongs; each feature was appended as its own section. That is the
normal way IA decays.

**Fix (user-approved, layout + copy only — no storage/logic changed):**
- *Put a setting next to the thing it modifies.* Auto-resume only matters
  when you pause, so it became "Turn blocking back on" directly under the
  master switch, with a live sentence when armed ("Blocking is paused — it
  turns back on at Sat 7:33 PM"). Adult-only blocking moved under the
  category list beside "Adult content".
- *Progressive disclosure for power-user rules.* Title patterns and YouTube
  channels live in a native `<details id="more-rules">` with a rule count.
  It auto-opens on first load whenever it already holds rules, so nothing a
  user configured is ever hidden — the classic failure of collapsed UIs.
  (Settings load asynchronously, so the auto-open runs once in an effect
  rather than from `useState`'s initial value, which would see 0 rules.)
- *Name things by outcome.* "Search element masking" → "Hide distractions
  in search results"; "Never let the classifier block these channels" →
  "Never block these channels for their topic".
- The placement rule is now written into `docs/design-notes.md` §5 so the
  next feature has a home.

**Verification:** Playwright screenshots of Blocking (normal, paused with a
resume time, 390px) and Sites (collapsed, auto-opened with rules, 390px) —
all new ids present, no horizontal overflow, no console errors. Gate results
for committing the bundled features are in the commit message.

**A doc bug this pass caught (in my own earlier commit `4c4f38c`).** When
rewriting `design-notes.md` §5/§7 I located sections with
`line.startswith('### Popup')`. The new §5 heading "### Popup (`src/popup/`…"
matched first, so the slice ran from §5's popup spec to §7's "Block screens"
and silently deleted the §5 Popup + Focus-session + Block-screen specs, all
of **§6 Rules** (including the token hex-grep rule) and the §7 heading. A
later insertion that anchored on "## 6. Rules" then no-op'd because
`str.replace` doesn't complain when the anchor is missing. Fixed by restoring
the Block-screen spec and Rules from `abddfc7` and re-inserting the popup /
focus-session text, then verifying the heading order with EXACT matches.
Lesson: anchor edits on exact full lines, and assert every replacement hit
exactly once *before* writing the file.
