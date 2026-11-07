# Audit: Cold Turkey Blocker — under the hood, plus the blocker landscape

**Date:** 2026-11-07 · **Audience:** SmartBlocker maintainer · **Method:** live, read-only inspection of a real Cold Turkey install on this machine (Windows 11, Edge) + official docs browsed in-browser + agent-assisted web research + codebase inventory of SmartBlocker.

**Safety note:** everything inspected locally was read-only (directory listings, registry/firewall queries, extension source shipped publicly on the store). Nothing was modified, killed, or touched on the Cold Turkey install, and **no private data was read** — the statistics SQLite databases were only listed by name/size, never opened.

---

## Executive summary

Cold Turkey Blocker is, architecturally, **a thin MV3 sensor extension plus a single .NET LocalSystem service** — the exact same split SmartBlocker already uses (extension + Rust companion over Native Messaging). There is **no network interception**: no proxy, no VPN, no hosts-file writes, no TLS MITM, and its only firewall rules exist to keep *its own* traffic alive. Its legendary "toughest blocker" reputation comes from a **deep, aggressively layered anti-tamper ladder** in the desktop service — not from sophisticated blocking mechanics.

Where SmartBlocker is already superior: per-page semantic classification (CT has only URL wildcard/title matching), a fully local block page (CT's block page is *remote-hosted* on getcoldturkey.com and pings their analytics), zero network in the enforcement path, fail-closed DNR force-redirects, on-device learning, Linux support (CT has none), and open source.

Where Cold Turkey is ahead — and what SmartBlocker can learn, prioritized:

1. **Extension-presence enforcement done right.** CT's extension is *required*: too many seconds without it during a locked block and the browser closes, with a **60-second grace countdown shown in advance** and re-checks every 10 s. SmartBlocker's companion does this, but only over heartbeats; copy CT's *explicit, user-visible grace UX* and its **first-run multi-browser extension installation funnel** (CT detects every installed browser and walks you through installing each extension, then verifies each one — SmartBlocker has no multi-browser onboarding at all).
2. **The anti-tamper ladder is a product feature, not an afterthought.** Confirmed on this machine: enforcement runs as an auto-start LocalSystem Windows service with a **randomized service name** (`Power_a17007`); optional "block Task Manager", "block time & date settings", "block the installer", "block inactive tabs", "block embedded content"; the uninstaller itself no-ops while a lock holds. SmartBlocker's companion has the daemon-side equivalents *architecturally* but ships the Chromium/Firefox policy writers OFF and has no Windows build verification.
3. **Breaks are the missing product dimension.** CT sells Pomodoro, Allowance (rolling windows with idle-awareness), Reward (earn breaks by working), Sessions, Random-text breaks, Delay breaks, and "Pause for a Cause". SmartBlocker's locks are extend-only with zero shortening path — there is no break concept at all. This is the single biggest feature gap, and it is also what users *love* about CT in reviews.
4. **Statistics as a retention loop.** CT tracks per-site/app usage locally (including incognito, surviving history clears), shows block counts, and exports JSON — 199 MB of SQLite on this machine proves people keep it for years. SmartBlocker's history scan is a 200-entry diagnostic, not an ongoing feedback loop.
5. **Random-text lock works fine despite ROADMAP's concern.** ROADMAP says random-text was deferred because "paste can't be reliably blocked"; CT ships it anyway (user types 1–5,000 chars on the block page; the *service* gates the unlock, so paste-blocking is irrelevant to enforcement). The real defense is that the unlock decision never trusts the page.
6. **Multi-user targeting, multi-list blocks, per-list schedules, per-user granularity, import/export of block lists, CLI automation** — all productized in CT, all absent in SmartBlocker.

The rest of this document: §1 how CT works (verified), §2 the wider landscape, §3 side-by-side gap matrix, §4 recommendations for SmartBlocker (P0/P1/P2), §5 what *not* to copy, §6 what SmartBlocker already does better, §7 a safe hands-on test plan, §8 local evidence appendix.

---

## 1. Cold Turkey Blocker, under the hood

Version observed on this machine: **desktop 4.9.0.0** (`ProductVersion`, `Cold Turkey Blocker.exe`), **Edge extension 4.9.7** (Manifest V3). Observed components:

| Component | Path / identity | Role |
|---|---|---|
| Main app (UI + settings) | `C:\Program Files\Cold Turkey\Cold Turkey Blocker.exe` (~2 MB, .NET; Newtonsoft.Json, System.Data.SQLite, Microsoft.Win32.TaskScheduler) | WinForms shell embedding an **IE WebBrowser control** (`Interop.SHDocVw.dll`) that hosts `web\index.html` (227 KB, jQuery + Bootstrap + Flot + moment + jquery-weekcalendar). UI talks to C# through `window.external.*` bridges (`InstallBrowserExt`, `AddApplication`, `CheckProductKey`, `ImportUrlsFromFile`, …). |
| Enforcement service | `ServiceHub.Power.exe` as Windows service **`Power_a17007`** (LocalSystem, StartMode=Auto) | The heavy lifter: app kills, device blocks, watchdog, clock protection. **Service name randomized per install** (`Power_` + hex) — hard to find/stop; trade name absent from DisplayName too. `ServiceHub.Helper.exe` runs alongside; `CTServiceInstaller.exe` re-installs it. |
| Native Messaging hosts | `CTMsgHostChrome.exe`, `CTMsgHostEdge.exe`, `CTMsgHostFirefox.exe` (+ *.json manifests) | **One dedicated host binary per browser** (vs SmartBlocker's single relay). Manifests pin `allowed_origins` to exact store extension IDs: Chrome `pganeibhckoanndahmnfggfoeofncnii` + `efnolkfmdbinpkbnfigocgfglnhahldj`, Edge `jfphahkinplobmabmgjmjgflbhjjddeb`, Firefox `coldturkey@getcoldturkey.com` (allowed_extensions). Registered in HKCU **and** HKLM Edge/Chrome and HKCU Mozilla. |
| Data | `C:\ProgramData\Cold Turkey\` — `data-app.db` (69 KB), `data-browser.db` (131 MB), `data-helper.db` (199 MB), `data-service.db` (1.7 MB), `locked` (0-byte sentinel), `logs\error.log` | Per-component SQLite split: settings / browser stats / helper stats / service state. The empty `locked` file = **filesystem-level lock sentinel** that survives app restarts and storage wipes. |
| Firewall | 10 Windows Firewall rules named "Cold Turkey Blocker" — all **Allow, in+out, program=its own exe, Any profile** | Not for blocking you — for **self-preservation**: CT's own traffic (remote block page, update check, Paddle) must survive the "block the entire internet" state. |
| Uninstaller | `unins000.exe` (Inno Setup) | No-ops ("Next" does nothing) while any lock is active. |

### 1.1 Website blocking pipeline (from the shipped extension source)

`ctContent.js` (10 KB) is injected at `document_start`, `all_frames`, `<all_urls>`. Per navigation it asks the background (`ctBackground.js`, 74 KB) → `chrome.runtime.connectNative('com.coldturkey.coldturkey')` → the service, which is the **single source of truth** for block lists, locks, breaks, stats:

- `checkBlockUrl {site, embedded}` — domain/path/wildcard matching
- `checkBlockTitle {title, site, embedded}` — **window-title blocks** (Pro/Windows; `*sports*` kills any tab whose title contains "sports")
- `checkBlockYouTube {url, channel}` — channel extracted from `ytd-video-owner-renderer a[href*='/@']`, with a 500–5,000 ms retry loop until the SPA renders it; listens for `yt-navigate-start` and *removes stale owner anchors* before re-checking
- `checkBlockAdult {url}` — triggered when `<meta name="rating" content="RTA-5042-1996-1400-1577-RTA" or "adult">` — adult blocking is **RTA-meta-tag driven**, not a porn list
- Google Search autocorrect: every `&spell=1` "did you mean" link is re-checked against the URL list — closes the "misspell your keyword search" bypass on day one

On `"block"`, the content script calls `window.stop()`, kills page workers/events, then replaces `document.documentElement.innerHTML` with a single web-accessible iframe `ctFrame.html`. `ctFrame.html` loads **https://getcoldturkey.com/blocked/4.9/… — the block page is remote-hosted.** Break/undo buttons on that page `postMessage` back through `ctFrame.js` (`unblock-tab`, `start-delay`, `stop-delay`, `start-break`, `start-randomText-break`, `reload-delay`) which forwards real RPCs to the service. The `reason` blob (blockId/type/rule/lock/password/randomText) is passed base64url-encoded in the query string.

Anti-tamper details inside this pipeline, all verified in source:
- **Service-worker neutering on every page** at document_start: `navigator.serviceWorker.register` replaced with a rejecting stub, `controller` forced null — so a blocked site's SW can never serve content around a block. (Side effect: PWAs offline mode dies everywhere; CT accepts that.)
- A repeating 500 ms watchdog: re-`muteTab`s the tab, exits/dismisses Picture-in-Picture, and **deletes any iframe that isn't `chrome-extension://`** — the block frame can't be swapped, covered, or removed by surviving page code.
- SPA hardening: re-checks on `popstate`, `pageshow` (bfcache restore reloads if blocked), `visibilitychange`, YouTube's navigate events.
- `restrictYouTubeControls` option hides endscreen/suggestion overlays + next/prev buttons on embedded YT players and auto-closes the miniplayer — blocks the "watch inside an allowed site" soft-bypass.

The extension **is only a sensor/actuator**: its own store description is the threat — *"Edge may be blocked if this extension is disabled or removed during a locked block."* Enforcement of that threat lives in the service.

### 1.2 App blocking, device blocks, statistics

- App list config: exe path, **whole folders** (also blocks *browsing* that folder in Explorer), Microsoft Store apps, and window titles (Pro/Windows). Blocked exes get a **filesystem-level lock mid-block** so they can't be renamed/moved away. Enforcement is process termination from LocalSystem — it can kill anything.
- **Device blocks / Frozen Turkey**: lock, log off, or shut down the machine on a timer or weekly schedule.
- **Statistics** (idle API + tab URLs + service-side app tracking): per-site/app usage, block counts; explicitly *survives browser-history clears and includes incognito*; stored locally in the SQLite DBs above; JSON export. The UI (Flot charts) ships in the embedded page.

### 1.3 Locks and breaks (the actual product being sold)

All locking features are **Pro (CA$49 one-time)**. Free = block websites, exceptions, timed blocks, statistics.

**Lock types** (per-block, each locks a block's config *and* its on-state): **Timer** (extendable end time), **Time range** (editable only outside chosen hours), **Random text** (type 1–5,000 chars — marketing/guide disagree on max; hosted block page makes you type it, service verifies), **Delay** (countdown 1 min–40 days), **Schedule** (locked during scheduled windows, optionally *up to a day before* they start), **Restart** (reboot to unlock), **Password** (accountability-partner use), plus an app-wide **settings password** (can't be removed without reinstall — by design).

**Break types** (per-block): **Pomodoro**, **Allowance** (N minutes per rolling window or per block/day/week/month, custom refill time, **idle-aware**), **Reward** (earn break minutes by working X; expire per block/day/week/month), **Sessions** (N openings of blocked items; session ends after a couple of idle minutes), **Random-text break**, **Delay break**, **Pause for a Cause** (donate to WWF → 10-minute break, disable-able).

**Autostart blocks**: one-time, time-of-day, on sign-in/wake, or at next scheduled window — closes the "I forgot to turn my block back on" relapse path. Plus a click-and-drag weekly schedule, multiple named blocks (each with websites/exceptions/applications tabs, wildcards `*`, `*.*` = "block the entire internet except…"), txt import/export of lists, category imports (pre-made lists), per-block **affected Windows users** (shared-computer targeting), and a **CLI** (`-add/-start/-stop/-toggle/-lock/-password/-random-text …`) that third parties automate (e.g., Raycast integrations). Blocking "power" toggles: block inactive tabs, block embedded content, **block the task manager**, **block time/date settings**, block macOS Screen Time settings.

### 1.4 The anti-tamper ladder (bypass → defense, as documented publicly)

| Bypass attempt | CT defense |
|---|---|
| Uninstall the app | Locked block ⇒ uninstaller wizard no-ops; optional **block-the-installer** kills re-run-installer tricks |
| Kill processes from Task Manager | Service self-restarts in ~2s; optional **block Task Manager**; randomized service name `Power_a17007` makes targeted `net stop` harder (community rename-the-exe bypass from 2022 appears closed by this + filesystem locks) |
| Change system clock | Optional **block time & date settings**; guide recommends app-blocking cmd/PowerShell/regedit for other clock paths |
| Disable/remove the extension | Lock ⇒ **browser closes** (60 s visible grace countdown, re-checked every 10 s); optional "block browsers whose extension crashed" |
| Use an unsupported/no-extension browser | Lock ⇒ desktop closes "unsupported browsers"; Brave Tor windows & guest browsing specifically blocked |
| Incognito | Extension demands incognito permission during setup (dedicated permission funnel pages with screenshots); stats cover incognito anyway |
| Edge Split View | Extension detects `splitViewId` on tab update and forcibly moves the URL to a normal tab with a notification ("Extensions aren't allowed there") |
| Misspelled keyword searches | Google `&spell=1` suggestion links re-checked against block list |
| Watch via embedded player on an allowed site | `checkBlockUrl(..., embedded=true)` when `blockEmbedded` is on; YT control restriction |
| `document.documentElement` edits by page JS | Page JS is dead (window.stop + innerHTML replace + event/worker kill); 500 ms sweep removes foreign iframes |
| Site service worker serving cached content | SW API stubbed out globally at document_start |
| New Windows user / other account | Per-block affected-users targeting; settings password |
| Safe Mode | **Documented as surviving bypass** (boot Safe Mode, rename install folder; an official removal tool exists). Community workarounds (`reagentc /disable`, bcdedit flags, blocking msconfig) are user-land hardening, not shipped. CT does not pretend to defend this. |

Observed live on this machine supporting the ladder: LocalSystem service auto-started, both HKCU+HKLM native-messaging registrations, 0-byte `locked` sentinel, firewall allow-rules for itself.

### 1.5 Privacy posture — the honest trade CT makes

Marketed as "keep your data, we don't collect it" — settings/stats are local. But notice two seams SmartBlocker avoids: **the block page is a remote URL** (getcoldturkey.com serves it with Matomo analytics + Paddle scripts — every block is a ping to their server, with your block reason in the query string), and the extension requires `<all_urls>` host access plus sends **every page URL + title to the desktop service** over NM (fine — local — but paired with the remote block page it weakens the "fully local" claim). Update check at launch; security logs ≤2 months.

---

## 2. The wider blocker landscape

Full detail in `docs/research/2026-11-07-blocker-landscape-research.md` (~25 targeted searches; sources cited there). Condensed lessons:

### 2.1 Mechanism map — how everyone else blocks

| Product | Mechanism | Enforcement strength | Weakness observed |
|---|---|---|---|
| **Cold Turkey** | Extension sensor + LocalSystem service; no network interception | ★★★★½ | Safe Mode; needs admin; no Linux |
| **FocusMe** | Desktop app + **Extra Protection Service** (relaunch guard, install-dir guard, safe-mode autostart, blocks task managers & 3rd-party uninstallers, PowerShell-history protection, downgrade prevention) | ★★★★★ (best-documented ladder) | $17.95/mo resentment; config complexity |
| **Freedom** | **Local proxy** on desktop + local-VPN profile on iOS; cloud sync of lists | ★★ | Proxy breaks desktop apps (hence "non-proxy mode"); Screen-Time toggle kills iOS; process kill kills desktop |
| **SelfControl** (macOS, GPL) | Privileged daemon `selfcontrold` + **`pf` firewall rules** | ★★★★ (app-deletion & reboot can't lift) | IP-level rules over-block CDNs/shared hosting; no schedule; 24 h cap |
| **Plucky** | Extension + local `pluck` binary; MIME-aware partial blocking | ★★★½ | CLI learning curve |
| **LeechBlock NG** (OSS) | **Pure extension** | ★★ | "Friction for the willing": removable like any extension, guest/new-profile escapes |
| **Opal / one sec / ScreenZen / Forest** (mobile) | iOS Screen Time API trio (FamilyControls/ManagedSettings/DeviceActivity) / Shortcuts automations | ★½–★★½ | shield flakiness; setup friction |
| **Focus AI** (getfocusai.com) | Extension-only, **cloud LLM judges each page against your stated task**; quit-wall typed surrender | ★½ | cloud latency/cost/privacy; trivially removable |

**Takeaway:** network-layer approaches (proxy/VPN/pf) trade correctness problems (app breakage, CDN over-blocking) for strength; the winners avoid the network and win on *process supervision + commitment design*. Nobody ships **local ML classification + OS enforcement** — the square SmartBlocker is already standing on. (`Focus AI` is the closest philosophical analog but is cloud-LLM and extension-only; `focus-shield` is an open-source "why are you visiting?" LLM bouncer that grants timed passes — worth reading for break-UX ideas.)

### 2.2 The commitment-design canon (delays, ratchets, surrender)

Best-documented protection ladder — **FocusMe** (`docs.focusme.com/concepts/plan-protection`): presets Unlocked → Gentle Guidance (5 random chars) → Firm but Flexible (10 chars + 2 min wait) → Lock it Down (25 chars typed *perfectly* + 10 min wait); per-plan challenges (random chars 1–2,000, passwords, Enforced=impossible, Disallowed); *stop-waits before/after* the challenge; **ratchet-only editing of running plans (stricter only)**; **accountability partners** whose addition activates after **24 h** (defeats "I'll add a fake partner now"); **monetary commitment fee** on assisted stops. **Plucky** substitutes *time for passwords*: any access-increasing change takes effect after the delay; *lowering the delay itself waits out the delay*; uninstall allowed only at delay 0; trusted-person "expedite" approval.

SmartBlocker already has ratchet-only transitions (extend always/shorten never) and offline password arms — the missing canon pieces are: **stop-waits (delay), random-text challenges, partner/approval flows, and partner-activation delay**.

### 2.3 Intervention UX — hard evidence

The **only peer-reviewed anchor** found: Grüning, Riedel & Lorenz-Spreen, *PNAS* 120(8) e2213114120 (2023), field study of **one sec** (N=280, 6 wk; N=500 preregistered follow-up): an **interstitial on app open ⇒ 36% of opens dismissed there, 37% fewer open attempts, 57% total use reduction, satisfaction up**. Component analysis: **the easy "dismiss/close" affordance was the strongest element; the delay also worked; the deliberation/moralizing message did nothing.**

Design implications for SmartBlocker's block screen and future break UX: lead with an easy exit (close tab), include a short delay before any bypass affordance, and drop guilt-trip copy. SB's current block screen (close-tab-only under locks; override button otherwise) is already aligned; the lesson applies to where break buttons are placed.

Retention pattern across Opal/RescueTime/Forest/FocusMe: **one moving number + weekly digest + visible accumulated record** (Focus Score®, productivity-score weekly email, growing forest, weekly blocked-count recaps). CT's "how many times things were blocked" charts are the desktop example.

### 2.4 Keyword/content blocking elsewhere

LeechBlock's `~keyword` (title/body substring, `_`=space, `*`=intra-word) is the state of the art in *string* matching; CT has title rules + RTA meta; Deledao (K-12) does cloud page-content AI. **Semantic per-page classification is the open square** — confirmed by both research directions converging on it (this audit + the AI-blocker newcomers, all of whom chose cloud LLMs with their latency/cost/privacy penalties).

### 2.5 Pricing signal

Category-wide **subscription resentment** is the top complaint (r/nosurf + review-changelog mining); one-time (Cold Turkey CA$49, Forest $3.99) and free-OSS (LeechBlock, SelfControl, Plucky) earn outsized goodwill. FocusMe $17.95/mo and Opal $19.99/mo are recurring complaint fuel. **SmartBlocker's "free core + one-time-ish offline Pro" positioning is validated by the market's revealed preference** — keep it.

### 2.6 Unmet needs (SmartBlocker attack surface)

1. **In-feed distractions on allowed sites** (Shorts/Reels inside otherwise-useful YouTube) — explicitly flagged as a gap *by competitor blogs themselves*; SB's SERP/embed sanitizer + classifier is already ahead here.
2. Per-*page* granularity vs per-domain (everyone else blocks domains).
3. Blocking that understands *why* you're on a page (SB focus context).
4. Coach-style stats + weekly reports (nobody does this without cloud).
5. Local privacy (several incumbents sync lists/stats to their cloud).

---

## 3. Side-by-side gap matrix

Legend: ✅ shipped · 🟡 partial/behind-flag · ❌ absent · ➖ not applicable

| Capability | Cold Turkey 4.9 | SmartBlocker (2026-11-07) | Notes |
|---|---|---|---|
| **Blocking intelligence** |
| URL domain/path/wildcard matching | ✅ `*` wildcards, path prefixes, `*.*` all-internet | 🟡 blocklist = substring-only; wildcard text is *stripped, not honored* on paste (`domains.ts`) | Narrow SB gap; wildcard semantics are trivial to add next to `matchedBlocklistEntry` |
| Window/tab **title** blocking | ✅ Pro/Windows (`checkBlockTitle`) | ❌ (title is a *classification signal*, never a deterministic rule) | Cheap addition: a "title rules" list evaluated beside the URL blocklist |
| **Semantic page classification** | ❌ none — no ML anywhere | ✅ bge-small centroids, 15,874-case eval harness, top-2 mass, focus context | SB's moat. CT can't tell "React Router Tutorial" from "Minecraft" |
| Category block lists | ✅ pre-made importable categories | ✅ 6 blocked / 13 labels, user-composable | Parity, but CT ships ready-made *lists*; SB ships a model |
| YouTube channel block | ✅ `checkBlockYouTube` + owner-anchor retry loop | ❌ channel extracted only as a *signal*; can't allow/block channels | High-value: "allow Ali Abdaal, block MrBeast" is unwinnable for URL lists — but easy for SB given it already extracts the channel! |
| Keyword **search** blocking | ✅ wildcards on search URLs + Google `&spell=1` closure | 🟡 SERP sanitizer masks distraction cards; no blocked-keywords rule | SB approach (mask, don't block) is arguably better UX |
| Embedded content blocking | ✅ opt-in, incl. YT control restriction | ✅ `frameIds` verdict injection, works through closed shadow roots | SB is *stronger* here |
| Adult-site blocking | ✅ RTA meta tag + `*.xxx` | ❌ | One-line check of `meta[name=rating]` in `extract-meta.ts` |
| **Enforcement & anti-tamper** |
| Architecture | Ext + LocalSystem service + NM hosts | Ext + Rust daemon + nm-host + watchdog | Same split; SB's protocol (v2, TOFU pairing, redaction) is more hardened |
| Extension required during lock | ✅ 60 s visible grace, 10 s re-checks, closes browser | ✅ heartbeat watchdog closes extensionless browsers | Parity in mechanism; CT's **user-visible countdown** is better UX |
| Multi-browser detection/install funnel | ✅ finds every installed browser, walks installs, verifies each | ❌ none | CT closes "just open the other browser" at setup time |
| Unsupported-browser policy | ✅ closes them during locks | ✅ 30+ kill list, behavioral fingerprinting (stronger than CT's filename matching) | SB stronger (rename-proof) |
| Task-manager blocking | ✅ opt-in | ❌ not applicable on Linux; Windows phase pending | CT-only for now |
| Clock-change defense | ✅ block time/date settings (opt-in) | ✅ monotonic anchor in *both* ext + daemon (stronger, always-on) | SB mechanism better; CT adds UI-lockout |
| Uninstall prevention | ✅ uninstaller no-ops while locked | ✅ daemon `uninstall` refuses on `settings_locked` | Parity (SB Linux-verified; Windows TODO) |
| Safe Mode survival | ❌ (official removal tool exists) | ❌ (safe mode/live USB out of scope) | Same residual; CT is honest about it, SB should be too |
| Randomized/hardened service identity | ✅ `Power_a17007` random suffix | 🟡 recorded-PID immunity + decoy kills (better on defense, but name is fixed) | On Windows, SB should randomize the service name per install |
| Extension policy pinning | 🟡 store-install + NM presence enforcement | 🟡 `policy.rs` ships **OFF**; store listing pending | Must turn ON with the Phase 3 store listing |
| **Commitment UX** |
| Lock types | ✅ timer / time-range / random-text / delay / schedule / restart / password | 🟡 timer / password(PBKDF2) / schedule / Frozen-Turkey | Missing: random-text, delay, restart, time-range |
| Random-text lock | ✅ 1–5,000 chars, service-gated | ❌ deferred ("paste can't be blocked") | See §4-P1 — the deferral rationale is wrong; CT proves it |
| **Breaks** | ✅ pomodoro / allowance / reward / sessions / random-text / delay / charity | ❌ none — locks are extend-only, zero shortening path | **Biggest single product gap** |
| Autostart blocks | ✅ time / sign-in / next-schedule | ❌ (schedules exist; no "auto-resume after disable") | Closes the relapse loop |
| Per-list/weekly schedules | ✅ per-block click-drag weekly grid | 🟡 single global `schedules[]`; in-window locks everything | SB needs per-category/per-list schedule scoping |
| Block page | ✅ remote-hosted, quotes, break buttons | ✅ fully local, zero egress, tamper-proof DNR force-redirect mode | SB stronger on privacy/tamper; CT stronger on break UX |
| **Stats & feedback** |
| Usage statistics | ✅ per-site/app, incognito-inclusive, survives history clear, charts, JSON export | 🟡 200-cap one-shot history scan + latency log; no continuous tracking/dashboard | Second-biggest product gap — stats drive CT's retention |
| Learning from corrections | ❌ | ✅ centroid updates, eval-harness regression gating | SB unique |
| Feedback to vendor | ❌ (none by design) | 🟡 opt-in worker (deployed 2026-11-06; PRIVACY.md stale) | SB unique; fix the doc drift |
| **Administration** |
| Multi-user selection | ✅ per-block Windows users | ❌ | Family/team angle |
| Settings password | ✅ (permanent-ish) | 🟡 password lock exists (per-lock) | Parity-ish |
| Import/export | ✅ txt lists + whole blocks | 🟡 corrections export only |  |
| CLI automation | ✅ documented params | ❌ | Cheap to add on the daemon socket; enables Raycast/Alfred ecosystems |
| Affected platforms | Windows + macOS only | Chrome/Edge/Firefox ext + **Linux** companion (Windows unverified) | SB owns Linux; CT ignores it by choice |
| Pricing | Free + CA$49 one-time Pro | Free + offline HMAC Pro (planned) | Same model foreseen |

## 4. Recommendations for SmartBlocker

Ranked by (impact × feasibility). CT provenance noted for each.

### P0 — do first (1–2 day wins, high leverage)

1. **YouTube channel allow/block lists.** SB already extracts the channel (`extract-meta.ts`); CT's whole YT feature is just a per-channel URL list with an SPA retry loop. Add `channelRules: {allow:[],block:[]}` consulted before the classifier, and this beats CT semantically (SB can *also* classify within an allowed channel). CT's 500 ms→5 s owner-anchor retry loop (§1.1) is the reference implementation, incl. removing stale owner anchors on `yt-navigate-start`.
2. **Title rules.** `*sports*`-style case-insensitive title substrings evaluated beside the URL blocklist, skipping inference. CT charges Pro money for this; it's ~30 lines next to `matchedBlocklistEntry`.
3. **Breaks v1: Delay break + Random-text break on the block screen.** CT makes the *service* gate the unlock — the page never decides. SB equivalent: the block screen collects the request, `lock.ts` holds the only legal transition (`breakUntil` field, extend-only semantics preserved: a break *schedules re-block*, never shortens the stored lock). This kills two birds: it reframes random-text not as a "lock" (the ROADMAP concern) but as a *break friction cost* — which is how CT actually positions it — while keeping the lock invariant intact.
4. **Random-text and Delay lock types.** Now that the gate is server-side-equivalent (`lock.ts`), implement `randomTextLen` + `delayUntil` fields: unlock RPC accepted only after the delay elapsed / after a challenge token is produced by typing the shown string. CT's caps: delay 1 min–40 days, text 1–5,000 chars.
5. **Visible extension-loss grace countdown.** When the companion marks a browser's heartbeat stale during a lock, surface a notification/banner *before* closing ("extension lost — browser closes in 60 s, restore to cancel"), re-check every 10 s, exactly as CT does. Cheap UX, prevents the "why did my browser die" support burden, and makes the enforcement feel fair rather than flaky.
6. **Autostart/resume.** "Re-enable blocking on next sign-in / at next scheduled window after a disable" (CT Autostart Blocks). In SB: a `resumeAt` persisted beside settings, enforced by `lock-enforcer.ts`'s alarm path. Closes the relapse loop users hit in real life.
7. **RTA adult-tag check.** One meta-tag probe in `extract-meta.ts` → instant block/classification signal; CT's entire adult-blocking feature is this plus `*.xxx`.
8. **Typed-surrender quit wall (borrowed from Focus AI / FocusMe "Lock it Down").** Before any override outside a hard lock: require typing a fixed surrender string ("I am choosing to give up") or N random chars typed *perfectly* (FocusMe restarts on a typo — the typo-restart is the cheap genius part). Pairs with the PNAS finding (§2.3): the deterrent is effort + delay, not guilt copy.

### P1 — product depth (weeks)

8. **Breaks v2: Allowance + Reward + Sessions + Pomodoro.** The CT semantics to copy: allowances tracked per rolling window **with idle-awareness** (CT uses the `idle` API — SB's extension already has alarms; add `idle` permission), reward minutes that accrue and can **expire** per block/day/week/month, sessions that end after a couple of idle minutes. Storage fits SB's storage.local model; enforcement must stay monotonic — breaks are *budget grants*, stored as separate keys so the CRDT merge order can't be abused to stack them.
9. **Ongoing usage statistics + dashboard.** Per-day per-category per-site counters in the extension (idle-aware active-tab time — CT uses `idle` + tab URL streams; SB has both). Local-first, JSON export (CT parity), and a "top distractions this week" chart in options. This is CT's #1 retention feature, and it feeds SB's unique loop: stats → "should've been blocked" suggestions → centroid learning. Track **incognito-inclusive and history-clear-independent** by computing from tab events, not `chrome.history` (CT advertises exactly this).
10. **Multi-browser onboarding funnel.** Detect installed browsers (the companion can), generate per-browser install instructions/links (CT's dedicated `ctPermissions/ctPrivatePermissions/ctFilePermissions` pages with screenshots are the template — including the *incognito-access* and *file-URL* asks), and verify each extension reports in. Runs at companion install time. Directly closes "just open the other browser" — the #1 naive bypass.
11. **Windows companion verification + hardening parity.** CT's service-name randomization, filesystem lock on blocked exes during blocks, Task-Manager blocker, and "block the installer" are the concrete Windows checklist for `companion/` Phase 4's remaining TODO (ROADMAP: "Manual Windows verification + signed installer"). Land the store listing → flip `policy_enforce` to true (Chromium `ExtensionSettings` can't force-install on consumer, but *can* extension-block/disable removal on managed browsers; document the honest residual as CT does).
12. **Wildcard support in blocklist + whitelist.** CT's grammar (`*` anywhere, domain/path prefix rules, `*.*` everything) is well understood by users; implement as compiled regexes with the strip-not-honor behavior removed from `domains.ts` (or keep stripping but say so in UI — currently silent).

### P2 — differentiators and admin features (months)

13. **CLI + socket API on the daemon** (`smartblocker-daemon block start|stop|toggle`, `lock`, `random-text …`). CT's CLI spawned third-party automation (Raycast). SB's IPC is already authenticated; expose a narrow blocking subset.
14. **Per-category schedules** ("block video games only weekdays 9–17", "allow Reddit after 18:00"): schedules currently lock *everything* in-window; scope them to category sets first (cheap), then to URL lists (needs per-list config = new UI).
15. **Per-user / affected-users selection** (Windows: which local accounts a block hits). CT does per-block. Real family/team use case; depends on §11.
16. **"Block my computer" device blocks.** CT's Frozen Turkey is a *device* block (lock/logoff/shutdown) — a deliberate renaming trap: CT's "Frozen Turkey" = SB's "Frozen Turkey" naming collision, but CT's is device-level while SB's is browser-level. Consider a true device-lock mode in the companion for parity-on-name, or rename to avoid confusion.
17. **Block-page break buttons (remote-page-free).** CT runs break UX from a hosted page with postMessage relays; SB can do the same UX locally on `blocked.html`/blockscreen with zero network — then add CT's "Pause for a Cause"-style charity break (donate → 10 min) as a differentiator once the P0 break plumbing exists.
18. **Adopt the REA loop for regression-testing against CT behavior** (see §7.3): use `morluto/rea`'s inspect→evidence→reimplement→test framing to keep a **behavior-parity checklist** for the extension (SW-neutering decision aside, the checklist in §1.1's anti-tamper bullet list is directly convertible into new e2e cases, e.g. "block frame survives foreign-iframe injection", "bfcache restore re-blocks", "Google spell-link closure").
19. **Accountability-partner flow (FocusMe + Plucky patterns fused).** Partner-held unlock: user designates a partner per lock; unlock requires a code the partner holds (offline-verifiable — SB already has `SBPRO1` HMAC tooling to sign one-time codes); **adding/changing the partner takes effect only after 24 h** (FocusMe's anti-circumvention delay — you can't appoint a sock-puppet in a weak moment); optional **expedite approval** channel = Plucky's trusted-person skip. This turns the password lock from "weak accountability" into a real social primitive without any server.
20. **Stats → learning flywheel surface.** When the dashboard (P1.9) ships, add the CT-style "how many times things were blocked" counter + the landscape-proven weekly digest (one email-less local notification). SB's differentiating stats nobody else can offer: override rate per category (FP proxy), centroid drift, focus-context rescue count.

## 5. What NOT to copy

Decisions CT made that conflict with SmartBlocker's stated values (local-first, privacy, minimal permissions, open source):

- **Remote-hosted block page.** Every CT block pings getcoldturkey.com (with their Matomo analytics + Paddle script and the block reason in the URL). SB's local `blocked.html`/overlay is strictly better on privacy and works offline. Never move break UX to the network.
- **Global service-worker neutering.** CT stubs out the SW API on *every page* — brutal, breaks PWAs/offline apps. SB's fail-closed DNR force-redirect already removes hostile DOM entirely; no need to break the web platform.
- **`<all_urls>` host-permission funnel as a hard gate + popup-disabled-until-service** (CT literally `chrome.action.disable()`s when the port is down). SB's quieter incognito warning + graceful free-tier degradation is the better posture for a store-listed extension; keep enforcement in the companion, not in permission brinkmanship.
- **Admin rights as an install requirement.** CT needs admin for good reasons, but SB's tiering (extension-only soft tier works with zero install rights) is worth *preserving* — don't let the companion become mandatory.
- **jQuery-era embedded-IE settings UI.** Aspirational in 2015; SB's React/Tailwind design system is a generation ahead. The lesson from CT's UI is *scope of surface* (blocks grid, break editor, charts), not the stack.
- **`.xls`-style one-way doors like "settings password can't be removed without reinstall"** — CT gets away with it; with SB's open source it's theater. Prefer honest mechanisms (CT's are mostly honest; this one isn't).

## 6. What SmartBlocker already does better than Cold Turkey

1. **Semantic classification, full stop.** CT cannot distinguish "Elden Ring boss guide" from "Elden Ring lore video", and wildcards can't whitelist "only r/productivity on Reddit". SB's 95.4%-top-1 / 0.4%-FP embedding classifier + focus-context rescue is a capability CT has zero of.
2. **Zero network in the enforcement path.** Block page, fonts, model (post-download), decisions — all local. CT phones home on every block.
3. **Fail-closed force mode.** SB's DNR redirect to extension-owned `blocked.html` means a force-blocked page has *no hostile DOM at all*; CT still navigates to the page and rewrites it post-load (extinguishing workers after the fact).
4. **Behavioral browser fingerprinting.** CT identifies "unsupported browsers" by executable identity lists; SB's renderer-cmdline fingerprint survives rename-spoofing (`brave.exe` → `chrome.exe` gains nothing), and its decoy-PID immunity is a cleaner protection model than CT's.
5. **The eval harness as a product weapon.** 15,874-case regression gate with per-slice diffs; CT's blocking logic is untestable-by-design (opaque lists). SB can *prove* non-regression on every release — a marketing asset.
6. **On-device learning + collective opt-in.** CT has static lists, forever. SB's centroids improve per user and (opt-in) globally.
7. **Linux.** CT deliberately has none. SB's companion is Linux-first and e2e-verified.
8. **Open source + honest security model.** SB documents residuals (Electron carve-out, window-level incognito, same-uid token reads) in-repo; CT's equivalent admissions are scattered across Reddit/support answers.

## 7. Hands-on test plan (safe, no risk to this laptop)

**(a) Already-done live inspection (this audit):** CT install on this machine examined read-only — no writes, no process kills, no service interaction. Repeatable anytime with the commands in §8.

**(b) Browser-level behavior tests (safe):**
- Watch CT's block page on a blocked site in *a throwaway browser profile* (new Edge profile + CT extension removed there is still risky if a lock is active — **only test while NO lock is armed**).
- Use F12 Network on a blocked page to confirm the remote block-page load + params.

**(c) Open-source references — full local testing, zero risk:**
- **LeechBlock NG** (`proginosko/LeechBlockNG`, MPL): install in a scratch profile; study its lockdown mode, keyword blocking, options password, and especially its **time-limit** UX — the closest free analog to CT allowances.
- **Open Turkey** (`bdcdo/open-turkey`, Go, MIT): the 4-layer enforcement + 5 s re-apply watchdog loop is directly comparable to SB's daemon — read `main.go`, run in a VM.
- **Focuser** (`aadeshrao123/Focuser`, Rust, MIT): extension + Rust native-messaging host — the nearest public architecture sibling; its candid "NM bridge unwired, HTTP fallback is what works" docs are a cautionary tale for SB's NM-first design.
- **SelfControl** (macOS, GPL): `pf`-rule irreversibility semantics — reference for "can't undo even by deleting the app".
- **Chomper** (Python): small codebase, root-enforced hosts+timer: quickest read of the lot.

**(d) Commercial trials (only if wanted):** FocusMe 14-day trial (configurability benchmark: time limits, forced mode), Freedom (note *how easily* it's bypassed — the anti-pattern SB/CT both beat), Pluckeye (delay-based friction model — the "PUC" philosophy alternative).

**(e) Reverse Engineer Anything integration (optional):** install `npx rea-agents/setup` MCP in a *scratch* repo, point its JS analyzer at the CT Edge extension directory read-only to auto-generate the module/message-graph — validating §1.1 mechanically. Legal scope stays "study public artifacts" per REA's own disclaimer.

## 8. Local evidence appendix

All commands read-only; run from WSL via `powershell.exe -NoProfile` interop or the browser.

1. `Get-CimInstance Win32_Process | Where ExecutablePath -like '*Cold Turkey*'` → 4 running processes: `Cold Turkey Blocker.exe` (PID 9236), `ServiceHub.Helper.exe`, `CTMsgHostChrome.exe`, `CTMsgHostEdge.exe` (both NM hosts alive = both browsers attached).
2. `Get-ChildItem 'C:\Program Files\Cold Turkey' -Recurse -Depth 2` → full component inventory incl. `CTHostInstaller.exe`, `CTServiceInstaller.exe`, `Interop.SHDocVw.dll`, `web\index.html` (227,807 B), per-arch `SQLite.Interop.dll`.
3. NM manifests (`CTMsgHost{Chrome,Edge,Firefox}.json`) → `com.coldturkey.coldturkey`, stdio, pinned extension IDs/origins quoted in §1.
4. `reg query HKLM\SYSTEM\CurrentControlSet\Services\Power_a17007` → `Type 0x10 (own process), Start 0x2 (auto), ObjectName LocalSystem, ImagePath ServiceHub.Power.exe`.
5. `Get-NetFirewallRule -DisplayName 'Cold Turkey Blocker'` → 10 rules, all **Allow**, in+out, program=`Cold Turkey Blocker.exe`, Any — quoted in §1.
6. Edge extension `jfphahkinplobmabmgjmjgflbhjjddeb\4.9.7_0\manifest.json` → MV3, 6 permissions (`nativeMessaging tabs idle storage notifications alarms`), 1 host perm (`*://getcoldturkey.com/*`), `<all_urls>` content script at `document_start`, `all_frames:true`, `web_accessible_resources: ctFrame.html/js`, `key` pinned (ID stability).
7. `ctContent.js` — SW-neutering prologue, `checkBlockUrl/Title/Adult/YouTube` RPCs, `&spell=1` closure, block-page `innerHTML` replacement, 500 ms mute/PiP/foreign-iframe watchdogs, `restrictYouTubeControls` handlers — quoted in §1.1.
8. `ctFrame.js/html` — remote block page loader + postMessage relay command set — quoted in §1.1.
9. `ctBackground.js` — entry point: `connectNative('com.coldturkey.coldturkey')`, `chrome.action.disable()` until port, `oneMinute:Timer` alarm, `setUninstallURL`, Split-View eviction listener, `<all_urls>` permission gate.
10. `C:\ProgramData\Cold Turkey` listing (names/sizes only; DBs never opened): `data-app.db` 69 KB, `data-browser.db` 131 MB, `data-helper.db` 199 MB, `data-service.db` 1.7 MB, `locked` 0 B.
11. `web\index.html` grep → `window.external.{InstallBrowserExt,InstallEdge,InstallFirefox,AddApplication,CheckProductKey,ImportUrlsFromFile,…}` bridges; `pomodoro|allowance|reward|sessions|randomText|restart` break/lock vocabulary present.
12. `(Get-Item …Blocker.exe).VersionInfo` → ProductVersion 4.9.0.0.
13. Web (browsed in Edge via live session): getcoldturkey.com `/`, `/features/`, `/pricing/`, `/support/user-guide/`, `/blocked/4.9/…` — feature/lock/break/pricing copy quoted in §1.3/§1.5. Research agent's full public-source report: `docs/research/cold-turkey-blocker-audit.md`.
