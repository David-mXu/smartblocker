# SmartBlocker UX overhaul: Lazyweb references

Researched 2026-11-07 via the Lazyweb MCP (`lazyweb_search_screens`, `lazyweb_search_flows`, skill pack v0.15.14).

**Agentic Search (private, stable):** https://www.lazyweb.com/agentic-search/9ec1ed31-bb59-477b-bb92-95bce0261180 (22 selected references with notes. Only the signed-in owner can share it, using the Share button on that page.)

Local images (viewable): `research/img/01..15-*.png`. Signed image URLs are in the appendix at the bottom.

## Coverage notes (please read first)

- **Lazyweb has no screens of browser-extension popups.** I searched for "browser extension toolbar popup …" and "compact dropdown panel …" and got only marketing pages (DuckDuckGo, Brave, Vivaldi, BlockerX) and unrelated dashboards. For the popup, the closest proxies are compact mobile surfaces: Opal timer and session setup, the Spherios blocker status dashboard, Bing's master toggle, and Slack's status duration picker.
- **Company coverage:** Opal is well covered, with about 15 mobile screens and a 21-step onboarding flow. Forest resolved as a company but returned 0 screens. one sec, Freedom, ScreenZen, BlockSite and Cold Turkey are not in the library; searches for them fell back to generic results. StayFocusd has only a 404 page. Raycast has only an AI chat screen. Arc has no settings screens, only an Arc Search extension-settings screen (`screens:ba2541d97eda4b1889706c41`). I found no screens for 1Password, Bitwarden, uBlock, Dark Reader, Grammarly or Honey.
- Linear and Notion settings are present at low resolution (768x480 desktop captures).

---

## 1. Toolbar popup: "this page" status, quick actions, focus session

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Opal (mobile) | `screens:ff76db1b48890d32afc706db` | img/06-opal-focus-timer.png | A large duration readout, −/+ stepper around "30m", one wide Start button, and a "Blocked Apps >" chip below it that links to what is blocked |
| Opal (mobile) | `screens:c1adb689a999b7e2ae70d2a2` | img/01-opal-session-setup.png | Session sheet rows: Duration 20m >, Apps Blocked "Block List" >. Under "Advanced": Difficulty Normal >, with a blue info line under it ("You can take breaks and cancel this session"), then an Always-on toggle, Schedule for later, and one Start Session CTA |
| Spherios (mobile) | `screens:30beddaecf4445cf2e211401` | (not downloaded) | Blocker dashboard: a "protection disabled" status plus an enable CTA, with counts of active filters and blocked sites |
| Bing (mobile) | `screens:3b56b98f9ec4bf85d8704312` | img/14-bing-tracking-prevention.png | Master toggle in a header band, one paragraph explaining it, Basic / Balanced (Recommended) / Strict cards, and an "Exceptions" row |
| Slack (desktop) | `screens:c1fb34afff45a9dad9be2668` | (not downloaded) | Status modal with a duration dropdown and a pause-notifications checkbox |

### Takeaways
1. **One status card at the top, stated as a sentence.** Spherios leads with its state ("protection disabled") and puts the single action that changes it next to it. For SmartBlocker's popup, open with a card like `youtube.com · Allowed — on your allow list` or `Blocked — looks like Video games (82%)`, with one contextual action beside it ("Should've been blocked" when allowed, "Always allow this site" when blocked). Avoid showing both actions at once.
2. **Focus session as a stepper, not a form.** Opal's timer uses one large value, a −/+ control, and one Start button, then a "Blocked Apps >" chip that shows what will be enforced. In the popup, use a segmented 1h / 4h / 8h control (the user's choice) plus a full-width "Start focus session" button. Add a small chip under it, such as "Blocks 6 categories >", that deep-links to options › Blocking.
3. **Put the consequence directly under the setting.** Under Difficulty, Opal shows one blue info line: "You can take breaks and cancel this session." SmartBlocker should do the same under the duration control: "Can't be cancelled or shortened until 3:40 PM". The user then sees the cost before the confirm step.
4. **Master on/off as a header-band toggle with one line of explanation** (Bing). The popup header should hold the logo, the master switch, and a gear icon. When the switch is off, the whole status card should become a muted "SmartBlocker is paused" state with "Turn on" as the CTA, following Spherios's disabled state.
5. **Durations as quick presets, not free entry** (Slack's status duration and Asana's DND "30 min to 8 h" options, `screens:8f4fe03e7f06a38d08e8533f`). This confirms the 1h/4h/8h preset approach.

