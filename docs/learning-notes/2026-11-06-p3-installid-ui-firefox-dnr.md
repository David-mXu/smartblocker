# P3 tail: self-service erasure UI (#32) + Firefox DNR live verification (#4)

Date: 2026-11-06. Closes all remaining P3 items from
[docs/security/red-team-2026-11-05.md](../security/red-team-2026-11-05.md)
except the feedback worker's manual deploy.

## Part 1 — Options UI to reveal installId + delete shared data (#32 P3)

### Problem

The feedback worker ships a self-service erasure route (`POST /v1/delete`,
rate-limited 1/hr per installId) but users had no way to learn their own
installId: PRIVACY.md literally said "there is currently no UI that displays
it". Erasure existed on paper, not in practice.

### Design decisions

- **SW does the POST.** Extension pages (options) never fetch the endpoint
  themselves; the service worker owns all feedback egress (single place to
  audit, consistent with the upload path). Two new message types in
  [src/shared/messages.ts](../../src/shared/messages.ts):
  `GET_SHARED_FEEDBACK_INFO` (read-only) and `DELETE_SHARED_FEEDBACK`, both
  behind the standing `sender.id !== api.runtime.id` guard (#34).
- **`getExistingInstallId()` never mints.** The upload path mints a UUID on
  first share; the UI path must not, or "has anything ever been shared?"
  becomes untestable. In [src/background/feedback-uploader.ts](../../src/background/feedback-uploader.ts)
  the minting `getInstallId()` stayed private to the upload path; the UI
  uses the read-only variant and renders "none yet — created the first time
  you share a correction".
- **Deleting with no installId short-circuits to success.** Minting an id
  just to DELETE 0 rows would be noise; `deleteSharedFeedback()` returns
  `{ ok: true, deleted: 0 }`.
- **No lock guard on delete.** Erasing one's own shared records is a
  privacy right, not a bypass vector — it weakens nothing the lock protects.
- **Honest 429 and no-endpoint states.** 429 surfaces as
  "rate-limited — try again in an hour"; a dev build with
  `FEEDBACK_ENDPOINT === ''` renders a disabled delete button plus
  "nothing was ever uploaded, so there is nothing to delete".
- **UI**: masked id (`abcd1234…••••`) with Reveal/Copy, two-step inline
  confirm on the destructive action, zero new deps — matches the existing
  options-page button/switch patterns ([src/options/OptionsApp.tsx](../../src/options/OptionsApp.tsx)).

### Verification

- Standing assertion added to [scripts/e2e-test.mjs](../../scripts/e2e-test.mjs)
  (§3b) that exercises the card through the real SW message path. Observed:
  `PASS options self-service erasure card renders honest no-endpoint state
  (installId-none: 1, note: 1, btn-disabled: true)` — full suite green.
- `npm run typecheck`, `npm run build:chrome`, `npm run build:firefox` all
  clean; PRIVACY.md's stale "no UI displays it" paragraph rewritten.

## Part 2 — Firefox DNR live verification (#4 P3)

### Problem

The force-mode DNR redirect ([src/background/force-redirect.ts](../../src/background/force-redirect.ts))
was verified on Chrome only. Firefox 121+ claims session-rule + tabIds
support, but #4's fix is exactly the kind of thing that breaks port-side.
Needed: a real headless Firefox, real `dist/firefox` installed, Frozen
Turkey armed, one navigated page, one verdict on whether the tab lands on
extension-owned `blocked.html`.

### Why raw marionette (the investigation, in order)

1. **Puppeteer + BiDi** installed the extension fine (`installExtension`)
   but refused to navigate to `moz-extension://…/options.html`:
   `unsupported operation … not allowed in this context`
   (root `browsingContext.sys.mjs` navigator).
2. **Selenium + geckodriver (classic WebDriver)** failed identically —
   same restriction lives in marionette's `driver.sys.mjs` `navigateTo`.
   The MDN example that opens `moz-extension://` tabs via WebDriver is
   stale for current Firefox.
3. **Puppeteer's `browser.workers()`** does not exist for Firefox, so the
   event-page eval seam used on Chromium (evaluate inside the SW target)
   was unavailable too.
4. **Working path: chrome-context scripts via raw marionette.** Marionette
   exposes a privileged "chrome" execution context (same privilege as
   about:debugging), where `Services.wm` / `gBrowser` can open and inspect
   any tab, and "content" context then evaluates inside whichever tab is
   selected. This bypasses the WebDriver navigation restriction entirely
   because no WebDriver Navigate command is ever issued.

### Marionette protocol notes (protocol v3)

- TCP frames are `len:json`; commands are `[0, id, name, params]`.
- **Responses are FOUR elements: `[1, id, errorOrNull, result]`.** My first
  client assumed `[1, id, result]` and every command "returned null" — the
  decisive evidence was dumping raw frames and seeing
  `[1,1,null,{"sessionId":…}]`.
- `--marionette-port` CLI flag is ignored by current Firefox (observed:
  "Listening on port 2828" anyway); the `marionette.port` **user.js pref**
  works.
- Chrome context additionally requires the
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` env var, or `SetContext` is refused.
- `Addon:Install` returns `{value: "<gecko-id>"}` on success; verify via
  `AddonManager.getAddonsByTypes(['extension'])` in chrome context.
- **The extension auto-opens its options page on install**
  (`onInstalled → openOptionsPage`), which provides the extension-page tab
  without any navigation trick — poll `gBrowser.browsers[].currentURI.spec`
  and select it.
- **Firefox 159's `gBrowser.addTab` requires a principal:**
  `gBrowser.addTab(url)` throws `(destructured parameter) is undefined`;
  `addTab(url, {})` throws `Required argument triggeringPrincipal missing`.
  The working call is
  `addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })`.
- Deterministic extension origin without signing:
  `extensions.webextensions.uuids` pref mapping the gecko id to a fixed
  UUID (the web-ext technique), so `moz-extension://<uuid>/…` is known
  before install.

