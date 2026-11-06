# P1 security hardening: override scoping (#14) + sanitizer mask hardening (#16)

Date: 2026-11-06 · Agent task: red-team P1 remediation, Team B (files: `src/shared/overrides.ts`, `src/content/sanitize-page.ts`, one line of `src/background/blocker.ts`, new `scripts/e2e-p1-overrides-sanitizer.mjs`)

## Problem

Red-team audit (`docs/security/red-team-2026-11-05.md`) found two MEDIUMs:

- **#14 — overrides are title-only and domain-agnostic.** `isOverridden()` compared exact page titles with trim-only
  normalization. An attacker page could insert zero-width spaces or compatibility glyphs to *evade* a user's
  override, or deliberately copy an overridden title on a different domain to *over-apply* it (get itself
  allowlisted).
- **#16 — SERP/embed masks defeatable.** The page-observer only watched childList mutations; the injected mask
  stylesheet was never re-ensured after first paint; mask "Show" buttons and original iframe URLs were handled
  through page-visible DOM (`data-sb-orig-*` attributes).

## Root cause / concepts

- The override store keyed corrections by title string only — scope and canonicalization were never part of the
  model. Unicode *Cf* (format) chars (ZWSP U+200B, ZWJ, bidi controls, soft hyphen, BOM) are invisible in rendering
  but differ byte-wise, and NFKC compatibility glyphs (e.g. fullwidth `Ｓ`) look identical yet mismatch a naive
  string compare.
- A content script injected via `chrome.scripting.executeScript` runs in an **isolated world**: its JS memory is
  invisible to the page, but any DOM attributes it writes are fully readable/writable by the hostile page. Secrets
  or provenance data must therefore live in JS memory (here a `WeakMap` on the isolated-world `window`), never in
  `data-*` attributes.

## What changed and why

### `src/shared/overrides.ts`

- `normalizeOverrideTitle(title)` (exported, **pure + synchronous**, no browser APIs — eval scripts import
  `shared/` under Node type-stripping): strip `\p{Cf}`, `NFKC` normalize, collapse `\s+` → one space, trim, cap at
  300 chars (the classifier input bound, so the key covers the whole judged string). Hosts normalize like
  `url-signals.hostnameOf`: lowercase + strip leading `www.`.
- Storage: entries written after scoping carry `host?: string` (type kept local to this file as
  `Override & { host?: string }` — `messages.ts` untouched).
- `addOverride(title, hostname?)` — new signature is backward compatible; every new write stores the normalized
  form, scoped when a hostname is supplied. De-dup is per exact (host, key) scope, so the same title on different
  hosts coexists.
- `isOverridden(title, hostname?)` — scoped match when a hostname is given. **Legacy compat:** entries with no
  stored `host` still match on every host, and callers that pass no hostname get the historical title-only
  behaviour, so the three un-migrated `blocker.ts` call sites (`evaluateSubItems` ×2, sub-frame path) behave
  exactly as before.
- Both empty-title and empty-key writes/checks are refused (fail-closed).

### `src/background/blocker.ts` (one-line change, team C edits this file concurrently)

The top-level verdict path now passes the page hostname: `isOverridden(title ?? '', hostnameOf(url))`. `url` was
already in scope and `hostnameOf` already imported. The other three call sites still compile against the optional
parameter — migrating them (and `index.ts`'s `addOverride(msg.title)` → pass
`hostnameOf(sender.tab?.url ?? msg.url ?? '')` so real user corrections become host-scoped) is a one-line
integrator follow-up per site.

### `src/content/sanitize-page.ts`

- **Attribute observer**: the debounced `MutationObserver` now also observes `attributes: true` with a bounded
  `attributeFilter`: `src`, `srcdoc`, `data-src`, `data-lazy-src`, `data-original`, `videoid`, `data-videoid`,
  `data-video-id`, plus our own `data-smartblocker-masked` / `data-smartblocker-state`. Bounded because the filter
  only fires on attributes the sanitizer actually keys on; the extension's own writes settle after one debounced
  no-op rescan (a converging fixpoint, not a loop).
- **Self-heal on masked containers**: when the embed scan encounters a container that is already masked (and not
  user-revealed), `pauseAndUnloadMedia()` re-runs — a hostile page that re-points a blanked iframe's `src` gets it
  re-blanked on the next scan.
- **CSS re-ensure per scan**: `runScan()` calls the cheap idempotent `ensureMaskCss()` for every open root, and
  `ensureMaskCss` now also restores a style node whose `textContent` was emptied instead of removed.
- **isTrusted on Show** was already present (kept; the e2e now proves it).
- **Originals in memory**: `data-sb-orig-src`/`data-sb-orig-srcdoc` are gone. A `WeakMap<HTMLIFrameElement,
  {src?, srcdoc?}>` on the isolated-world `window` (survives re-injection of the script, garbage-collects with the
  iframes) stashes originals **keep-first**, so a hostile re-point never becomes the trusted "Show" restore target.
  The reveal handler restores from the WeakMap.

## Alternatives considered

- Lowercasing titles in normalization — rejected: not in the audit spec, changes match semantics beyond the finding.
- Migrating all four `blocker.ts` call sites + `index.ts` — rejected: file-ownership constraint (one ≤3-line
  change; `index.ts` unassigned). Optional parameters keep every legacy site compiling and behaving identically.
- Observing all attribute changes — rejected: unbounded observer noise on real SERPs; the filter lists exactly the
  attributes the sanitizer reads.

## Verification

- `npm run typecheck` — clean (`tsc --noEmit`, no output).
- `node scripts/lock-math-test.mjs` — 65/65 (untouched, sanity).
- `node --check scripts/e2e-p1-overrides-sanitizer.mjs` — syntax OK.
- Normalization truth table exercised in pure Node: ZWSP/fullwidth/NBSP variants fold onto the stored title, plain
  legacy titles unchanged, distinct titles differ, `Cf` set (ZWSP/ZWJ/BOM/bidi/soft-hyphen) stripped, 300-char cap.
- **Not run here:** the new e2e script (needs `dist/chrome` rebuilt; team C builds concurrently — left to the
  integrator). The script seeds storage directly for determinism and drives: legacy host-less override passes;
  host-scoped override passes on its own host but the same title blocks on a different host; a
  fullwidth/ZWSP/NBSP title variant passes on the scoped host; synthetic `btn.click()` never reveals; a mutated
  `src` on a masked iframe is re-blanked; a deleted `#smartblocker-mask-style` is re-ensured; and a trusted
  Playwright click still reveals + restores the original `src` from memory.