---

## 2. Options page with a sidebar: density, grouping, toggle rows, danger zone

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Linear | `screens:7463e0a2461687b16b38174a` | img/07-linear-settings-sidebar.png | Left sidebar with small group headings (Issues, Projects, Features, Administration), each item an icon plus label. The main column has section headings ("Interface and theme", "Desktop application", …), each followed by one bordered card of rows. Each row has a title, a one-line muted description, and a right-aligned control (toggle, select, "Customize" button, or chevron) |
| Notion | `screens:8401db8a7bb5bec8c8e6a39b` | (not downloaded) | Sidebar sections for account, notifications and privacy, with toggle rows |
| Slack prefs | `screens:13220b875506e18f699505d8` | (not downloaded) | Modal preferences with a sidebar and a "sync with OS" toggle above the theme choices |
| Bing tracking prevention | `screens:3b56b98f9ec4bf85d8704312` | img/14 | One master toggle, then a radio-card group of presets with "(Recommended)", then a separate Exceptions row |
| Peerlist / Cloaked / Coda | `screens:8362a91b24ca44767df6db9c`, `screens:dd74837a78e8eef63c518608`, `screens:7f6fbc042a7e6772c53648e1` | (not downloaded) | Account deletion kept in its own section at the bottom of settings, opening a confirmation modal |

### Takeaways
1. **Use Linear's row anatomy as the base component.** Each row is title + one-line muted description on the left and the control on the right. Rows are grouped into one rounded card per section, and each card has a plain heading above it. Keep descriptions to one line, and move longer help into a "Learn more" link or popover. This fits SmartBlocker's Blocking / Sites / Locks / Schedule / Privacy / Advanced split: one page per sidebar item and 2 to 4 section cards per page.
2. **Sidebar group headings plus icon items.** Linear separates tiers with tiny uppercase group headings. SmartBlocker could use "Protection" (Blocking, Sites, Schedule, Locks) and "System" (Privacy, Advanced). Put the Pro companion entry under System with a small "Pro" badge.
3. **Use presets before raw controls.** Bing shows Basic / Balanced (Recommended) / Strict as cards, each with 3 or 4 bullet consequences, rather than exposing a slider. SmartBlocker can offer "Relaxed / Balanced (Recommended) / Strict" sensitivity presets mapped to threshold values. The raw threshold meter then moves into Advanced.
4. **Keep exceptions as their own row.** Bing's "Exceptions: Allow all trackers on sites you choose >" is separate from the master setting. This matches putting the allow list on a separate Sites page and linking to it from Blocking ("Allowed sites: 14 >").
5. **Danger zone last, isolated, with modal confirmation.** Following Peerlist and Cloaked, "Erase shared data", "Reset learning" and "Reset all settings" belong in a red-outlined final card on Privacy or Advanced. Each one should open a confirmation modal rather than act inline.
6. **Grey out locked settings and explain why.** Lazyweb had no direct reference for this, but Linear's per-row control slot is the natural place for a lock glyph plus "Locked until 5:00 PM" while `settingsLocked` is true. That is better than disabling controls with no explanation.

---

## 3. First-run onboarding (3-step wizard)

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Opal onboarding flow (21 steps) | `flows:412d50a4eb8722b66798f2e5` | steps 17–19 | Step 17 "Choose your biggest distractions", step 18 category picker with search, step 19 allowed-apps picker, step 21 lands on the home dashboard |
| Opal | `screens:b89b0063208d2dcd6d24dc1e` | img/03-opal-onboarding-distractions.png | Headline "Choose your biggest distractions", subtitle "Opal keeps your app or website selection private". The list has an "All Apps and Categories" row and expandable category rows (Social Media ▾ → X, Instagram, TikTok, YouTube), with icons and radio circles. One "Continue" CTA is pinned at the bottom |
| Opal | `screens:d24521256122713d811568e5` | img/04-opal-category-checklist.png | "Choose Activities" with search at the top, "All Apps & Categories" master check, each category row with icon, check, "All >" expander, a sticky "13 CATEGORIES SELECTED" counter, and Save / Cancel |
| Opal | `screens:476b38fd7bc91484035fa4d1` | (not downloaded) | Education screen explaining why distracting apps hurt focus |
| Tiimo / Structured / Gola onboarding flows | `flows:dcc6b787a4b3ee433703d48f`, `flows:5fef2cad4266527acb6618a4`, `flows:76c77ba51bfae13d88161696` | (step URLs in f1.txt.json) | Progress indicator, Skip, chip-based multi-select, and a final "your plan is ready" summary |

