# Competitive Research: Distraction Blockers — Technical Lessons Matrix (for SmartBlocker audit)

## TIER 1 — Deep Profiles

### 1. Freedom (freedom.to)
- **Mechanism:** Deskto p= **local proxy** + optional browser extension (the extension only renders the "green screen" block page; proxy does the blocking). "Non-proxy Mode" exists because the proxy breaks some desktop apps (support.freedom.to/kb/non-proxy-mode). **iOS = local VPN profile** (NEVPNManager-style, common in iOS ad-blockers) + Apple Screen Time API; Android equivalent. Sync of blocklists/schedules is **cloud-based** (account required) — that's how blocks span devices, but it means config lives server-side.
- **Anti-tamper:** Locked Mode (blocks ending/editing active sessions and prevents quitting the desktop app *only if* "disable quitting" is also enabled — per cisdem.com review, users can still quit otherwise); iOS uninstall protection (iOS 16+, Screen Time perms, blocks deletion of *all* apps).
- **Why people say it's easy to bypass:** Reddit r/nosurf threads: toggle off its Screen Time access in iOS Settings, quit the desktop process, or just use an un-managed browser/profile. The proxy also has a "Connectivity Assist" escape hatch (per their own App Store changelog).
- **Pricing:** $8.99/mo, $39.99/yr, $159.99 lifetime ("Forever"), 7-session free trial (tryhugo.app 2026 review; detox.so). Recurring complaint: subscription fatigue for what feels like a simple feature.

### 2. FocusMe (focusme.com) — *most configurable; best-documented anti-tamper besides Cold Turkey*
- **Mechanism:** Desktop app (Win/macOS/Linux) blocking sites + apps + full-computer lockouts; plans with rule modes Block / Time Limit / Session Limit / Screen Break / Time Goal; schedules, Pomodoro, multi-day (docs.focusme.com).
- **Anti-tamper ladder (docs.focusme.com/concepts/plan-protection):** 4 presets from **Unlocked** (1 click) → **Gentle Guidance** (type 5 random chars) → **Firm but Flexible** (10 chars + 2-min wait) → **Lock it Down** (25 chars *typed perfectly* + 10-min wait). Challenges per action (stop/pause/skip/allowlist): **Random chars 1–2000** (with "Perfect" = typo restarts), **Password**, **Enforced** (impossible until plan ends), **Disallowed**. **Stop-waits** before and/or after the challenge; "Cancel Stop" during countdown. Running plans editable **only to make stricter** (ratchet). **Accountability partners** approve stops by email/code; a partner added while plans run activates after **24 h** (anti-circumvention). **Assisted stop** via support can carry a **configurable commitment fee**. Master Password (or random-chars) locks the app UI itself.
- **OS-level (Windows, admin install):** Extra Protection Service (restarts FocusMe if killed, guards files), **Run in Safe Mode**, **Block Task Managers**, **Protect Uninstall + block 3rd-party uninstallers**, PowerShell-history protection, downgrade prevention (docs.focusme.com/platforms/windows).
- **Unique:** willingness to accept "you will never be able to stop this plan" warnings; plan library; CLI plan control.
- **Pricing:** $17.95/mo, $119.40/yr, $449 lifetime (5 PCs + 2 mobile) per focusme.com comparison pages (2026). An older heyfocus.com page cites $6.99/mo/$29.99/yr/$119.99 lifetime — pricing rose; treat exact numbers as volatile.

### 3. Pluckeye / "Plucky" (pluckeye.net, docs.pluckeye.net)
- **Open source, free (donation).** Browser extension + native "pluck" binary with CLI-style config (`pluck + allow a.com`).
- **Mechanism:** **Blocks all images/videos by default** ("Pluckeye blocks all images and videos from the Internet by default" — pluckeye.net FAQ); allow-everything-text / media-type-aware partial blocking — can block some content from a host while allowing other content based on **Internet media types (MIME)**. Optional full "system" block (old level-1/level-2 model now a boolean `system` flag).
- **Commitment mechanism = the delay (docs.pluckeye.net/delay.html):** any config change that *increases access* takes effect only after the delay; **decreasing the delay itself must survive the delay**; **uninstall only possible when delay = 0**. Delays can vary by time of day (`when 0-8 delay 3600`). **Expedite:** a trusted approver can skip the delay (= social accountability).
- **Lesson:** it substitutes *time* for *passwords* — no credentials to lose, and "config changes ratchet only slowly" is a robust commitment primitive SmartBlocker can borrow.

