# SmartBlocker

A smart distraction blocker that runs a text-classification model
**100% locally in your browser** (Transformers.js + ONNX WASM). Instead of
blocking whole sites, it classifies each page title — "React Router Tutorial"
passes, "I spent 100 days in Hardcore Minecraft" gets a block screen. It watches
**every site except a whitelist you control**; seeded with safe defaults like search, mail, docs, and dev tools).

Implemented through the Phase 4 desktop-companion hardening pass; the full
plan is in [`ROADMAP.md`](ROADMAP.md). What works today:

1. Transformers.js runs inside a Manifest V3 background (service worker on
   Chrome/Edge, event page on Firefox). On Chrome/Edge the model lives in an
   **offscreen document** so it survives the service worker's idle shutdown;
   on Firefox a keepalive alarm covers event-page suspension.
2. **Multi-prototype "System 1" classifier.** Each category is scored as
   75% mean-centroid similarity + 25% weighted top-2 seed similarity, and a
   page blocks on the **combined top-2 blocked-category mass**
   (`effectiveBlockScore`) — so a page straddling two distraction categories
   can't split the vote and slip under the threshold. An optional **Focus
   Context** (your current `focusGoal`, and/or `useTabContext` open-tab
   context) rescues on-task tutorials on mixed sites without diluting the
   model for everyone else.
3. **Configurable categories + onboarding** — a settings page (opens on install)
   lets you pick which categories to block, set the threshold, edit the
   whitelist of never-blocked sites, and scan your history to spot your top
   distractions.
4. Page-visit classification blocks in ~10ms once warm
   (popup → "Latency Log" after browsing), with a **block screen** whose
   "this is actually productive" override remembers your correction — on
   **every surface**: top-level pages; direct sub-frame embeds (YouTube
   `embed` / `youtube-nocookie`), which are blocked by injecting the
   verdict straight into the embed's own frame (`frameIds`) — so they
   fall even when the host page hides the `<iframe>` inside a **closed
   shadow root** or a nested wrapper frame that in-page scans can't
   reach; and a two-pass SERP/embed sanitizer (`src/content/sanitize-page.ts`)
   that masks distraction shelves and result cards on whitelisted search
   pages and chatbot workspaces (walking the light DOM and **open**
   shadow roots) while leaving productive results alone.
5. **The classifier learns from you.** Corrections (the override button, and
   the popup's "Should've been blocked" report) are stored on-device and fold
   into the classifier's category prototypes. The options page can export
   them as JSON — and an **opt-in, off-by-default** toggle can share them to
   improve the model for everyone ([`PRIVACY.md`](PRIVACY.md)).
6. **Locks, Cold-Turkey-style.** Lock your settings for a set time or behind a
   password, schedule recurring locked blocks (e.g. weekdays 9–5), or hit
   **Frozen Turkey** in the popup to force blocking on for the next 1/4/8
   hours — uncancellable, and the block screen's bypass buttons disappear.
   The **desktop companion** (`companion/`, Rust) turns the soft lock into
   hard OS-level enforcement — see below.
7. **A UI worth living in.** Popup, options page, and block screen are a
   Dark-First design system in React 19 + Tailwind CSS v4 + shadcn/ui
   (compact settings dashboard, animated HUD popup), with real extension
   and companion tray icons. The scroll-triggered editorial showcase lives
   on the standalone marketing site (`site/`, GSAP narrative) instead of
   inside settings.

Nothing ever leaves your machine (the model, ~35MB one-time, is downloaded
from the Hugging Face Hub and cached; all inference and history analysis are
local) — with exactly two opt-in exceptions, both off by default and
enumerated in [`PRIVACY.md`](PRIVACY.md): explicit feedback sharing and
`resolveEmbedTitles` (YouTube oEmbed lookups for otherwise-untitled embeds,
never for nocookie/facade players). Extension pages are locked to
`default-src 'self'` by CSP, so this list can't quietly grow.

## Desktop companion (the hard enforcer)

A Rust daemon ([`companion/`](companion/README.md)) pairs with the extension
over Native Messaging and enforces the same lock state at the OS level.
While a lock runs it:

- **Runs OS-level kills when any lock is active** — timer, password,
  Frozen Turkey, or a scheduled window — and kills nothing while no lock
  is armed.
- **Identifies browsers behaviorally, not by filename** — process
  fingerprinting reads each browser's command line for renderer structure
  (`--type=renderer` on Chromium, `-contentproc` on Firefox), so renaming
  `brave.exe` to `chrome.exe` no longer inherits trust, and private or
  extensionless launches (`--incognito`, `--inprivate`, `--guest`,
  `--disable-extensions`) are flagged as bypasses.
- **Compensates wall-clock jumps with a monotonic anchor** — rewinding the
  system clock doesn't shorten a lock (extension `lock-enforcer.ts` mirrors
  the same defense).