### Takeaways
1. **Step 1 copy should name the user's problem, with privacy reassurance in the subtitle.** Opal: "Choose your biggest distractions / Opal keeps your … selection private." SmartBlocker's version: "What pulls you off track?" with the subtitle "Everything is classified on this device. Nothing leaves your browser." The local model is SmartBlocker's differentiator, so say it at the moment of choice.
2. **Show the 13 categories as icon rows with a master "All distractions" row and a live counter.** Opal's sticky "13 CATEGORIES SELECTED" footer is good feedback. Pre-select the recommended set (video games, social media, memes, …) so a user can click Continue immediately. Show neutral categories as never-blocking, or hide them.
3. **Explain categories by example.** Opal expands a category into named apps (Social Media → X, Instagram, TikTok, YouTube). Because SmartBlocker blocks content rather than whole sites, each category row could show a muted example line ("e.g. Elden Ring boss guide, r/gaming, Twitch streams"). This teaches the AI model at the moment of choice.
4. **Step 2 combines focus goal and allowed sites, and both are skippable.** Opal's step 19 uses the same picker UI for "allowed" items. Reuse the Sites list component, pre-filled with DEFAULT_WHITELIST shown as removable chips, plus an optional focus-goal input. Use a clear "Skip" link (Tiimo / Structured pattern) and a 3-dot progress indicator.
5. **The last step lands on a real state, not a promise.** Opal step 21 drops the user on the live dashboard, and Structured ends with "your plan is ready" plus a summary. SmartBlocker's step 3 should summarize the choices ("Blocking 6 categories · 14 allowed sites · goal: thesis writing"), then show the 3-part "how it works" (reads the page title → classifies locally → blocks off-topic pages) and a CTA "Pin SmartBlocker to your toolbar" with an illustration.
6. **Avoid Opal's 21-step length.** Most of Opal's steps are surveys and permission prompts. Keep SmartBlocker to 3 steps. Ask for incognito access later, from the popup warning, not in the wizard.

---

## 4. Allow/block list editors (domains)

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Threads (desktop) | `screens:730c0ad23db3fc9b2ee10197` | img/12-threads-hidden-words-list.png | One input "Add words separated by commas…" with an inline "Add" action, and below it rows of entries, each with a right-aligned outlined "Remove" button |
| Dealfront | `screens:4430e2ec05c6214157d1b597` | img/13-dealfront-hostname-rule.png | "Add hostname rule" modal: HOSTNAME field with placeholder `example.com`, then examples of match semantics ("`dealfront.com` will match dealfront.com, www.dealfront.com, app.dealfront.com…", "`www.dealfront.com` matches only…"). Save stays disabled until valid |
| Opal Apps | `screens:61b122f2c5c06210ffb3bf5a` | img/05-opal-blocked-apps-schedules.png | Three buckets as cards: **Always Allowed (0 items)**, **Never Allowed (Hidden)**, **Distracting (2 items)**. The empty state reads "All apps are available. Not working? Reload Opal." |
| Drift / Proton / Resend | `screens:7654d0eaf5661dc6e74a106c`, `screens:56f0a0f17d9e692ed57e91ac`, `screens:99b4b57488966e327f49d874` | (not downloaded) | Single-field "add domain" modals with Save/Cancel |
| Gumroad | `screens:f4d73dc024224df95cfa012a` | (not downloaded) | Mass-block emails textarea inside settings (bulk text entry) |

### Takeaways
1. **Use Threads' layout: input + inline Add on top, rows with Remove below.** Accept comma- or newline-separated input in the same field, so pasting `reddit.com, x.com` adds two rows. This covers most of what "Edit as text" is for, and the toggle remains for full bulk replacement (Gumroad-style textarea).
2. **Show the match semantics next to the input.** Dealfront's examples ("`example.com` matches www. and app. subdomains") remove the biggest source of confusion in domain lists. Add one muted helper line under the Sites input, "`youtube.com` also covers `m.youtube.com` and `music.youtube.com`". For the keyword blocklist, use a different line: "matches anywhere in the URL or page title".
3. **Normalize and validate live.** Disable Add until the input parses. Strip `https://`, paths and `www.` automatically, and show the normalized host as a preview chip before adding.
4. **Bucket names should describe behaviour.** Opal's "Always Allowed / Never Allowed" are clearer than "whitelist/blocklist". On the Sites page, use two tabs or sections titled "Always allow" (domains, never checked by AI) and "Always block" (keywords or domains, blocked instantly without AI), each with an item count.
5. **Empty states should reassure and offer a recovery path.** Opal's "All apps are available. Not working? Reload Opal." For an empty block list: "Nothing on your block list. The AI handles everything else." Add a "Suggested" chip row with one-tap adds.
6. **Search when the list is long.** Opal's category picker puts search at the top of long lists (img/04). Show a filter input once a list has more than about 10 rows, and add a counter in the section header ("Always allow · 23").

