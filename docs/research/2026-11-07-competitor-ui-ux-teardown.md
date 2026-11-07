# Distraction-Blocker UI/UX Teardown Pack (raw agent report, 2026-11-07)

*Tags: **[doc]** = vendor docs/site; **[ss]** = inferred from screenshots/listings; **[rev]** = review/community sentiment.* Best screenshot URLs consolidated in the appendix.

## 1. Cold Turkey Blocker (Win/Mac)
**Structure** [doc, User Guide]: sidebar desktop app — *Overview* (active + scheduled blocks, breaks, Pomodoro status), *Blocks* (lists: sites, apps, device), weekly drag-on-*Schedule*, Statistics, Settings. **Onboarding** [doc]: install app + mandatory per-browser extension; default distraction list makes the first block immediate. **Block screen** [doc]: plain browser page with a motivational message + remaining time; "Pause for a Cause" donates to WWF for a 10-min break (disableable). Escapes are the 7 lock types (Timer, Time-range, Random text up to 5000 chars, Delay up to 40 days, Schedule, Restart, Password); "Frozen Turkey" = full-device lockout. **Model**: block lists × one-time/scheduled/locked blocks. **Verdict** [ss]+[rev]: utilitarian grey native-WPF look, no dark mode; praised for effectiveness (FT/Wired/Time features), UI respected as "spartan," not pretty.

