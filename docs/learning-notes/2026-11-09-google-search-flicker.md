# Google Search Whole-Page Flicker

**Date:** 2026-11-09  
**Project:** SmartBlocker  
**Status:** Investigation and implementation in progress

## 1. Problem and goal

The user reported a whole-page flash during Google searches, especially first or cold searches, and suspected Smart Blocker's processing. They asked to preserve full-page blocking for complete search queries rather than disabling that protection.

## 2. Evidence and root-cause hypothesis

Three read-only agents independently traced the search sanitizer, background classification, and browser-test setup. A real-Edge `browser-use` session confirmed the installed Smart Blocker service worker and inspected its own local diagnostics without changing its settings. The extension was disabled in the real profile during inspection, so it was not re-enabled for experimentation.

The strongest evidence is in the extension's existing `latencySamples`: unfinished Google searches including `ge,` and `wal` received full-page online-shopping blocks (including overlay-injection timings), followed by allow verdicts for `gem` and `walmart`. Separate `browser-use`/subagent inspection also found that a blocked query adds its host to `recentlyBlockedHosts`, allowing a later Google navigation to mount the 180 ms dark pre-block curtain even when the next query is productive.

Two mechanisms can therefore produce the reported full-page flash:

1. Each transient Google title can start an independent evaluation. A partial query can mount a full-page block and a later title can clear it. Existing navigation generations do not invalidate title-only or competing same-document evaluations.
2. A blocked query marks the entire search host as recently blocked, causing a later search to receive a cosmetic dark curtain before its own verdict.

This is stronger and more specific evidence than generic DOM-scan cost. Renderer long tasks were also observed during a live cold-load probe, but Smart Blocker was disabled at that point, so those tasks cannot honestly be attributed to the extension.

## 3. Planned implementation

Keep classification semantics unchanged, but add a SERP-only quiet-title scheduler and candidate generation. A newer URL/title immediately invalidates older quiet-window and in-flight candidates. Only a still-current candidate may record tab status, write a latency verdict, remember a blocked host, redirect, inject, or clear a full-page screen.

Also exclude active SERPs from the optional pre-block curtain and do not add one query's verdict to `recentlyBlockedHosts` for the entire search host. Result-level masking remains available; settled searches can still receive a full-page block.

A settled query is an operational definition, not perfect knowledge of user intent: if a user pauses mid-word beyond the quiet window, that query is indistinguishable from an intentionally short query using ordinary tab events. No length, punctuation, dictionary, or scoring heuristic should pretend otherwise.

## 4. Alternatives and tradeoffs

- **Minimum query lengths or punctuation filters:** rejected because valid searches such as `wal`, `GE`, or one-character queries would become deterministic protection bypasses.
- **Only classifier debounce:** insufficient because an older in-flight verdict could still paint after a newer title arrives, and deterministic title/blocklist rules skip model inference.
- **Only full-document navigations block:** would stop many transient flashes but fail complete same-document SPA searches, so protection would depend on navigation implementation rather than policy.
- **Never block a whole search page:** would eliminate this class of flash but the user explicitly chose to retain full-query blocking.
- **SERP quiet window plus candidate cancellation (chosen):** preserves classification settings while intentionally adding a small delay before full-page SERP enforcement and reducing repeated inference.

## 5. Verification

Baseline before implementation:

- `npm run typecheck` — passed with no TypeScript errors.
- Real Edge inspection — installed Smart Blocker identified via its stable extension ID; relevant local latency samples inspected read-only; real settings left disabled as found.
- Live recording directory: `C:\Users\xudav\.config\browser-harness\agent-workspace\recordings\sb-google-cold-flicker` (browser-harness action captures, not a continuous high-frame-rate flicker video).

Implementation and post-change browser results will be added after the focused Playwright regression and full extension verification complete.