### 4. SelfControl (selfcontrolapp.com; github.com/SelfControlApp/selfcontrol, GPL)
- **Mechanism:** macOS-only. Since v4 a **privileged daemon (`selfcontrold`)** holds block state system-wide; blocking is done at the **network layer via `pf` (packet filter) rules** for resolved IPs of blocklist domains (historically also /etc/hosts). Because state lives in a root-owned daemon + pf, **quitting or deleting the app, or restarting macOS, does not lift the block** — the timer must expire ("It can not be undone by the app or by a restart" — repo tagline).
- **Simplicity lessons:** one job (timer + list), no accounts, no sync, no stats; max 24 h via UI slider. Known weaknesses: IP-level rules **over-block on shared hosting/CDNs**; no scheduling, no per-page granularity; occasional "blocked everything" bug reports; daemon migration issues across versions (commit history).
- **Anti-tamper = architecture, not friction:** root-owned daemon + kernel firewall beats any user-space trick. (SmartBlocker's Rust daemon follows the same principle.)

### 5. LeechBlock NG (proginosko.com; github.com/proginosko/LeechBlockNG)
- **Free, open-source, pure extension (Firefox/Chrome/Edge).** Up to 30 site sets; per-set time windows, time limits, or both; **lockdown mode** (immediate temporary block); delay page with countdown; password or random-access-code gate on the options page; wildcards `*`, exceptions `+`, referrer rules `>`, and **keyword blocking `~`**: case-insensitive, `*` intra-word wildcards, `_` for whitespace, matches against **page title or body text** (title-only option), *not* URL (URL keywords done via `site.com/**word` patterns). Requires "access data on all websites" permission for keyword/countdown features.
- **Documented weaknesses (the honest ceiling of pure-extension approaches):** can be removed/disabled from browser extension UI; Chrome guest mode and new profiles have no extensions; private-browsing windows need per-browser toggles; no OS-level enforcement; no cross-device sync of settings; keyword scans are literal string matches (false positives/negatives). One review noted an Edge build where the extension could be disabled without consequence (tooltivity.com).
- **Lesson:** a pure extension maxes out at "friction for the willing" — keywords-by-regex is what everyone ships; **content classification is the unclaimed step beyond**.

### 6. Mobile intervention-UX cluster
- **one sec (one-sec.app):** iOS = **Shortcuts Automations** per app (no private API) + free Safari extension; Android = accessibility-type interstitial. Peer-reviewed evidence below. Free for 1 app; Pro €3.99/mo, €14.99/yr, €99.99 lifetime (one-sec.app FAQ). Complaint: clunky per-app Shortcuts setup, automation lag (screenbuddyapp.com review).
- **Opal (opal.so):** built on Apple's **Screen Time API trio — FamilyControls (opaque app tokens, privacy: app never learns which apps), ManagedSettings (shields), DeviceActivity (schedule/threshold monitors, extension runs code on device)** (WWDC21; habitdoom.com). Features: Focus Sessions, Deep Focus, recurring calendar, **Focus Score®** (live focus metric from phone activity), rewards/community. $19.99/mo, $99.99/yr, $399 lifetime; free plan 1 rule (focusme.com comparison, Oct 2026 — volatile). Common complaint: Screen Time API shields flake/drop; price.
- **ScreenZen:** free (donations); app-open delay that **escalates with repeated opens** (10 s → 30 s → 60 s) (unhookd.app) — a smart friction-schedule idea; "more you open, longer the wait."
- **Focus (heyfocus.com):** macOS menu-bar blocker; one-time purchase, 3 tiers ($19 Productivity shown; other tiers unverified — page 404s now).
- **Roots:** iOS; "balance score", app limits, downtime, "digital dopamine" tracking narrative (TechCrunch). $59/yr (per jomo.so comparison).
- **Jomo** ($29/yr): mindful breaks + rules; **Refocus** ($59/yr): simple iOS app limits; **BePresent** $69/yr (all per jomo.so comparison — vendor-hosted, treat cautiously).
- **Forest (forestapp.cc):** gamified focus — tree grows during 10–120 min sessions, dies if you leave; iOS $3.99 one-time, Android free w/ads ($1.99 unlock), free browser extensions. Proof that **visible accumulated record** (your forest) is a retention engine.

## TIER 2 — One-liners
- **StayFocusd:** free Chrome original; "nuclear option" tab-closing + max daily minutes; unmaintained feel; keyword blocking only via paid BlockSite-style rivals.
- **BlockSite:** freemium Chrome/Edge/mobile; keyword blocking, schedules, "focus mode"; complaints about paywalling basics and data collection perception.
- **AppBlock (MobileSoft):** freemium Android/iOS; schedules, usage limits, "Strict Mode" (prevents uninstall/settings changes); free tier very limited.
- **Digital Wellbeing (Android) / iOS Screen Time:** dashboards + timers with one-tap "ignore"; trivially bypassed (PiP trick, known passcode, dismiss limit) — fine as telemetry, useless as commitment.
- **NetNanny etc.:** parental-control lineage — category databases + real-time page analysis (e.g., **Deledao** for K-12 does rendered-page AI filtering: deledao.com) — proof content classification exists commercially, but paternalistic, cloud, school-focused.
- **RescueTime:** *measure-don't-block* counterpoint; local tracker → **server-side categorization of apps/sites into productivity scores** ("Very Productive…Very Distracting"), user overrides; weekly email reports + goals = retention loop. Premium ≈$6–9/user/mo teams (individual price unverified). Lesson: **classification-as-analytics** is validated; SmartBlocker does it on-device instead of cloud.

## State-of-the-art anti-tamper techniques (consolidated, every distinct one found)
1. Privileged **daemon/service holding block state** (SelfControl `selfcontrold`, FocusMe Extra Protection Service) — survives app deletion/reboot.
2. **Kernel-level network enforcement**: `pf` firewall rules (SelfControl); local proxy (Freedom); iOS local-VPN profile (Freedom, ad-blockers).
3. **Companion-process watchdogs** that relaunch the enforcer if killed (FocusMe service; SmartBlocker's paired watchdog matches this).
4. **Uninstall protection** (FocusMe: protect uninstall + block 3rd-party uninstallers; Freedom iOS: Screen Time-based; AppBlock Strict Mode).
5. **Safe-Mode autostart** (FocusMe).
6. **Block Task Managers / process-killing tools** while plans active (FocusMe).
7. **Commitment delays**: config changes that loosen control take effect after T; delay-reduction and uninstall gated behind delay=0 (Plucky); stop-waits before/after challenges (FocusMe).
8. **Random-character challenges** 1–2000 chars, optional "perfect typing" (FocusMe, Cold Turkey); LeechBlock options password/random code.
9. **Typed-surrender / semantic friction**: typing "I am choosing to give up" (Focus AI Quit Wall) — novelty but aligned with delay evidence.
10. **Friend-held passwords / accountability partners** with approval flows, delayed activation of new partners (24 h), email/stop-codes (FocusMe; Plucky expedite).
11. **Monetary commitment fee** to stop a plan (FocusMe assisted stop fee).
12. **Ratchet-only editing**: running plans can only get stricter (FocusMe).
13. **Absolute enforcement mode** with explicit "no exit until end" semantics (FocusMe Enforced; Cold Turkey Frozen Turkey — see separate CT analysis).
14. **OS-native parental-control scaffolding** as enforcement substrate (iOS Screen Time API: ManagedSettings shields — Opal, Freedom uninstall protection; Android Device Admin/Accessibility).
15. **Privileged-file guards** (install dir protection, downgrade prevention — FocusMe).
16. **Anti-history/forensics niceties** (PowerShell history protection — FocusMe) — niche.

## Intervention UX evidence (delay/friction vs hard blocks)
- **Peer-reviewed: Grüning, Riedel & Lorenz-Spreen (2023), PNAS 120(8) e2213114120** ("Directing smartphone use through the self-nudge app one sec"): field experiment N=280, 6 wk — **36% of target-app opens dismissed** at the interstitial; **37% fewer open attempts** by wk 6; **57% total reduction** in target-app opens; users reported higher satisfaction. Preregistered follow-up (N=500): **the dismiss/close option was the strongest component; the time-delay friction also worked; the deliberation message did nothing**. → Design implication: SmartBlocker's block page should lead with an easy "close tab" action + delay, not moralizing text.
- Plucky's model is built on the same "impulsive vs intentional self" delay literature (pluckyfilter.com); ScreenZen's escalating delay is an untested-but-plausible twist.
- Hard-block evidence is mostly commercial/anecdotal (vendor blogs, Trustpilot, r/nosurf) — no comparable RCT found. Community consensus (r/nosurf, r/productivity): hard blocks with real anti-tamper (Cold Turkey/FocusMe/Plucky) are "the only thing that works" for heavy users, while friction apps suit moderate users. (*unsourced beyond community sentiment*)

## Who does usage statistics well (retention loop)
- **Opal**: Focus Score® (single live metric) + streaks/rewards; **RescueTime**: productivity score + weekly email reports (the canonical loop); **Forest**: persistent visual forest = accumulated identity; **FocusMe**: Activity tab + weekly recaps of blocked-distraction attempts; **Roots**: balance score; **Freedom**: session history/annotations (weaker). Pattern: **a number that moves + a weekly digest + a visible record/streak** drives retention better than blocking alone. SmartBlocker has natural stats gold: "pages auto-blocked, false-positive overrides, topics visited" — a dashboard differentiator.

## Smart/AI classification landscape (who else classifies content?)
- **Focus AI (getfocusai.com)** — closest analog: Chrome extension, states your task, **AI judges every page against the task ("calculus lecture: in; Shorts: out")**, quit requires typed surrender; $9.99/mo. Commercial, cloud-LLM presumably (not local), extension-only anti-tamper.
- **focus-shield (github.com/moritzWa/focus-shield)** — open-source "AI bouncer": asks *why* you're visiting, LLM grants a timed pass instead of a binary block; client+server, active in 2026.
- **brom.ai** — 2020 ML Chrome extension experiment classifying visited pages (individual project, appear shelved).
- **LessWrong GPT-4 distraction blocker** (2023) — hobbyist LLM-per-page checking; latency/cost noted as problems.
- **Deledao** — commercial K-12 real-time AI page analysis (rendered-DOM), cloud.
- **LockIn MCP, "Distraction Killer AI" (Devpost 2025)** — new entrants w/ LLM classification. 
- **Gap confirming SmartBlocker's thesis:** nobody ships a **local, embedding-based, per-page classifier with OS-level lock enforcement**. Existing AI entrants are cloud-LLM (cost/latency/privacy) and extension-only (weak tamper-proofing).

## Complaints / unmet needs (r/nosurf, r/productivity, HN, Trustpilot, review blogs)
- **Freedom:** still bypassable (quit process, revoke iOS perms, unmanaged browser); proxy breaks desktop apps; $ subscription resented; cross-device sync occasionally flaky. 
- **FocusMe:** expensive subscription (multiple Reddit threads balk at $17.95/mo); configuration complexity overwhelming; UI dated.
- **Plucky:** CLI-ish learning curve; rough UX; delay-on-*everything* frustrates non-addict use-cases.
- **SelfControl:** over-blocks (CDN/shared IPs), no scheduling/limits, 24 h cap, rare "blocked everything" pf bugs.
- **LeechBlock NG:** trivially removable as any extension; keyword matching too literal; no stats; no sync.
- **Cold Turkey (brief; see separate analysis):** Mac unreliability complaints, browser-integration fragility (Trustpilot snippets via tryhugo.app).
- **Opal/mobile cluster:** Screen Time API flakiness (shields drop), expensive subs, one sec's per-app Shortcuts setup; Apple Screen Time itself useless as self-commitment.
- **Category-wide unmet needs:** (1) **In-feed distractions on allowed sites** (Shorts/Reels on permitted YouTube) — explicitly called out as a gap even by competitor comparison blogs; (2) per-page/per-content granularity instead of per-domain; (3) subscription fatigue → one-time-purchase demand (Cold Turkey/Forest pricing consistently praised); (4) selective blocking that understands *why* you're on a site (Focus AI's task framing resonates); (5) honest stats + weekly reports to make the blocker feel like a coach, not a jailer; (6) local privacy (no browsing data in someone else's cloud — Freedom privacy questions recur on StackExchange).

## Pricing table (checked 2026-11-07; volatile, verify before quoting)
| Product | Model | Price | Notes |
|---|---|---|---|
| Freedom | Sub + lifetime | $8.99/mo · $39.99/yr · $159.99 once | tryhugo.app 2026 |
| FocusMe | Sub + lifetime | $17.95/mo · $119.40/yr · $449 once (5+2 devices) | focusme.com; older sources cite ~$6.99/$29.99 (price rose) |
| Cold Turkey | Freemium + one-time | Free · Pro ~$39 once | (see separate CT analysis) |
| LeechBlock NG | Free OSS | $0 | — |
| SelfControl | Free OSS (GPL) | $0 | macOS only |
| Plucky | Free OSS (donation) | $0 | — |
| Opal | Sub + lifetime | $19.99/mo · $99.99/yr · $399 once | via focusme.com comparison |
| one sec | Freemium | €3.99/mo · €14.99/yr · €99.99 once | one-sec.app |
| ScreenZen | Free (donations) | $0 | escalating delay |
| Forest | One-time | $3.99 iOS · free/$1.99 Android · ext free | forestapp.cc |
| Roots / Refocus / Jomo / BePresent | Sub | $59 / $59 / $29 / $69 per yr | via jomo.so comparison (vendor-hosted) |
| Focus (heyfocus) | One-time tiers | from $19 | partial data |
| Focus AI | Sub | $9.99/mo, 3 free sessions | getfocusai.com |
| RescueTime | Freemium sub | teams $6–9/user/mo; individual premium ~$12/mo *(unverified)* | — |
| AppBlock / BlockSite | Freemium sub | premium tier prices unverified | — |

**Category signal:** subscriptions are the dominant complaint driver; one-time licenses (Cold Turkey, Forest, Focus, Plucky/SelfControl free-OSS) earn outsized goodwill. A one-time (or free-OSS-core) SmartBlocker with local classification + daemon enforcement lands exactly on the market's open square.