### Scenario choices

- Probe keyword `sb-fx3-dnr-probe-kw` lives **in the URL**
  (`https://example.com/?q=…`), so the blocklist's URL-substring match
  fires instantly — no model download in the harness.
- `example.com`, not a local server: `localhost`/`127.0.0.1` are in
  DEFAULT_WHITELIST (and suffix matching means `127.0.0.1.nip.io` escapes
  too).

### Deliverable and observed result

[scripts/verify-firefox-dnr.mjs](../../scripts/verify-firefox-dnr.mjs) — no
additional npm dependencies, driven by `SB_FIREFOX=/path/to/firefox`. Its
store-only XPI writer and Marionette transport now live in the shared
[firefox-marionette helper](../../scripts/lib/firefox-marionette.mjs). The
original run was against Firefox 159.0.1:

```
PASS SmartBlocker temporary add-on installed and active
PASS options page tab present (auto-opened on install)
PASS Firefox exposes the session-rules DNR surface (full)
… tab URIs: ["…/options.html",
  "…/blocked.html?v=1&reason=dnf-redirect&locked=1&title=Example+Domain
    &label=blocked+rule%3A+%22sb-fx3-dnr-probe-kw%22&score=1.000&ms=0"]
PASS Frozen Turkey force block DNR-redirects to extension-owned blocked.html in Firefox
PASS blocked page reason param is dnf-redirect (dnf-redirect)
… live session rules while locked: 1 ["|https://example.com/?q=sb-fx3-dnr-probe-kw|"]
PASS session rule present for the blocked tab (DNR path)
PASS unlock drains Firefox session rules (left 0)
FIREFOX DNR VERIFY: ALL PASSED
```

The blocked URL's params double as an end-to-end check: `locked=1` (Frozen
Turkey), `label=blocked rule: "sb-fx3-dnr-probe-kw"` (URL-substring match),
`ms=0` (no ML inference — as designed), `reason=dnf-redirect` (the DNR
code path, not the overlay fallback).