- **Heals tampered state both ways** — edits to `config.json` mid-lock merge
  against enforcement-critical fields instead of weakening them, and the
  daemon's persisted lock copy reverse-syncs back into a wiped or
  reinstalled extension so a storage wipe can't free you.
- **Protects itself precisely** — kill-immunity applies only to the
  companion's own executables (exact stem + recorded PID), so nothing
  masquerades as `smartblocker-daemon` for immunity; a **paired watchdog
  supervisor** (`smartblocker-daemon watchdog`) respawns the daemon if it's
  killed, and `uninstall` refuses to de-register the companion while a
  forced block (Frozen Turkey / schedule window) is active.
- **Verifies Pro licenses fully offline** — `SBPRO1.<payload>.<sig>` keys,
  HMAC-SHA256, no activation server, zero network traffic.
- **Writes platform policies** — Firefox `policies.json` and Chromium
  hardening policies close what consumer policy allows closing; the
  behavioral watchdog remains the universal backstop (details in
  [`companion/README.md`](companion/README.md)).

Honesty about the edges process scanning can't reach: **Electron/WebView2
apps** (VS Code, Slack, Discord, `msedgewebview2`, …) run Chromium
internally, so they classify as desktop apps rather than browsers, and web
content rendered *inside* them is a documented residual — no extension
runs there, so there's nothing to enforce. **Dev-flag launches** (the
`--load-extension` + `--disable-extensions-except` pair) are exempt from
the bypass-flag kill class by design, but they still count as their
browser kind, so they're tolerated only while the paired extension of that
kind stays healthy — a dev browser that loses its extension's heartbeat is
closed by the same watchdog as everything else. And **window-level private
browsing** (Ctrl+Shift+N, guest window, second profile) spawns no new
process, so per-process scanning can't see it: the daemon enforces per
browser *kind*, and an incognito window with no extension access simply
shares the main instance's health. That last one is a roadmap item —
managed policies plus a strengthened incognito-access nag — not something
more process sniffing can solve.

## Build

```sh
npm install
npm run build        # -> dist/chrome (also Edge) and dist/firefox
npm run build:site   # -> dist-site (standalone marketing landing page)
```

## Try it

**Chrome / Edge**
1. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode.
2. "Load unpacked" → select `dist/chrome`.
3. Click the "service worker" link to open the background console.

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" → select `dist/firefox/manifest.json`.
3. In `about:addons`, open the extension's Permissions tab and grant access
   to all sites (Firefox treats MV3 host permissions as opt-in).

**Then, in any browser:**
1. On first install the **settings page opens automatically** (onboarding):
   toggle which categories to block, set the block threshold, and hit
   **Scan my history** to see your top distraction vs productive categories.
   Reopen it anytime from the extensions menu → "Options" (or the popup).
2. Click the toolbar popup → **Test Pair**. First click downloads the model
   (~35MB, watch the background console); you'll see label distributions and
   per-title timings.
3. **Scan History** → live progress + a category histogram of your recent
   browsing (all sites except the whitelist).