---

## 5. Commitment and irreversible confirmations; active-lock state

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Alma | `screens:7c8dc816848a052e08702de7` | img/11-alma-hold-to-commit.png | Blank calm screen with only one "Hold to commit ✓" press-and-hold pill |
| Flora | `screens:3613af492190ff62bc9fff90` | img/15-flora-ack-checkbox-confirm.png | Dark modal: "You must check all boxes to continue", with 3 "I acknowledge that…" checkboxes, then Back and the destructive button |
| Signal | `screens:3dfdfcbf774275847398c96e` | (not downloaded) | "This can't be undone" confirmation with large Continue / Cancel |
| Yik Yak | `screens:358fc958c053387936375c93` | (not downloaded) | Type-a-phrase-to-confirm modal for permanent deletion |
| Halo Habits | `screens:b71442d70d95e1048e8828ee` | (not downloaded) | Commitment confirmation screen for a new habit |
| Opal session setup | `screens:c1adb689a999b7e2ae70d2a2` | img/01 | The difficulty tier states the cancel policy inline |
| Opal Blocks | `screens:708623e609f4349e404f086a` | img/02-opal-blocks-dashboard.png | Upcoming blocks show status chips "Starting in 10h 52m" and "Starting Monday". A gradient "Block Now" primary sits above three quick tiles: Schedule Session / Set App Limit / Set Lock |
| Fasting timer (Empty) | `screens:c9e8435f4d504fd19bd884c5` | (not downloaded) | Countdown of remaining time, with start and end times shown |

### Takeaways
1. **Use hold-to-commit for "Start focus session".** Alma's press-and-hold pill fits SmartBlocker well: it is deliberate, cannot be triggered by a stray click, and it feels like a commitment rather than a deletion. Inside the 380px popup, clicking Start should open an inline confirm panel, and the panel's primary control should be a "Hold to lock for 4h" button that fills over about 1.5 s. Make it keyboard-accessible: holding Space or Enter fills it the same way.
2. **State the exact end time, not just the duration.** Write "Locked until **3:40 PM today**", or for 8h "until **1:15 AM tomorrow**". Add "Can't be cancelled, shortened, or paused. Settings are read-only until then." This follows the Signal / Flora "cannot be undone" wording without the aggressive red of a deletion dialog. Keep the colour amber, not destructive red, because this is a commitment the user wants.
3. **Keep acknowledgement checkboxes for the heavier locks only** (Flora). Arming a password lock or a long timer lock from options › Locks could require ticking "I understand I can't unlock until …". Do not add checkboxes to the 1h popup session, because the hold gesture is already enough friction.
4. **Active-lock state as a countdown with start and end times.** Combine the fasting-timer pattern (remaining time plus the time range) with Opal's status chips. While locked, the popup's focus section becomes "🔒 Focus session · 2h 14m left · ends 3:40 PM" with a thin progress bar. Every disabled control in options shows the same chip.
5. **Show upcoming locks as status chips** (Opal: "Starting in 10h 52m"). Schedule cards in options, and a one-line "Next: Work hours in 1h 12m" in the popup, set expectations before enforcement starts.

---

## 6. Recurring weekly schedule editor

