# 2026-11-06 — P2: declarativeNetRequest force-mode redirect (findings #1/#4)

## Problem

Red-team findings #1/#4: the injected `blockscreen.ts` overlay asked the
attacker-controlled page's DOM to punish the attacker — globals could be
stolen at `document_start`, Shadow DOM is inspectable, the crazy-timeout
probe could set up hooks earlier same-tick. Fix: under **Frozen Turkey /
hard-schedule force windows only**, the extension itself navigates the
offending tab's main frame to an extension-owned `blocked.html` — zero
hostile DOM — via `chrome.declarativeNetRequest` (DNR) session rules.

Force mode is the one place where removing the bypass path from the DOM
entirely was previously impossible (the overlay renders no bypass buttons,
but the sink existed in hostile territory).

## What changed (files owned: blocker.ts, blockscreen.ts, manifests, e2e-test.mjs)

| File | Change |
|---|---|
| `src/background/force-redirect.ts` | **New.** Entire DNR session-rule lifecycle: ruleId→verdict map, add/clear tab/clear all/reconcile-on-startup (prunes stale rules after SW kill), `browser`→`chrome` fallback, try/catch → callers fall back to the injected overlay. Rule: `{tabIds:[tabId], urlFilter:'|'+exactUrl+'|'}` (anchored both ends so `?x`, `#y`, `evil.com/?q=a.com` never match), `resourceTypes:['main_frame']`, priority 1000 (crushes the only other DNR user at priority 1), IDs ≥ 1,000,000 (dedicated space, `clearAll` rebuild-safe). |
| `src/background/blockscreen-ui.ts` | **New.** Importable renderer duplicating the Frozen-Turkey screen (same classes/CSS — verified byte-identical runtime values by live DOM comparison) + a loud amber fail-closed variant naming `lockdown_active=true` and the storage marker (defaults copied verbatim from failclosed.ts so the page stays honest even if those defaults are ever tuned). `textContent` only on attacker strings. |
| `src/blocked/blocked.html` + `blocked.ts` | **New extension page.** Zero trust of its query string (the page is web-accessible, so params are attacker-influenceable): `locked*` params parsed but bypass controls **never rendered** — fail-closed reading, design contract documented in the header. CSP `script-src 'self'` (no inline at all); design imported from blockscreen-ui; `globals.css` link → self-hosted fonts. Close affordance = `chrome.tabs.getCurrent() → chrome.tabs.remove()` (extension context → tabId present), fallback `window.close()`. |
| `src/background/blocker.ts` | `onTitle`: added `forceRedirectVerdicts Map<key,{url,params}>`; single memoized `requestForceRedirect()` — fail-closed's params registered first, so a later category verdict lands on the fail-closed page (first caller wins). Two call sites: (1) `lock.forceBlocking && verdict.blocked` → redirect, return (no injection, no setBlockState); (2) `lockdown_active=true` + classifier failure + force → redirect fail-closed variant, return. Recovery-allow and the three verdict-clear paths release the rule. `initForceRedirectLifecycle()`: `storage.onChanged` watch on FORCE_LOCK_KEY/`lock` (debounced with `handleStorage`) + listener on lock-enforcer's existing `lock-boundary` alarm at 999ms (fires alongside the lock-handler at 1000ms; both listeners run) → `reconcileAllTabsForceRedirect()`. Wired into `initBlocker()`. |
| `manifests/chrome.json` / `firefox.json` | Added `"declarativeNetRequest"` permission only (host_permissions are already `<all_urls>`; no `minimum_chrome_version` bump needed — DNR predates MV3 floors); added `blocked.html` to `web_accessible_resources`. |
| `package.json` + `vite.config.blocked.ts` | ⚠️ `package.json` is outside the stated ownership set (integrator be advised): `build:chrome`/`build:firefox` now append `&& vite build -c vite.config.blocked.ts` for the tiny blocked-page bundle. |
| `scripts/e2e-test.mjs` | Frozen-Turkey section: after `waitForBlocked()`, follow the redirect (`waitForURL('**/blocked.html**', {timeout:15000})`), assert 0/0/0 buttons on `#smartblocker-blocked`, assert lock copy on the redirected page, and after `forceUnlock` assert the DNR session-rule set is empty (leak check). **No edits to** `handleStorage`, the debounce block, any classifier hook/pixel, `_smartblocker_classifying`, `titlePattern`, `blockscreen.ts`, or any other team's file. |
| `scripts/e2e-p2-dnr.mjs` | **New standalone suite** (separate persistent profile `.e2e-profile`, extension id `ndjbgpkljfggmaniioenklnnmdpemghp`): (a) normal mode still injects old overlay + bypass; timer-lock + password-lock unaffected; (b) force-blocked page redirects to `blocked.html`, zero bypass inputs; (c) reload stays on the extension page, hostile frame dead; (d) Frozen-Turkey lock now holds against the exact red-team exploit: hostile script runs first (proven by two title flips landing both pre- and post-redirect), but no overlay/crazy-timeouts exist on the extension page to steal or cancel; (e) force + `lockdown_active` + classifier failure → fail-closed variant names marker and state, and the three must-never-appear phrases are absent; (f) targeted rule: a *different* tab on the blocked host clears in <300ms with the old overlay (proves the rule never broadened to host-wide). |