## 2. Freedom (freedom.to)
**Structure** [doc]: cloud dashboard + thin menu-bar/mobile apps — *Sessions* (now/later/recurring), *Blocklists*, *Schedules*, Locked Mode, device list. **Onboarding**: account + subscription up front → desktop app → browser extension per browser → iOS Screen Time permission. **Block screen** [doc, support]: customizable message on the shield ("Block Screen: customize the message"); mobile shows a calm green "you're free" screen [listing]; escape via Locked Mode (which itself can't be quit once started; iOS Screen-Time-permission loophole is documented by Freedom itself). **Model**: blocklists × sessions × devices — the canonical "session" model. **Verdict** [ss]+[rev]: modern, calm, minimal green aesthetic, best-in-class cross-device sync; recurring complaints about sync/session bugs and subscription-only pricing.

## 3. FocusMe (Win/Mac/Android)
**Structure** [doc, docs.focusme.com nav]: *Plans*, *Activity*, *Tasks*, *Coach*, Settings; each plan built in a 4-step wizard (What to block → When it runs → How strict → Review & Enable). **Onboarding** [doc]: first-run "Quick Setup" asks two questions and auto-builds plans; Plan Library presets (social, games, news, study, sleep). **Block screen** [doc]: branded block page in every browser naming the offending plan; blocked apps close on launch; escape scales with protection preset — one click, 5-char code, wait + limited pauses, or Enforced Mode ("can only be made stricter"). **Model**: plans = the most configurable rules engine here (time budgets, launch limits, breaks, Pomodoro, multi-day). **Verdict** [rev]: Trustpilot 4.8 for power; UI is the densest/dated-est of the set — its own community forum gripes about fiddly details (typing `00:00–24:00` for an all-day schedule).

## 4. LeechBlock NG (extension)
**Structure** [doc, proginosko.com]: one Options page, a tab per *Block Set* (6 default, up to 30), General Options, toolbar popup with Lockdown. **Onboarding**: zero account; click extension → Options → enter domains + times in Block Set 1; grant all-sites permission for timer/keyword features. **Block screen** [doc]: plain banner page ("blocked by LeechBlock") optionally showing time until unblocked; per-set escape hatches: none / countdown delay / access code / password. **Model**: sets = independent containers of {sites, time periods and/or hourly/daily limit, lockdown override}. **Verdict** [rev][ss]: the rawest UI of the cohort — spreadsheet-like HTML options; free, open-source, adored by power users ("first block in two minutes — Tooltivity"); zero polish, functional accessibility, follows no theming.

## 5. BlockSite (extension + mobile)
**Structure** [doc][ss]: quick-add popup plus full dashboard — Block List, categories/keywords, Schedules, Focus Mode, password protection, uninstall prevention. **Onboarding**: guided add-sites grid (popular distractions); heavy early freemium prompts [rev]. **Block screen** [doc]: the most customizable shield in the cohort — custom image/quote "block pages," redirect-to-safe-site option; editing/uninstalling gated by password (Premium). **Model**: one master list + schedules + Focus Mode (block everything but your list, Pomodoro-paced). **Verdict** [rev]: modern flat UI; complaints concentrate on aggressive upsell/paywalled basics and bypass-easiness vs Cold Turkey/FocusMe (password+uninstall-prevention mitigate).

## 6. one sec (iOS + macOS/Chrome)
**Structure** [doc + tutorials.one-sec.app]: per-app intervention list, stats ("opens saved"), schedules, re-interventions, intention tracking, Safari extension for websites. **Onboarding** [rev]: the famous friction — you must create an iOS Shortcuts automation per target app ("more complicated than most app blockers"); onboarding is a guided tutorial flow. **Block screen** [doc]: full-screen dark *breathing exercise* ("Take a deep breath…") with rotating interventions (mirror, rotate, blackout), then a choice to proceed or back out. **Model**: per-app *friction gateway*, not a block — pause + reflection; Pro adds schedules/harder limits. **Verdict** [doc][rev]: calm, native, modern; peer-reviewed PNAS/Max-Planck-Heidelberg study (57% fewer app opens) makes it the "science-backed" design darling; complaints: Shortcut fragility across iOS releases, no true block on the free tier.

## 7. Opal (iOS)
**Structure** [doc + App Store release notes]: Home (Opal Score, screen-time/pickup stats), *Rules* (Focus Rules incl. Sessions/Always-On), Focus Timer, Waiting Room with *Resistance* levels, milestones/gems, community. **Onboarding**: Apple Screen Time (FamilyControls) + notifications permission, system app-picker, first Rule creation; Apple calls its customizations "easy-to-set-up" [developer.apple.com]. **Block screen** [ss][doc]: minimal black-on-white shield with gem/branded moments; escape via Waiting Room whose difficulty ("Resistance") can increase per use; Hard-mode commitments remove exits. **Model**: Rules-first (recurring sessions + always-on per app group). **Verdict** [doc][rev]: the design leader — **2025 Apple Design Award finalist** (Social Impact), public Brand Kit with an explicit B/W color system; complaints: $99.99/yr pricing, free-tier limits, buggier Android port (Play reviews).

## 8. ScreenZen (Android + iOS, Mac/Win)
**Structure** [doc][ss]: per-app cards — delay, daily time limit, unlocks/day, strictness — plus streaks/stats, website blocking, passcode/strict mode. **Onboarding** [doc]: praise from listings/testimonials for being "much easier to set up" than rivals; standard usage-access/Screen-Time permissions; donation-supported. **Block screen** [rev, unhookd]: delay-before-opening screen with custom self-written message; delay escalates with use (10s → 60s by the 10th open). **Model**: per-app friction quotas (delay + daily limits/unlocks) — one sec-style, Android-first, with a real strict mode. **Verdict** [rev]: clean, minimal, modern; 4.8★/35K+ Play reviews; Trustpilot 2.9 flags passcode-screen bugs persisting after block expiry.

## 9. Forest (iOS/Android, paid)
**Structure** [doc][rev]: single Plant screen (10–120-min ring timer + stopwatch), Forest timeline (your growing/withered garden), shop/species, tags & stats, Plant Together multiplayer. **Onboarding** [rev]: account optional; plant a first tree in literally two taps. **Block screen** [rev]: no shield — leaving the app *withers your tree*, which permanently scars your forest; sad-seedling copy does the work. **Model**: session timer + app whitelist + gamified currency → real trees via Trees for the Future. **Verdict** [rev]: universally praised cute-illustration style (60M downloads, 4.8★); critics note aging screens (video teardown: overlay "looks like it was done by Google in 2013").

## 10. AppBlock (MobileSoft; iOS/Android)
**Structure** [doc, appblock.app help]: Home/Quick Block, *Schedules* (parallel, strictest-wins), conditions (time/location/Wi-Fi/usage/app-open limits), *Strict Mode* (cooldown, timer, PIN, follow-schedules, third-party/friend-email approval, uninstall prevention), stats. **Onboarding**: Android accessibility/usage admin; iOS Screen Time; template schedules. **Block screen** [ss]: dark overlay with app icon, custom message, unblock time; strict variants remove exits. **Model**: schedule profiles + conditional triggers (the rule-iest mobile model). **Verdict** [rev]: modern card-based Material-ish UI with dark theme; praised strictness; complaints: iOS version weaker (Apple API limits), settings sprawl.

## 11. Brick / Unpluq (hardware + app)
**Brick** [Wirecutter/Consumer Reports doc]: tiny NFC puck + app with a bare-minimal mode screen — choose apps, pick a mode, tap phone to puck to lock/unlock; "Brick Night" (Bluetooth bedside auto-block). Escape hatch is *physical* (tap the puck, or limited emergency un-bricks). App UI = delightful DTC minimalism; complaint: controls "far too simplistic," no timed sessions [Digital Reviews Network]. iOS system shield shown on blocked apps [ss]. **Unpluq** [doc][rev]: NFC key-tag + fuller app: select apps (free tier = 2), schedules, whitelist, and *distraction barriers* to briefly regain access (tap tag, shake, scroll a code); tag can live 200 km away or on a spouse's keyring. App UI plain-utilitarian vs Brick; ~$79 tag + sub. **Model**: both = "physical key" — the strongest escape-hatch removal in the cohort.

---

## Cross-cutting: configuration mental models
- **Lists + locks**: Cold Turkey (lists × lock types).
- **Lists × sessions**: Freedom, Forest (start/schedule a session against lists/whitelists).
- **Rules engines / plans**: FocusMe ("plans"), AppBlock ("schedules+conditions"), Opal ("Rules") — what/when/strictness as composable policy.
- **Sets with periods + quotas**: LeechBlock (30 sets; periods and/or per-hour limits).
- **Per-app friction**: one sec, ScreenZen (delay/breath/quota instead of walls).
- **Physical key**: Brick, Unpluq (override moves off-device).
- **Hybrid list site**: BlockSite (list + schedules + Focus Mode).

## Best/worst UX verdict
- **Most praised**: **Opal** — 2025 Apple Design Award finalist, "most-loved screen time app," public brand kit; honorable mentions: **one sec** (science + calm) and **ScreenZen** (Reddit-favorite free strictness).
- **Most mocked**: **FocusMe** (most powerful, most dated/fiddly UI — complaints surface in its own forum) and **LeechBlock NG** (raw HTML options page). Cold Turkey is "spartan but respected"; Forest is loved but its timer chrome is called dated.
- **Public design-system/Figma artifacts**: no official Figma files for any product. Closest: **Opal's public Brand Kit** (brandkit.opal.so) with explicit color/typography rules; LeechBlock NG is open-source (github.com/proginosko/LeechBlockNG) so its UI is auditable in code; unofficial Forest/Opal redesigns exist on Dribbble/Behance (community work, not sanctioned).

---

## Screenshot appendix (verified direct image URLs unless noted)
- **Cold Turkey** (official): `https://getcoldturkey.com/assets/img/features/block-page.webp` · `.../features/scheduler.webp` · `.../features/web-blocking.webp`
- **Freedom** (App Store): `https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/85/b0/0b/85b00b5d-67b9-e389-2852-eb90bf1000f4/EN_-_iOS_-_1.png/320x480bb.jpg` · sibling `EN_-_iOS_-_2.png`; desktop UI: support.freedom.to *(gallery, not direct CDN)*
- **FocusMe** (official wizard): `https://focusme.com/wp-content/themes/focusme/img/docs-wizard-step1-websites.webp` · `docs-wizard-step2-weekly.webp` · `docs-wizard-step3-protection.webp` · `docs-wizard-step4-review.webp`
- **LeechBlock NG**: addons.mozilla.org/en-US/firefox/addon/leechblock-ng/ *(official screenshot gallery; direct CDN URLs gated)* · tooltivity.com/reviews/leechblock-ng *(annotated gallery)*
- **BlockSite**: mzstatic `.../Blocker_screenshots_1_man__U00281_U0029.jpg/392x696bb.jpg` (iOS listing) · `.../Blocker_screenshots_65.jpg/392x696bb.jpg` · Chrome Web Store detail page
- **one sec**: mzstatic `01_01c-cut-screen-time.png/320x480bb.jpg` · `02_02c-rewire-your-brain.png/320x480bb.jpg`
- **Opal**: mzstatic `Artboard_1.jpg`, `Artboard_2.jpg` · brandkit.opal.so
- **ScreenZen**: mzstatic `iPhone-EN-01.jpg`, `iPhone-EN-02-B.jpg`
- **Forest**: mzstatic `en.jpg/392x696bb.jpg`, `en2__U00281_U0029.jpg/392x696bb.jpg`
- **AppBlock**: mzstatic `iOS_Eng_1.jpg`, `iOS_Eng_2.jpg`
- **Brick**: mzstatic `0_APP_IPHONE_69_0.png`, `1_APP_IPHONE_69_1.png` · getbrick.com CDN thumbnails
- **Unpluq**: mzstatic `App_store_image_22.png`, `App_store_image_32.png`

**Key sources cited inline above**: getcoldturkey.com/features + user guide; freedom.to + support.freedom.to; docs.focusme.com + focusme.com/how-it-works; proginosko.com/leechblock/documentation; blocksite.co + cisdem review; one-sec.app + tutorials.one-sec.app + PNAS study; opal.so + developer.apple.com/2025 ADA + brandkit.opal.so; screenzen.co + unhookd.app review + Play/Trustpilot; forestapp.cc + YouTube "App Breakdown #65"; appblock.app help center; getbrick.com + Wirecutter + Consumer Reports; unpluq.com + unhookd.comparison; tooltivity, blok.so, lifestack reviews; reddit/Trustpilot/Play sentiment as flagged.
