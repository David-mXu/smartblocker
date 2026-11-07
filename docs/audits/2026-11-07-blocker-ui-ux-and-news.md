# Audit addendum: Blocker UI/UX teardowns + category news (as of 2026-11-07)

**Scope:** how the actual desktop apps look and feel (dissected locally from shipped artifacts), the category's news timeline, and where everyone else is going. Companion to `2026-11-07-cold-turkey-blocker-landscape-audit.md`. Zero private data: the CT app shell was studied from its shipped static bundle (`C:\Program Files\Cold Turkey\web\` = program files, not user data); the running app itself was never opened.

---

## 1. Cold Turkey's desktop UI — dissected from the shipped shell

### 1.1 Stack
Single 227 KB `index.html` + ~60 jQuery-era assets (Bootstrap, jquery-weekcalendar, Flot charts, moment, bootstrap-datetimepicker, Font Awesome, Antonio + Open Sans fonts). Both `themes/dark.css` and `themes/light.css` ship. Embedded in the .NET WinForms shell through the legacy IE-derived WebBrowser control (`Interop.SHDocVw`), bridged via `window.external.*` (≈10 entry points: `InstallBrowserExt`, `InstallEdge`, `InstallFirefox`, `RefreshBrowser`, `AddApplication`, `ImportUrlsFromFile`, `CheckProductKey`, `UpdateButton`, `UpgradeButton`, `StoryButton`).

**Takeaway:** the UI is a document-style page with 1990s/2000s-era web components, held together by careful information architecture — not by visual polish. SmartBlocker's Lamplight system (React 19 + Tailwind v4 + shadcn/ui) wins on craft by a decade; CT wins on *surface coverage*.

**Build metadata (strings pass over the shipped binaries, read-only):** the main exe is **Visual Basic .NET** (tell-tale `VB$StateMachine_109_ShowStatusAfterDelay`, `VB$StateMachine_157_ResetAppOpening`; assembly identity `MyApplication.app` — never renamed from the VB default!) and **not obfuscated** — settings getters (`get_BlockInstaller`, `get_BlockTimeChange`, `get_BlockUserChange`, `get_BlockTaskManager`, `get_BlockTaskManagerChrome`, `get_LockUnblock`, `get_BlocksOrder`) are directly readable. `ServiceHub.Power.exe` similarly exposes plain .NET process/service plumbing (`GetProcessesByName`, `ProcessImageFileName`, `TaskService`). Practical meaning: anyone with a free decompiler (ILSpy/dnSpy) can read CT's full logic, so **its toughness is operational (service privileges, NM coupling, self-restart), not code secrecy** — which also means SmartBlocker's open-source stance concedes almost nothing CT-style defenders were ever gaining from closed binaries.

### 1.2 Information architecture (from live DOM extraction)

**4 top-level pages + left sidebar:**
- **Dashboard** — `var-active-blocks`, `var-upcoming-blocks` ("Calculating…" states), `timeline`, and an `overview-pause` widget. Answers "what's active right now / what's next today".
- **Blocks** — `blocks-blocks` → `blocks-list` ("Website & App Blocks") **and** `blocks-device` ("Device Blocks", incl. `frozen-block` with **Sign Out / Shut Down** actions). One list, two kinds.
- **Statistics** — THREE sub-tabs: `stats-tab-blocked` (what got blocked: count + time charts), `stats-tab-websites` (usage per site), `stats-tab-apps` (usage per app) — each with **timeframe pickers, per-user filter** (`stats-web-users`), per-block filter, full-text search, and "show/hide all other websites|apps" toggles.
- **Settings** — five sub-tabs: Preferences, **Block Strictness**, Notifications, Statistics, Password.

**Sidebar actions:** Activate pro, Update app, lock-state badge ("No lock set" / "Lock"), schedule-state badge ("No schedule set"), and **"Fix extensions" / "Checking extensions…"** — a first-class extension-health entry point.

### 1.3 The settings schema (verbatim IDs — this *is* the feature checklist)