### Left unresolved / notes

- The harness needs a Firefox binary; not wired into CI (same posture as
  the other live e2e suites — run locally per security-relevant change,
  documented in CLAUDE.md/README.md).
- If a future Gecko regresses session-rule tabIds, the overlay fallback in
  `force-redirect.ts` is the documented degrade path and this script asserts
  for it (it would PASS the "fallback" check while failing the DNR ones —
  a loud, readable signal).

## Part 3 — Feedback worker deploy (the last P3 item)

Deployed 2026-11-06 to `https://smartblocker-feedback.xudavid12613.workers.dev`
(D1 `c96a7664-6835-4591-98d9-675ebb232d8c`, region ENAM, daily 04:00 UTC
purge cron). Steps, in the order that worked:

1. `npm install -D wrangler` inside `feedback-worker/` — wrangler is a
   project-local devDependency (no global install; the project's
   `npx wrangler` pins the version).
2. `npx wrangler login` — OAuth via the desktop browser (Edge in WSL:
   localhost forwarding carries the `localhost:8976` callback without any
   extra config). Credentials land in `~/.config/.wrangler/config/default.toml`.
3. `npx wrangler d1 create smartblocker-feedback` → paste the returned
   `database_id` into `wrangler.toml` (binding name stays `"DB"` — that's
   what `src/index.js` reads, not wrangler's suggested `smartblocker_feedback`).
4. **`npx wrangler d1 execute smartblocker-feedback --remote --file=./schema.sql`**
   — the one real landmine: **wrangler 4 defaults `d1 execute` to a LOCAL
   sqlite file on disk.** My first run "succeeded" (and my verification
   SELECT read the same local file, also succeeding), while production
   threw `D1_ERROR: no such table: feedback` (Cloudflare error 1101 on
   every DB-touching route; found via `npx wrangler tail`). The wrangler.toml
   header now documents `--remote` in bold so a re-deploy can't repeat this.
5. `npx wrangler deploy`, then `npx wrangler secret put EXPORT_TOKEN`
   (stdin pipe, value never in argv/logs; kept locally at
   `~/.config/smartblocker/export-token`, mode 0600, outside the repo).
   Deploy first: `secret put` is itself a deployment and needs the worker
   to exist.
6. Set `FEEDBACK_ENDPOINT` in `src/shared/config.ts`, rebuild both targets,
   and flip e2e §3b from "assert the no-endpoint disabled state" to
   "read FEEDBACK_ENDPOINT from config.ts and assert whichever state is
   honest for this build". Full suite: 24 PASS, 0 FAIL.

Live endpoint verification (curl against the real worker):

- `GET /v1/export` without token → **401** (fail-closed)
- with token → `{"rows":[],"nextCursor":0,"done":true}`
- `POST /v1/feedback` probe record → `{"ok":true,"stored":1}`
- export shows the row (with `received_at` stamped server-side)
- `POST /v1/delete {installId}` → `{"ok":true,"deleted":1}`
- export empty again → full ingest→export→delete round-trip confirmed

Known residual (documented in wrangler.toml, dashboard-only): the
belt-and-suspenders Cloudflare WAF rate-limit rule on `POST /v1/feedback`
is a dashboard-managed rule (Security → WAF → Rate limiting), deliberately
NOT in wrangler. The in-worker D1 fixed-window limits already enforce the
per-install/per-IP caps; the edge rule is extra flood shedding.

## Alternatives considered

- Keep BiDi and drive everything through the options tab opened by the
  extension itself — dead end: BiDi couldn't target that tab either.
- Sign dance to open moz-extension pages via WebDriver — no such switch
  exists in current Firefox; chrome-context gBrowser ops are the supported
  privilege level for this.
- Fetch `/v1/delete` directly from the options page — rejected: background
  owns network egress; options stays UI-only.