4. Visit a gaming video on YouTube → **block screen**. Click *"This is actually
   productive — let me through"* and the correction sticks (that title won't be
   blocked again); *"Stay focused"* just dismisses. Click through to another
   video via the sidebar (SPA navigation) → it re-blocks. A programming tutorial
   → no block. **Latency Log** shows the breakdown (`pageDelay` = the page's own
   title lag; `load` = model cold start — ~0 on Chrome thanks to the offscreen
   document; `infer` = classification; cached repeats are ~0ms).

## Automated checks

```sh
npm run eval                                                # regression gate — fails on any regression
node scripts/benchmark.mjs embed:Xenova/bge-small-en-v1.5   # model bake-off (compare candidates)
node scripts/e2e-test.mjs                                   # full extension e2e in a real Chromium
node feedback-worker/test/local-test.mjs                    # feedback worker (stubbed D1)
```

`npm run eval` is the one that answers *"did that change make the model
better?"* It runs the shipped config over **15,874 eval cases** (slices `v1`
through `v8`), scores the real block/allow decision (whitelist and blocklist
included, not just the classifier's guess), and diffs every case against a
committed baseline — printing exactly which pages got fixed and which
regressed, and exiting non-zero on a regression. Accept an improvement with
`--update-baseline`; the git history of `scripts/eval-baseline.json` is the
score history. `scripts/verify-dataset.mjs` enforces train/test
disjointness against the 518 prototype seed texts.

Many eval cases carry a real URL, and `npm run eval -- --capture` re-scrapes
those pages with a headless browser using the *same* metadata extractor the
extension injects — so the eval measures the real signal pipeline instead of
hand-written guesses about it.

The shipped classifier is a **multi-prototype embedding** model
(`Xenova/bge-small-en-v1.5`, ~34MB): the page text is embedded once and
matched against per-category prototypes built from **518 seed texts**
(`src/shared/prototype-seeds.json`), so adding categories is free and
inference is ~3ms in Node / ~10ms live. Across all 15,874 cases it scores
**95.4% top-1 accuracy, a 0.4% false-positive rate on productive pages,
97.6% must-block recall, and 98.7% end-to-end block/allow decision
accuracy** — versus 65.2% top-1 / 7.1% FP at ~111ms for the zero-shot NLI
model it replaced (which remains available as a config fallback). It also
knows its proper nouns: "Elden Ring Boss Fight" → video games at 0.89.

All tuning knobs (backend, model ids, category labels, blocked categories,
thresholds) live in `src/shared/config.ts`; prototype seed texts live in
`src/shared/prototype-seeds.json`.

### Security regression tests

Ports of the 2026-11-05 red-team PoCs (see
[`docs/security/red-team-2026-11-05.md`](docs/security/red-team-2026-11-05.md))
plus the live e2e gates. Run them locally, per security-relevant change:

```sh
python3 scripts/security-companion-test.py    # daemon IPC attacks: auth, redaction, merge pinning (9 checks)
node scripts/e2e-security-blockscreen.mjs     # block-screen anti-tamper: synthetic click, remove, CSS-hide
node scripts/e2e-test.mjs                     # full extension e2e: blocklist, locks, SERP/embeds, sub-frames
node scripts/e2e-companion-test.mjs           # full companion loop: real Chromium + nm-host + daemon
node scripts/e2e-p1-overrides-sanitizer.mjs   # host-scoped normalized overrides + sanitizer mask hardening
node scripts/e2e-p1-privacy-failclosed.mjs    # privacy egress gates (oEmbed/CSP) + fail-closed locks
SB_FIREFOX=/path/to/firefox node scripts/verify-firefox-dnr.mjs  # live Firefox DNR redirect check
```

The `cargo fmt` / `clippy` / `test` gates, `cargo audit`, the shared
lock-math fixtures, and the daemon IPC PoC also run in CI
(`.github/workflows/security.yml`); the Playwright e2es stay local by
design — persistent Chromium profiles plus a one-time ~35MB model
download make them a flake farm on shared runners.