- **Preferences:** `theme_dark/light`, `firstDayOfWeek`, `show24hour`, `closeToTray`, **`frozenTurkeyMode`**, `showAutostart`, `showExtensionWarning`, `showEditBreakSchedule`, `showNoLockSet`, `showNoSchedule`, `openStartup`, `openStartupTray`.
- **Block Strictness:** `blockMode`, `blockInactive` (background tabs), `blockEmbedded`, `blockCharity` (Pause for a Cause), `statsStrict`, `blockAllowance`, **`blockUnsupported`** (unknown browsers), **`blockTaskManager`**, **`blockTimeChange`**, **`blockUserChange`** (Windows user-account switching!), **`blockInstaller`** (rerun-installer bypass), **`forceAllowFile`** (file:// pages), **`extensionGracePeriod`** (the browser-close countdown is user-tunable).
- **Notifications (a mini product by itself):** block started/done (`notifyBlock/Done`+Range+Delay), schedule start/end (`notifyStart/End`), **pre-block warnings** (`notifyWarning` + configurable `WarningPeriod`), break start/end (`notifyBreak/DelayStart/BreakEnd`), **allowance low warning** (`notifyAllowance/WarningAllowance/Period`), **autostart warnings** (`notifyAutostart/WarningAutostart/Period`), `notifyIntense`.
- **Verbs (buttons):** `New block…`, `New device block…`, per-editor `Add / Select / Import / Export…`, `Add exe file… / Add folder… / Add Microsoft Store app… / Add window title…`, `Add users…`, **`Start unlocking` / `Cancel unlock`** (two-phase unlock UX), per-browser rows `Install / Fix error / Installed` **×13 browsers** (arc, brave, chrome, edge, firefox, opera, vivaldi, zen, mullvad, floorp, …), `Start trial / Buy / Activate`.
- **Break editor tabs:** None / **Pomodoro / Allowance** (+reward/sessions/delay/random-text in Pro flows).
- **Time-granularity vocabulary:** 50+ `<option>` presets spanning "10 minutes" → "2 weeks from now" and "X minutes/hours after starting" — used by timer locks, warning periods, allowance windows, and break durations.

### 1.4 What SmartBlocker should absorb (UI-specific)

1. **The Dashboard tab = "nervous system for right now".** Active blocks + upcoming-for-today + visible lock/schedule badges + one-click "Fix extensions". SB's popup covers some of this but nothing answers "what fires next" across schedules at a glance.
2. **Warnings are features, not noise.** Notify-before-block, allowance-low warnings, autostart warnings — each with its own period knob. SB fires everything silently today (`lock-boundary` alarm).
3. **"Fix extensions" as a surface.** CT put extension health in the main window's sidebar and devotes a whole screen to per-browser Install/Fix/Installed rows. SB's companion status is a quiet options section. Promote it.
4. **Statistics as a tab triad** (blocked/websites/apps) with timeframe + user + search filters — the direct template for SB's stats dashboard (§4-P1.9 of the main audit), minus the per-user angle until Windows.
5. **Two-phase unlock ("Start unlocking/Cancel unlock")** — cheap, high-friction UX for delay/random-text unlock flows (works with the P0.3/P0.4 recommendations).
6. **Grace period as a user-visible tunable** instead of a hardcoded 60 s.
7. Keep SB's design language; don't import the visual style — import the *coverage*.

---

**Product-family template (verified on this machine):** Cold Turkey Micromanager (`C:\Program Files\Cold Turkey Micromanager`) repeats the exact template — small .NET exe + `MMService.exe` background service + embedded `web/` bundle + Inno uninstaller. One architectural recipe across Blocker / Writer / Micromanager: a solo-dev factory for commitment apps. SmartBlocker's equivalent (Rust core + headless daemon + optional Tauri face) is the same pattern, better factored.

## 2. Cold Turkey release-notes timeline (primary source: getcoldturkey.com/news)

What the changelog says about where the pressure is:

| Version | Date | Signal |
|---|---|---|
| 4.6 | 2025-04 | Break types explode (rewards/random-text/delay/sessions), autostart suite added, `*.xxx` adult blocking, **"did you mean?" Google closure**, blocked-folder browsing banned, tray status window, **"fixed high CPU issues (finally)"**, extension↔app reliability fixes |
| 4.7 | 2025-05 | "More anti-tampering mechanisms"; time-settings block hardening (Win10) |
| 4.8 | 2025-09 | macOS-only polish |
| 4.9 | 2025-12 | Browser zoo: Atlas/Dia/Orion/Comet/Floorp/Mullvad/Brave Nightly; CLI `-list-blocks/-add-block/-status`; **autostarts work even if device is off** |
| 4.9(1) | 2026-02 | Managed-profile compat, **Google Family Link + Microsoft Family Safety compat** (parental-control coexistence!), guest-browsing detection, wake-from-sleep = sign-in, arm64 |
| 4.9(2) | 2026-03 | **Block Split View option** (matches the shipped extension's eviction code), folder picker, extend-able locked schedules, collaborator videos in YT channel blocking |

**Reading the timeline:** CT's engineering budget goes (1) tamper-chasing, (2) browser-zoo coverage, (3) break-type depth — and in 2026 a lot of **family-control compatibility** (Family Link, Family Safety, multi-user). Under the hood it battles the same nemeses SB does: NM flakiness, sleep/wake, user switching, high CPU. Nothing in two years of releases touches classification/semantic blocking — the door SmartBlocker is walking through remains wide open.

---

## 3. The rest of the category — news + UI/UX verdicts

### 3.1 Market news, 2025 → Nov 2026 (agent research, full citations in `docs/research/…`)

**Science tailwind.** Feb 2025 PNAS Nexus RCT (Castelo et al.): **blocking mobile internet for 2 weeks improved sustained attention (≈"10 years younger"), mood, and well-being** — NPR-amplified; the category's strongest scientific advertisement. It complements the one-sec PNAS study (interstitial friction → 57% total reduction; see main audit §2.3).

**New-entrant cohort 2025–26** — the "earn your screen time" wave:
| Entrant | Mechanism | Notes |
|---|---|---|
| **Clearspace** (YC) | Pushups/exercise → earn app time | "Hundreds of thousands of users" claim; YC-backed |
| **Habit Doom** | Apps unlock only after habit check-in; **AI photo "anti-cheat"** | $4.99/mo; 4.8★; weekly "Doom Summary" |
| **ScreenBreak** (PH Dec 2025) | Effort challenges (tap-fast/shake/draw) to unlock | Gamified friction |
| **SpeedBump** (PH Mar 2025) | Deliberately *annoying* overlays; forced 15-min breaks | Humor-as-friction |
| **LockIn MCP** | **MCP server wiring ChatGPT/Claude/Cursor to system-level task-keyed blocking** | The AI-agent-native analog — closest to SmartBlocker's audience; validates the channel |
| **Superhappy / Zario** | AI focus coaches (chat/coach personas) | Repositioned incumbents |
| **Dumbify / Blank Spaces** | Dumb-phone minimalist launchers | Hardware-free detox |
| **Brick** ($59 NFC puck) | Physical tap-to-lock puck; "Brick Night" Bluetooth | Full press gauntlet (WSJ/TechCrunch/Wirecutter), bootstrapped; **Unpluq** raised $220K |

**Incumbent pulse.** CT steady cadence, solo dev, **Pro ≈ $39–49 lifetime** (sources drift; the site's own pricing page says CA$49). **Freedom**: $8.99/mo, lifetime **cut to ~$99.50 from $199** — subscription pressure showing. **FocusMe: hiked to $17.95/mo / $449 lifetime** — the most-respected protection ladder now carries the most-resented price. **Forest: paid → free + subscription** (Dec 2025, Seekrtech folding to the sub model). **LeechBlock NG**: still shipping (1.7.2 Jan 2026: min block time, first-page-only blocking; 1.7.3 Aug 2026: **managed storage** = enterprise-policy locking of settings — note this; 1.8 Oct 2026). **Opal**: "500M hours saved" claim; **Android shipped ~Sep 2026 (reviewed as buggy)**. **RescueTime** $84/yr, widely seen as maintenance-mode. No notable shutdown in 2025–26 (Moment's 2021 death remains the cautionary tale).

**Platform shifts.**
- **iOS 27** (WWDC Jun 2026): biggest Screen Time rebuild in 8 years — but almost entirely *parental* (category time allowances, Ask-to-Browse, Declared Age Range). **The adult "Ignore Limit" escape hatch remains.** Developer asks (reliable monitoring, shield-state reads, event unlocks) ignored → the third-party adult self-control market is permanent.
- **Android 17 / Advanced Protection restricts the Accessibility API** to declared accessibility tools — AppBlock publicly acknowledges impact. **Accessibility-hack blockers will bleed out on Android**; VPN-profile/DNS-filtering or device-owner modes become the paths.
- **Regulatory wave:** Mar 2026 LA jury — **Meta & YouTube liable for addictive design** ($3M+ compensatory, non-unanimous); Australia under-16 ban live Dec 10, 2025 (~5M accounts wiped week one); **KIDS Act passed the House 267–117 (Jun 29, 2026)**, Senate in play; phone-free-school laws across US states through 2025; EU DSA minor-protection guidelines enforcing against infinite scroll/autoplay.

**Five actionable from-the-news insights for SmartBlocker** (agent-derived, endorsed):
1. Sell the **adult hard-enforcement gap** Apple refuses to close: "no Ignore button" — same moat CT's release notes defend every cycle.
2. Android Accessibility clampdown = desktop-first + compliance-story positioning is *de-risked*, not limiting.
3. The breakout mechanic is **earn-to-unlock** — and SmartBlocker's classifier enables the strongest possible version nobody else can build: **productive browsing automatically earns distracting-browsing budget** (Clearspace does pushups; SB can do *content*).
4. Physical friction went mainstream (Brick) — validate the **$0-hardware equivalent**: NFC-tag tap-to-unlock, scheduled lockouts with bounded emergency-unlock budgets.
5. Pricing wedge: FocusMe $17.95/mo and weekly-sub dominance (56% of 2025 subscription revenue per Adapty) vs CT ~$39 lifetime vs **free-OSS core + optional Pro**. Stay one-time/open; it's the revealed preference.

### 3.2 UI/UX teardowns — how the other blockers actually look and feel

Full per-product detail + screenshot URLs in `docs/research/2026-11-07-competitor-ui-ux-teardown.md`. The compressed field guide:

**The seven configuration mental models in the wild:**
| Model | Products | One-line UX signature |
|---|---|---|
| Lists + locks | **Cold Turkey** | Spartan 4-tab app; lock = the feature; respected, not pretty |
| Lists × sessions | **Freedom, Forest** | Calm minimal sessions dashboard / one giant "plant a tree" button |
| Rules engines ("plans") | **FocusMe, AppBlock, Opal** | 4-step wizard (what→when→strictness→review); most powerful, densest UI |
| Sets + quotas | **LeechBlock NG** | Raw HTML options tabs per set; adored, never polished |
| Per-app friction | **one sec, ScreenZen** | Breathing/delay screens instead of walls; calm, science-flavored |
| Physical key | **Brick, Unpluq** | Escape hatch literally leaves the building (NFC tap) |
| Hybrid list hub | **BlockSite** | Most customizable shield (custom image/quote, safe-site redirect) |

**Best/worst verdicts (community + awards):**
- **Design leader: Opal** — 2025 Apple Design Award finalist, public Brand Kit (brandkit.opal.so), Waiting Room with **escalating Resistance levels** per unblock attempt, milestones/gems, "Opal Score".
- **Science darling: one sec** — dark breathing interstitial, rotating interventions, "opens saved" counter; its price is the worst onboarding in the cohort (per-app iOS Shortcuts automation — the anti-pattern to avoid).
- **Reddit favorite free option: ScreenZen** — delay that **escalates with repeated opens (10s→60s)** with a *self-written* delay-screen message.
- **Most mocked UI: FocusMe** (forum users gripe about typing `00:00–24:00` by hand) and **LeechBlock NG** (spreadsheet aesthetics — and yet power users adore both; function beats form for this audience).
- **Forest** proves the "visible accumulated record" pattern: no shield at all — a withering tree *is* the consequence.

**What SmartBlocker's UI should steal (mapped to roadmap):**
1. **Escalating-resistance breaks** (Opal Waiting Room)/escalating delays (ScreenZen): SB's future break affordances get *more expensive* per use within a window — trivially implementable in `lock.ts` (a counter per break type, persisted, merge-safe).
2. **Self-written block-screen message** (ScreenZen/Fragment of BlockSite's customization, not its freemium jail): SB block screens currently ship fixed copy — let users set their own reason-of-record, shown at block time. Zero-network, zero-risk.
3. **"Clicks saved"-style stat** (one sec's "opens saved"): SB's version — "pages silenced this week" + "override rate", surfaced in the popup; feeds the P1.9 stats dashboard.
4. **Plan wizard** (FocusMe's 4-stepper) for SB's eventual per-category schedules/P2 lists: What (categories/sites) → When (schedule) → How strict (lock/break config) → Review. SB already has the settings surface to back it.
5. **Forest's accumulated record** over badges: SB's centroid-learning means the record can be *semantic* ("you escaped 14 rabbit holes about PC building this month").
6. Avoid: Freedom's cloud-first account wall, BlockSite's early-aggressive upsell, one sec's per-app manual wiring, FocusMe's hand-typed time strings (voice: SB should ship sane presets).

**Positioning sentence that now writes itself:** "Opal's design sense and one sec's science, Cold Turkey's toughness, LeechBlock's price — with a brain."

---

## 4. Sources

- CT shell DOM extraction from `ct-web-audit\index.html` (shipped artifact copy) — settings IDs, nav, buttons reproduced verbatim in §1.
- CT release notes via getcoldturkey.com/news (fetched 2026-11-07).
- Landscape + research reports in `docs/research/`.