## Key decisions and why

- **First-caller-wins memoization** of the redirect params: a fail-closed
  redirect must not be "upgraded" to a category page by the recovery tick
  (and vice-versa creates loops). The verdict clears the map entry, so the
  next block re-memoizes.
- **Recovery tick releases instead of re-redirecting**: `lockdown_active`
  still true + recovery allow → `clearRuleForTab` (the fail-closed page no
  longer matches reality). No rule + `lockdown_active` + classifier OK →
  existing fail-open release unchanged.
- **`urlFilter: '|url|'` anchoring**: DNR `urlFilter` is a *substring* match
  unless anchored; `|` anchors both ends (exact match). Documented residual:
  `*`/`^` after the URL (e.g. `url^` — Chromium accepts `^` as the last
  filter character) broadens to same tab + same host + prefix, which is
  fail-*safe* (over-blocks the already-doomed tab); never cross-host,
  cross-tab, or path-excluding. Verified empirically in case (f) with a
  real second tab.
- **Availability guard**: `chrome.declarativeNetRequest?.updateSessionRules`
  — any failure (Firefox gaps, mocked-away API) falls back to the exact
  pre-change injected path. Normal mode, password-lock, timer-lock, all
  sub-frame paths are byte-identical to before (verified in (a)).
- **blocked.html is web_accessible** (required — DNR redirect targets must
  be). Trust boundary is the *process*: `window.location.search` is read
  with hostile-input glasses. The `locked=` param is parsed for future
  diagnostics but can never conjure the bypass sink.
- **No SW-global rule state**: ruleId→verdict map is module-level (persist
  == rebuild). On SW restart the DNR session rules are gone but any tab
  still parked on `blocked.html` re-triggers a redirect on reload (case c),
  and `clearAllRulesOnStartup` prunes theoretical residue.
- **Fonts**: `blocked.html` links the built `globals.css` (which already
  `@font-face`s the woff2 in `public/fonts/`), keeping CSP
  `script-src 'self'; object-src 'none'; base-uri 'none'` with zero inline.

## Verification (all run, all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (zero TS errors in new/touched files) |
| `npm run build:chrome` + `build:firefox` | both emit `dist/<t>/blocked.html` + assets |
| `node scripts/e2e-test.mjs` | **ALL PASSED** incl. new redirect/post-unlock drain asserts |
| `node scripts/e2e-p1-overrides-sanitizer.mjs` | **ALL PASSED** |
| `node scripts/e2e-p2-dnr.mjs` | **ALL PASSED** (a–f, 22 checks) |

Observed in live runs: redirect URL
`chrome-extension://…/blocked.html?v=1&reason=classifier-unavailable&locked=1&title=…`;
post-unlock session-rule count `0`; second tab on blocked host loads
unaffected while tab 1 is pinned on the extension page.

## Residuals / handoffs

- **`scripts/e2e-p1-privacy-failclosed.mjs` §C1 is now stale BY DESIGN** (it
  asserted the injected loud screen under Frozen Turkey; equivalent
  assertions live in `e2e-p2-dnr.mjs` case (e), and its §C2/§C3 unaffected
  paths still pass). The owning teammate should migrate its C1 to follow the
  redirect.
- Firefox DNR redirect is guarded but untested live (no FF e2e harness);
  fallback covers any gap.
- Tech-stack URL (`/^_ ")')+$/`) can't be a DNR rule (guard); it keeps the
  injected overlay even under force — runbook already treats it as
  unsalvageable via web content.
- `blocked.html`'s close-tab button uses the live-tab API; if
  `tabs.getCurrent()` is unavailable it no-ops harmlessly (verified by not
  clicking in e2e; manual QA recommended).