### References
| Product | Ref | Image | What it shows |
|---|---|---|---|
| Motion | `screens:79717123cc4abbea2a3d5f71` | img/08-motion-weekly-hours.png | "Set your weekly work hours": one row per weekday with a checkbox, `9:00 am – 5:00 pm` inputs, a `+` to add a second range (Friday has two), a trash icon per extra range, and a **"Copy times to…"** popover with day checkboxes and Apply. Unchecked days collapse to the day name only |
| Calendly | `screens:891b2439bf843fc924723cdc` | img/09-calendly-weekly-hours.png | Weekly hours per day, "unavailable" days, add/remove ranges |
| Chili Piper | `screens:d95282c79a8c240ed480e447` | (not downloaded) | Working-hours table with a toggle per day plus timezone |
| Sleep Cycle | `screens:9570b70ea3c7c57fbbb3549f` | img/10-sleepcycle-days-timerange.png | "Choose days" as 7 circular S M T W T F S chips, then "Choose hours" with two large times (Bedtime / Wake-up), a ring range picker, and the duration "8h" in the centre |
| Opal Blocks / Apps | `screens:708623e609f4349e404f086a`, `screens:61b122f2c5c06210ffb3bf5a` | img/02, img/05 | Saved schedules as named cards: "Work Time · Weekdays, 9:00 AM – 5:00 PM", with a "Starts in 12h" chip and a mini icon stack of what is blocked |

### Takeaways
1. **Show the list as named cards with a summary.** Each schedule card shows a name, a natural-language recurrence ("Weekdays, 9:00 AM – 5:00 PM", "Weekends"), a status chip ("Active now" or "Starts in 12h"), and a chevron to edit (Opal). Add schedules with a "+ New schedule" ghost card.
2. **In the editor, use day-of-week circle chips for the common case** (Sleep Cycle S M T W T F S). They are compact enough for the options page and readable at a glance. Add preset links above the chips: "Weekdays · Weekends · Every day".
3. **Show a time range as two big times plus a computed duration** (Sleep Cycle "10:00 PM → 6:00 AM · 8h"). That makes overnight windows obvious, and the editor should label them ("ends next day").
4. **Use Motion's per-day rows only as an advanced mode.** If different hours per day are needed, use one row per day with a checkbox, a time range, `+` for an extra range, and "Copy times to…". This is the most efficient pattern seen, but put it behind a "Different hours per day" toggle so the default stays simple.
5. **Make edit-while-locked visible.** Schedules can't be edited while a lock is active, so in that state show the cards read-only with the lock chip (see 5.4), rather than letting the user open an editor that then fails to save.

---

## Top 12 patterns to adopt

1. **Popup status sentence card** (Spherios status-first dashboard): `site · Allowed/Blocked — reason`, with exactly one contextual action.
2. **Header band: logo, master toggle, gear** (Bing tracking prevention master toggle). The paused state turns the whole popup into a single "Turn on" CTA.
3. **Focus session = 1h/4h/8h segmented control + one wide Start + a "Blocks N categories >" chip** (Opal timer `ff76db1b…`).
4. **Show the consequence inline before confirming** ("Can't be cancelled until 3:40 PM") (Opal difficulty hint `c1adb689…`).
5. **Hold-to-commit for starting a lock**, keyboard-accessible, in amber rather than destructive red (Alma `7c8dc816…`). Add acknowledgement checkboxes only for heavy options-page locks (Flora `3613af49…`).
6. **Countdowns with absolute end times and "Starts in…" chips**, used the same way in popup, options and schedule cards (Opal Blocks `708623e6…`).
7. **Linear row anatomy**: title + one-line description on the left, control on the right, rows grouped in one card per section, sidebar with tiny group headings (`7463e0a2…`).
8. **Sensitivity presets (Relaxed / Balanced (Recommended) / Strict) before the raw threshold**, with the raw value moved to Advanced (Bing `3b56b98f…`).
9. **Onboarding step 1: "What pulls you off track?" with a privacy subtitle, icon category rows, an "All" master row, a live "N selected" counter and pre-selected defaults** (Opal `b89b0063…`, `d2452125…`, flow `412d50a4…`).
10. **Allow/block lists**: one input that accepts comma or paste with inline Add, rows with Remove, a match-semantics helper line, live normalization, search above about 10 items, and behaviour-named buckets "Always allow / Always block" (Threads `730c0ad2…`, Dealfront `4430e2ec…`, Opal `61b122f2…`).
11. **Schedules as named summary cards**; the editor uses S-M-T-W-T-F-S chips, two big times plus a computed duration, and a "Copy times to…" advanced per-day mode (Opal, Sleep Cycle `9570b70e…`, Motion `79717123…`).
12. **Danger zone as the last, red-outlined card on Privacy and Advanced**, with modal confirmation for erase or reset, and locked settings showing a lock chip with the unlock time instead of silently disabled controls (Peerlist `8362a91b…`, Cloaked `dd74837a…`).

---

