# SmartBlocker popup + options UX research (2026-11-07)

Scope: toolbar popup (~380px, MV3, React + Tailwind + shadcn) and full-page options page, dark warm palette.
Method: web research via `tvly search` + `firecrawl-scrape` of primary sources (platform docs, design systems, NN/g, competitor help centres).
Convention: every finding carries a source URL. Anything marked **[general practice]** is my own synthesis and has no single source behind it.

---

## 1. Browser-extension popup UX

### Key findings
- **Size limits.** A popup "will be automatically sized to fit its contents. The popup's size must be between 25x25 and 800x600 pixels." — https://developer.chrome.com/docs/extensions/reference/api/action
- Firefox has the same 800x600 ceiling. Content past the clamp gets scrollbars, and no API sets popup size directly. — https://extension.js.org/docs/implementation-guide/popup-sizing
- **Recommended sizing CSS** (same source):
  - Give `body` a fixed width of 320–400px and let height follow the content.
  - Avoid `vh`/`vw` and `height:100%`. The viewport is the popup, so these measurements are circular, and `100vh` collapses unpredictably, especially in Firefox. Use pixel `min-height` instead.
  - Firefox needs the width on `body`, or the popup can render collapsed.
  - Browser zoom scales CSS px, so stay under about 750x550 to leave headroom.
- **Layout shift / first paint.** The same page says "The popup opens at the size of the first paint, then visibly jumps when fonts, images, or async data arrive". To prevent it:
  - Reserve space with `min-height` skeletons.
  - Keep the initial render synchronous where possible.
  - Hydrate data into pre-sized containers.
  - Use `scrollbar-gutter: stable` and `overflow-x: hidden`.
  - Source: https://extension.js.org/docs/implementation-guide/popup-sizing
- **Lifecycle.** "The popup's document is loaded every time the popup is shown, and unloaded every time the popup is closed." Clicking anywhere outside closes it. Firefox recomputes size at most 10×/s after DOM mutations. — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups
- **Keyboard access.** `_execute_action` (MV3) is a reserved command that opens the popup from a keyboard shortcut. — https://developer.chrome.com/docs/extensions/reference/api/commands, https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups
- **What goes where (Firefox Extension Workshop).** Use a toolbar button and popup for features that apply on almost any page. Settings that "change and save settings that affect the behavior of the extension" belong on an options page. Bundled pages handle larger forms and content. — https://extensionworkshop.com/documentation/develop/user-experience-best-practices/
- **"Tell the user what will happen, before it happens"** (same source):
  - Use descriptive button labels.
  - Tooltips should describe the action, not just repeat the extension name.
  - Use badges sparingly, never as persistent status. Severity colours are blue/green/yellow/red.
- **Keep it focused.** You should be able to explain the extension in three short sentences or fewer. — https://extensionworkshop.com/documentation/develop/user-experience-best-practices/
- **Persistent UI should not distract.** "make sure it enhances the user's browsing experience." — https://developer.chrome.com/docs/webstore/best-practices
- **Options page type.** Chrome supports a full-tab options page or an embedded one (`options_ui` with `open_in_tab: false`) inside chrome://extensions. — https://developer.chrome.com/docs/extensions/develop/ui/options-page. A sidebar layout needs the full tab (`open_in_tab: true`, or `options_page`). **[general practice]**
- **Apple HIG on settings placement.**
  - Put "general, infrequently changed settings" in the settings area.
  - Let people change task-specific options "without going to your settings area".
  - Source: https://developer.apple.com/design/human-interface-guidelines/settings

### Apply to SmartBlocker
- Fix `body` at 380px wide. Use no `vh` or `%` heights. Keep total height ≤ ~550px so the popup never scrolls in the default state (it scrolls only when the lock or session panel expands).
- The popup is rebuilt from scratch on every open, so render synchronously from a snapshot.
  - Read `settings`, `lockState` and the active-tab verdict once at boot.
  - Pre-size the verdict card with a fixed-height skeleton: verdict line, category, two action buttons.
  - Never let the "Should've been blocked / Always allow" row pop in late. **[general practice derived from the above]**
- Self-hosted fonts must be preloaded or use `font-display: optional` so the popup doesn't jump on font swap. **[general practice]**
- Popup = glanceable state + 1-tap actions only: verdict, quick actions, focus goal, start Focus session, master on/off, gear.
  - Anything with a list, a multi-field form, or diagnostics goes on the options page. That matches the agreed plan.
  - Popup state is lost on outside click, so never put a multi-step form there. The Focus-session confirm must be a single inline step.
- Give the action icon a descriptive tooltip ("SmartBlocker — on, this page allowed"), not just the name.
- Use the badge only for exceptional states, e.g. a lock is active ("🔒"/timer) or "OFF". Never use it for a running count.
- Ship an `_execute_action` default shortcut (e.g. Alt+Shift+S) and mention it in onboarding.
- Gear opens the options page with `runtime.openOptionsPage()`. Deep-link to sections with `#locks`, `#sites` and so on, so popup hints ("Locked — see why") land on the right section.

---

## 2. Settings information architecture

### Key findings
- **Vertical (left) navigation**, per NN/g (https://www.nngroup.com/articles/vertical-nav/):
  - It scans more efficiently than horizontal navigation, has room to grow, is familiar from desktop apps, and translates naturally to mobile.
  - Place it on the left with a noticeable design.
  - Don't duplicate it horizontally, and don't hide it behind icons.
  - Put the less important items at the bottom.
- **Tabs** suit a few peer content groupings and need at least two selection indicators on the active tab. — https://www.nngroup.com/articles/tabs-used-right
- **Apple HIG settings**:
  - Minimize the number of settings.
  - Don't ask for information you can detect.
  - Keep a stable navigation that "always indicates the active toolbar button".
  - Update the window title to reflect the current pane.
  - Source: https://developer.apple.com/design/human-interface-guidelines/settings
- **Progressive disclosure** (https://www.nngroup.com/articles/progressive-disclosure/):
  - Show the most important options first and defer specialized ones to a secondary level.
  - "the very fact that something appears on the initial display tells users that it's important."
  - The split has to be right: frequently needed options can't hide in Advanced.
  - A tertiary level is fine for very rare options. Wizards are "staged disclosure".
- **Toggles mean immediate effect** (https://www.nngroup.com/articles/toggle-switch-guidelines/):
  - "Toggle switches should take immediate effect and should not require the user to click Save."
  - If changes can't be immediate, use a checkbox plus Save instead.
  - Label what the control does when ON, and use high-contrast state colour.
- **Primer saving patterns** (https://primer.style/ui-patterns/saving):
  - Never mix explicit and automatic save within one form.
  - Use autosave for *imperative* controls such as toggles and custom single-selects.
  - Use explicit save for text inputs, checkbox groups, radio groups and native `<select>`. Reason: screen-reader users arrowing through radios or selects would apply each option.
  - When an autosaved change isn't visible in the viewport, "provide feedback to let the user know that the change occurred successfully."
  - Don't disable or hide the Save button.
  - Use action verbs: "Save", "Add", "Delete".
  - Confirm destructive submits, and offer undo for risky changes.
- **GitLab Pajamas autosave** (https://design.gitlab.com/patterns/saving-and-feedback):
  - Autosave per input, never whole forms.
  - Click-triggered changes save immediately. Typed text saves on blur and about 3s after the last keystroke.
  - Show a status like "Saved just now".
  - Think twice about autosaving financial, security or privacy data.
- **Danger zone** (https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/):
  - Visually separate it with red, an icon or a border.
  - Give each action a clear description of what happens.
  - Ask for extra effort, such as re-entering a password.
  - "Keep only truly critical actions there."
- **Atlassian.** The danger button appears "as a final confirmation for a destructive and irreversible action". — https://atlassian.design/components/button/examples
- **GOV.UK notification banner** can confirm the outcome of something the user just did when they haven't finished the overall journey. — https://design-system.service.gov.uk/components/notification-banner/

### Apply to SmartBlocker
- Left sidebar with six items in task order: **Blocking, Sites, Schedule, Locks, Privacy, Advanced**. Advanced goes last per NN/g.
  - Show text labels, not icon-only.
  - Use two active indicators, e.g. an amber bar plus a bold label/background.
  - Put `aria-current="page"` on the active item.
  - Update `document.title` ("Sites — SmartBlocker settings").
- Below about 720px, collapse the sidebar into a top select or horizontal scroller rather than a hamburger. NN/g says don't hide navigation. **[general practice]**
- Pick ONE save model per section and say so. Recommended:
  - Toggles, sliders and custom selects autosave.
  - The focus-goal text autosaves on blur plus a 1–3s debounce.
  - List add-fields commit on Enter/"Add", which is an explicit per-item action.
  - "Edit as text" mode uses explicit **Save list / Cancel**, because a textarea is declarative.
  - Drop the global sticky "Save" button, or keep it only for text mode. Never mix both models in one card.
- Signal autosave with a small polite status near the header ("Saved" / "Saving…" / "Couldn't save — settings are locked") in an `aria-live="polite"` region. Don't add per-field green checks: Primer warns they read as validation.
- **Advanced** holds model/threshold internals, latency log, Test Pair, history scan, diagnostics and export. Collapse each group by default.
- **Danger zone** at the bottom of Privacy/Advanced, with a red border:
  - Erase shared data, reset all settings, clear corrections.
  - Each gets a one-line consequence and a specific verb button ("Erase shared feedback").
  - Only truly destructive actions belong here. Locks are not "danger", they get their own section.
- Settings writes throw while locked (`setSettings`). Every autosave failure must surface the lock reason inline, not as a silent revert. **[general practice; ties to Q4]**

---

## 3. Onboarding for blocker / focus apps

### Key findings
- **Firefox Extension Workshop onboarding page contents, in order:**
  1. A brief feature overview.
  2. How to reach the features (toolbar, popup).
  3. "at least one simple activity that the user can do immediately".
  4. Quick-config options plus a link to full settings ("don't expect your new user to be happy working through several pages of settings now").
  5. Paid features and their cost.
  6. Help links. No ads.
  - Ghostery offers "a simple one-click option and a link to the full settings".
  - Source: https://extensionworkshop.com/documentation/develop/onboard-upboard-offboard-users/
- If the user skips onboarding, "ensure that your extension is ready to be used immediately after installation ... work as expected for most users without the need for customization." — https://extensionworkshop.com/documentation/develop/user-experience-best-practices/
- **NN/g on onboarding** (https://www.nngroup.com/articles/mobile-app-onboarding/):
  - Avoid feature-promotion onboarding at first launch.
  - *Content* customization (picking what matters) is appropriate, but "keep it brief. Explain why you want that data and how it will be used."
- **NN/g on wizards** (https://www.nngroup.com/articles/wizards/):
  - Show the list of steps and highlight the current one.
  - Wizards aren't gracefully interruptible, so preserve state.
- **one sec** cut its setup to "a one-step process instead of a technical" flow: "setup takes literally one sec: confirm the automation for an intervention." — https://one-sec.app/blog/one-sec-60
- **ScreenZen**'s basic setup ends by asking you to open an app you just added, so you immediately see the intervention. That is time-to-value by demonstration. — https://www.howtogeek.com/download-this-screen-time-app-your-eyes-will-thank-you-later
- **Opal**'s iOS onboarding (23 screens on Mobbin) collects goals and profile info, then ends with a privacy-framed Screen Time permission request. — https://mobbin.com/explore/flows/7b6dc8e9-56e3-4db3-a898-cfdddc9b1e8a
  - Note: long and marketing-heavy, which suits a paid mobile funnel but not a browser extension. **[general practice]**
- **Cold Turkey** ships a default distraction list and pre-made categories ("Use the default distraction list, import pre-made categories, or create your own"). — https://getcoldturkey.com/features/
- **Freedom** ships preset blocklists such as social media and news (https://www.blok.so/resources/freedom-app-review-does-blocking-websites-and-apps-actually-work). Its first session = pick blocklists, then "Start a Session" with a length. — https://support.freedom.to/en/articles/1773666-how-to-start-a-block-session
- **Incognito access** can't be granted programmatically.
  - The user must enable it on the extension's details page in chrome://extensions. — https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
  - The extension can detect it with `extension.isAllowedIncognitoAccess()`. — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extension/isAllowedIncognitoAccess
  - Competitors such as BlockSite handle it with step-by-step instructions ("Manage extensions → Details → Allow in Incognito"). — https://www.avg.com/en/signal/how-to-block-websites-chrome
- **Permission priming.** Explain the value at the moment of need, with "Not now" and "Turn on". Declining must not break the app. — https://www.aarup.me/dictionary/permission-priming. The PAIR guidebook also says "Ask users for permissions early ... consider reminding them of these settings when they shift into different contexts". — https://pair.withgoogle.com/chapter/explainability-trust

### Apply to SmartBlocker (3-step wizard)
- **Step 0 / defaults:** the extension must already work before the wizard finishes. Safe default categories are on, the whitelist is seeded, and the threshold is default.
- **Step 1 — "What distracts you?"** Preselected category chips (video games, social media, memes…) with one line on why: "SmartBlocker only blocks pages that match these."
- **Step 2 — "Sites you always need"**:
  - Show the seeded allowlist as removable rows and let the user add a couple.
  - Optional: the focus goal ("What are you working on?").
  - Skippable.
- **Step 3 — "Try it"**:
  - Run a live demo: a Test Pair or a sample title that blocks in about 15ms. This is the time-to-value moment, like ScreenZen asking you to open an app.
  - Show where the toolbar icon is and how to pin it.
  - Ask for **incognito access** here with a primer: "Private windows are a blind spot unless you allow SmartBlocker there."
    - Offer an "Open extension settings" button: `tabs.create({url: 'chrome://extensions/?id=' + id})` on Chrome. Firefox uses about:addons. **[general practice — verify the Firefox path]**
    - Then re-check with `isAllowedIncognitoAccess()` and show ✓.
- Show a step indicator ("Step 2 of 3"), and Back/Skip on every step. Persist progress so closing the tab resumes.
- Do NOT ask for locks, passwords, schedules, the companion or feedback sharing during onboarding. Mention Pro/companion as one line with a link, per Firefox guidance on disclosing paid features.
- Do NOT promote feature tours (NN/g). Teach lock/schedule contextually the first time the user opens those sections.

---

## 4. Commitment devices / irreversible actions

### Key findings
- **NN/g confirmation dialogs** (https://www.nngroup.com/articles/confirmation-dialog/):
  - Use confirmations only for "actions with serious consequences", never for routine ones, or people confirm on autopilot ("cry wolf").
  - Restate exactly what will happen, with specifics.
  - Replace Yes/No with outcome labels ("Delete file" / "Keep file").
  - MailChimp's type-to-confirm adds "extra protection against automated behavior".
- **Smashing** (https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/):
  - Name the affected entity in the title.
  - Prefer "Pay $97" over "Confirm".
  - Type-to-confirm is the heavier option.
  - Inline two-click confirmation exists to prevent *accidental* clicks, not to convey gravity.
- **Freedom Locked Mode** (https://support.freedom.to/en/articles/1802927-locked-mode):
  - Warns up front: "We recommend enabling Locked Mode only after you're confident with your Freedom schedules, because it cannot be turned off during an active session."
  - Lists exactly what is restricted. Upcoming sessions stay editable.
  - "the 'End Session' option remains visible during the first minute of a Locked Mode session, allowing for immediate adjustments", plus one emergency exit per 7 days. — https://support.freedom.to/en/articles/1776713-ending-a-block-session
- **Opal** offers three session difficulty levels:
  - Normal: can break or cancel.
  - Timeout: growing delays.
  - Deep Focus: cannot cancel.
  - Sources: https://lifestack.ai/blog/opal-focus-app, https://www.youtube.com/watch?v=WGD4FfMuWBY ("Optimise your focus time with Opal Sessions").
- **Cold Turkey lock types** (https://getcoldturkey.com/features/):
  - Timer ("You can always extend the end time").
  - Random text: type 1–5000 chars to unlock.
  - Restart, password ("useful ... with an accountability partner"), time range.
  - Friction is applied to *unlocking*, not to locking.
  - Its user guide notes some settings "can't be disabled during locked blocks". — https://getcoldturkey.com/support/user-guide
- **Disabled-state explanations** (https://www.smashingmagazine.com/2024/05/hidden-vs-disabled-ux):
  - "Be sure to explain why a feature is disabled and also how to re-enable it."
  - Prefer keeping controls enabled and explaining on interaction.
  - Natively `disabled` buttons can't be focused or reached by keyboard.
- **CSS-Tricks.** Use `aria-disabled="true"` plus JS guards so a locked control stays focusable and announces its state and reason. — https://css-tricks.com/making-disabled-buttons-more-inclusive
- **Countdowns.** `role="timer"` has implicit `aria-live="off"` so it doesn't spam screen readers. Announce milestones separately. — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role, https://bati-itao.github.io/learning/esdc-self-paced-web-accessibility-course/module11/aria-live.html
- **Hold-to-confirm.** There is no strong platform guidance. Any press-and-hold needs a keyboard equivalent (WCAG 2.1.1 Keyboard — https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) and should fire on release (2.5.2 Pointer Cancellation — https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html). Mostly marketing blog support, so treat it as **[general practice / weak evidence]**.
- **Password locks.** WCAG 2.2 3.3.8 Accessible Authentication: don't block paste or require transcription; password managers must work. — https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html

### Apply to SmartBlocker
- **Focus session start (popup).** Use a two-step *inline* confirm, which is right for a 380px popup that dies on blur.
  - Step 1: pick a duration (presets 25 / 50 / 90 min).
  - Step 2: the panel restates: "Lock for 50 min — until 3:40 PM. You can't stop it early, change blocking settings, or turn SmartBlocker off until then."
  - Primary button: **"Lock until 3:40 PM"**. Secondary: **"Not now"**.
  - Never "Confirm" or "Yes".
- Reserve **type-to-confirm** (e.g. type "lock") for heavier commitments: sessions over ~4h, arming a password lock, or locking schedules. Use the same specific-verb button. Don't use hold-to-confirm as the only method.
- Optional, worth testing: a Freedom-style **60-second grace "Undo"** right after starting. It catches mis-taps without weakening the commitment. This is a product decision, because SmartBlocker currently has no undo.
- **Active lock state everywhere:**
  - A persistent banner at the top of the popup and the options page: "🔒 Focus session — 23 min left (ends 3:40 PM)".
  - Show both a relative and an absolute time.
  - Countdown text in `role="timer"`, with an `aria-live="polite"` announcement only at start, 5 min left and end.
  - Badge text such as "23m" is acceptable because a lock is exceptional.
- **Locked controls explain themselves:**
  - Keep them visible and focusable (`aria-disabled`, not `disabled`).
  - Show a muted lock icon, and on focus/click give an inline reason: "Locked by your focus session until 3:40 PM".
  - Group the reason once per card rather than per control to reduce noise.
- Locks section copy mirrors Freedom:
  - State what a lock restricts (settings, off switch, allowlist removals) and what stays possible: adding more blocks, extending, editing upcoming schedules when the model allows it.
  - Say "You can always extend, never shorten" (Cold Turkey's framing).
- Password lock field allows paste and password managers (WCAG 3.3.8). Show the min-length 8 rule up front, not after failure.

---

## 5. Domain list editing

### Key findings
- **Chips vs rows.** Material input chips represent user-entered discrete items, with a trailing remove icon. — https://m3.material.io/components/chips/guidelines
- **Atlassian tags** can be removable via a close button, and the remaining tags realign on removal. — https://atlassian.design/components/tag/usage
- **Rows (MOJ "Add another")** suit lists where each item may carry actions or details, each with a labelled "Remove" button. — https://design-patterns.service.justice.gov.uk/components/add-another
- **Be forgiving on input.**
  - Accept "information in different formats, as long as it's not ambiguous".
  - "Use validation to ignore unwanted characters ... spaces, invisible characters or punctuation".
  - Validate on submit, not when the user leaves the field.
  - Source: https://design-system.service.gov.uk/patterns/validation/
- **Precedent.** Cold Turkey accepts both `reddit.com` (domain + subdomains) and `reddit.com/r/funny` (path) entries, plus `*` wildcards. — https://getcoldturkey.com/features/
- **Normalization tooling.**
  - The WHATWG URL parser lowercases hosts and converts IDN to punycode. — https://url.spec.whatwg.org/, https://developer.mozilla.org/en-US/docs/Web/API/URL
  - The Public Suffix List defines registrable domains (eTLD+1, e.g. `bbc.co.uk`). — https://publicsuffix.org/
- **Primer.** Explicit save for text inputs; inline-edit inputs keep the save button right next to the input. — https://primer.style/ui-patterns/saving

### Apply to SmartBlocker
- Use **rows, not chips**, on the options page. Domains are long, rows scan in a column, and each row needs "Remove" (and possibly a "subdomains included" hint). Chips are fine for the *category* picker.
- **Add field**:
  - Single input plus an "Add" button, also triggered by Enter.
  - **Normalize on add**: trim; strip scheme, `www.`, credentials, port, path/query/hash. Lowercase. IDN → punycode via `new URL()`.
    - Example: paste `https://www.YouTube.com/watch?v=x` → `youtube.com`.
    - Show the normalized value in the toast/row so users see what was saved. **[general practice built on GOV.UK forgiving-input rule]**
  - Allow bare hostnames by prefixing `http://` before parsing.
  - Reject only truly invalid input, with specific error text: "Enter a website like example.com".
  - **Duplicates:** don't error. Highlight or scroll to the existing row and say "youtube.com is already on your allow list".
  - Also detect redundancy, e.g. adding `m.youtube.com` when `youtube.com` (which covers subdomains) is present: say "Already covered by youtube.com".
- **Bulk paste**:
  - If the pasted text contains newlines, commas or spaces, split it, normalize each item and add them all.
  - Summarize: "Added 12 sites · 2 already listed · 1 not a website (ignored: 'foo bar')". **[general practice]**
- **"Edit as text"** toggle swaps rows for a textarea, one entry per line, with explicit "Save list" / "Cancel" (Primer: textarea is declarative). Run the same normalization and summary on save.
- Blocklist entries are substring matches. If the semantics differ from the allowlist's domain match, say so under each list heading: "Pages whose address or title contains any of these words are blocked instantly."
- **Remove** button: `aria-label="Remove youtube.com"`, a 24px+ target, and move focus to the next row (or the add field) after removal. Offer "Undo" in the status region rather than a confirm dialog (NN/g: no confirms for routine actions).
- While locked, removal from the blocklist and additions to the allowlist are refused. Keep the rows visible and show the lock reason (Q4).

---

## 6. Weekly schedule editor

### Key findings
- **Cold Turkey:** "Click and drag directly on the schedule to add a block. The schedule will automatically repeat every week." A weekly grid. — https://getcoldturkey.com/features/
- **Freedom recurring session:** pick blocklists, devices, days of the week, and start/end times. Setting start = end makes it continuous ("always active"). — https://support.freedom.to/en/articles/4619932-start-later-and-recurring-sessions, https://support.freedom.to/en/articles/1776713-ending-a-block-session
- **Apple Screen Time Downtime:** "Every Day" with one From/To range, or "Customize Days" for per-day times. Ranges like 10 PM–7 AM cross midnight. — https://appletoolbox.com/how-to-customize-downtime-settings-in-screen-time
- **LeechBlock** uses a compact text format for time periods (e.g. "0900-1700") plus day checkboxes. Power-user friendly but error-prone for novices. — https://www.proginosko.com/leechblock/documentation
- **Range announcements:** announce the selected range through `aria-live="polite"` and give start/end inputs distinct labels. — https://uxpatterns.dev/patterns/forms/date-range

### Apply to SmartBlocker
- Each schedule is a card:
  - Name (optional) + **day chips** (M T W T F S S as toggle buttons with `aria-pressed`, full day names in `aria-label`).
  - **From / To** time inputs: native `<input type="time">`, which follows the locale's 12/24h.
- **Presets row:** "Weekdays 9–5", "Every evening 7–11 PM", "Weekends", "Custom". Presets only fill fields and stay editable.
- **Overnight ranges:** when To ≤ From, show inline "Ends next day (Tue 7:00 AM)" and accept it. Don't raise an error. Treat From = To as "all day" (Freedom precedent) and say so explicitly. **[general practice for the "next day" label]**
- Show a human-readable summary line on each card: "Mon–Fri, 9:00 AM – 5:00 PM · blocks your selected categories". Optionally add a read-only mini week strip for overview. A drag grid à la Cold Turkey is power-user nice-to-have, not the primary editor (keyboard and touch accessibility cost).
- Validate on save, not on blur (GOV.UK): at least one day selected, and overlaps merged with a notice.
- Lock interplay: schedule editing is refused while locked. Show the reason (Q4) and a "next change allowed at …" time if derivable.

---

## 7. Explaining AI decisions + copy

### Key findings
- **Microsoft HAX Guideline 11:** "Make clear why the system did what it did. Enable the user to access an explanation of why the AI system behaved as it did." Other guidelines cover efficient correction and remembering recent interactions. — https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines
- **Google PAIR** (https://pair.withgoogle.com/chapter/explainability-trust):
  - "The best explanation is likely a partial one."
  - Explain the *specific output*.
  - Example-based explanations help with surprising results.
  - Don't show granular confidence if it doesn't change the decision ("what should I do when the system is 85.8% certain vs. 87%?").
  - If showing it, bucket it (High / Medium / Low).
- **Apple HIG ML** (https://developer.apple.com/design/human-interface-guidelines/machine-learning):
  - "translate confidence values into concepts that people already understand".
  - Prefer semantic categories or actionable suggestions over raw numbers.
  - Attributions express "the underlying basis or rationale ... without explaining exactly how a model works", and should be neither too specific nor too general.
  - Corrections should be easy and guided, "Provide immediate value when people make a correction", and persist.
  - "Let people correct their corrections."
  - Use "simple, direct language to describe each explicit feedback option and its consequences" and avoid vague terms like "dislike".
  - Explicit feedback must be voluntary.
- **Button copy.** "Write button text in sentence case, describing the action it performs." — https://design-system.service.gov.uk/components/button/
- **Primer** CTAs use active verbs ("Save", "Add", "Delete", "Update"). — https://primer.style/ui-patterns/saving
- **NN/g toggles.** Labels state what happens when ON. Test by appending "on/off" aloud. — https://www.nngroup.com/articles/toggle-switch-guidelines/

### Apply to SmartBlocker
- **Popup verdict**, as a partial, output-specific attribution:
  - "Blocked: looks like **social media**", or "Allowed: looks like **work & docs**".
  - Show a short basis line from real signals: "Based on the page title and site (reddit.com)". When focus is relevant: "Matches your focus goal". When the deterministic blocklist hit: "Matched your block rule 'shorts'". When whitelisted: "On your allow list".
- **No raw percentages by default.** Map the score into "Clear match / Likely / Borderline". Keep the number in Advanced or a "Details" disclosure for the curious.
  - "Borderline" is exactly when the quick actions matter: "Not sure? Tell SmartBlocker" → corrections.
- **Corrections, Apple-style:**
  - Buttons state consequences: "Should've been blocked" → "Got it — similar pages will be blocked", and "Always allow this site" → "reddit.com added to your allow list · Undo".
  - Apply immediately and persist. Corrections must be reversible (an Undo toast, plus a list in options).
- **Sensitivity control:** avoid "threshold"/"confidence". Example:
  - Label: "How strict should SmartBlocker be?"
  - Stops: "Relaxed — only block clear matches" / "Balanced (recommended)" / "Strict — block anything that might be distracting".
  - Explain the trade-off in one line: "Stricter blocks more, but may block useful pages."
  - Use 3–5 named stops, not a free 0–1 slider. Show the numeric value in Advanced only. **[general practice built on Apple/PAIR guidance]**
- **Copy rules:**
  - Sentence case everywhere.
  - Buttons start with a verb and name the object ("Add site", "Start focus session", "Erase shared data").
  - Use "you"/"your". Avoid ML jargon (centroid, softmax, NLI, embedding) outside Advanced.
  - Toggle labels are positive statements of the ON state ("Share anonymous corrections to improve SmartBlocker"), not "Disable X".

---

## 8. Accessibility essentials

### Key findings (WCAG 2.2 AA unless noted)
- **1.4.3 Contrast (Minimum):** text 4.5:1, large text 3:1. — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- **1.4.11 Non-text Contrast:** UI component boundaries, states and focus indicators 3:1 against adjacent colours. Switch track/thumb states and input borders count. — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- **1.4.1 Use of Color:** state can't rely on colour alone (e.g. on/off, blocked/allowed). — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- **2.4.7 Focus Visible** and **2.4.11 Focus Not Obscured (Minimum):** a focused element must not be hidden by sticky headers or banners. — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html, https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- **2.5.8 Target Size (Minimum):** pointer targets ≥ 24×24 CSS px, or spaced so a 24px circle doesn't overlap. — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- **4.1.3 Status Messages:** status changes (saved, added, error summaries) must be programmatically determinable, e.g. `role="status"`/`aria-live`, without moving focus. — https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- **Switch semantics.** `role="switch"` takes `aria-checked` true/false only (no mixed) and reads as on/off. — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/switch_role, https://www.w3.org/WAI/ARIA/apg/patterns/switch/. Use a checkbox when the change only applies on Save (NN/g toggles).
- **Timers.** `role="timer"` is live-off by default. — https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role
- **Reduced motion.**
  - 2.3.3 Animation from Interactions (AAA): https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
  - `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- **3.3.8 Accessible Authentication:** allow paste and password managers. — https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html
- **Dark theme** (Material, https://m2.material.io/design/color/dark-theme.html):
  - Use dark grey rather than black surfaces.
  - Show elevation with lighter surfaces.
  - Desaturate accents so they pass 4.5:1.
  - Use limited colour on large surfaces. White body text on the dark surface reaches 15.8:1.
- **Disabled controls.** `aria-disabled` keeps them focusable and announced. — https://css-tricks.com/making-disabled-buttons-more-inclusive

### Apply to SmartBlocker
- Contrast-audit every token pair in `tokens.css`. Warm amber accents in particular:
  - Amber text on warm-dark surfaces usually passes.
  - **White text on an amber button often fails**, so use near-black text on amber fills.
  - Muted/secondary text must still hit 4.5:1. Check it, because "muted warm grey" is the usual failure.
  - Switch off-state track and input borders need 3:1 against the card background. **[general practice; verify with a checker]**
- Focus ring: 2px+ amber (or a light outline plus offset) with ≥3:1 against both the surface and the control. Use `:focus-visible` only. Make sure the sticky options header and the lock banner never cover the focused element (2.4.11): `scroll-margin-top` / `scroll-padding-top` on `html`.
- Icon buttons (remove ×, gear, info): ≥24×24 hit area even with 16px glyphs. Aim for 32px in the popup. Each needs an `aria-label` that includes the object ("Remove youtube.com").
- Switches: shadcn/Radix Switch renders `role="switch"` with `aria-checked`. Tie each to a visible `<label>`. Add a text state or an icon change besides colour (1.4.1).
- One polite live region per surface for "Saved", "Added 3 sites", "Couldn't save — locked until 3:40 PM". Use `role="alert"` only for real errors.
- Popup keyboard:
  - Logical tab order: verdict actions → focus goal → Start session → on/off → gear.
  - Esc in the inline confirm returns to the Start button.
  - Don't autofocus a text input on open, because it steals typing intent and screen readers start mid-UI. **[general practice]**
- Options sidebar is a `<nav aria-label="Settings sections">` with `aria-current`. Each section has an `<h2>`. When switching sections, move focus to the section heading.
- Wrap GSAP and other animations in `prefers-reduced-motion: reduce` checks. Use no motion on the countdown beyond the number change.

---

## Prioritized implementation checklist

**P0 — must ship with the overhaul**
1. Popup: fixed 380px `body` width, no `vh`/`%` heights, pixel-height skeletons for the verdict card and quick actions. Synchronous first render from one boot snapshot, with zero layout shift (`scrollbar-gutter: stable`).
2. Popup contains only: verdict + basis line, "Should've been blocked" / "Always allow this site", focus goal, Start focus session, master on/off, gear. Everything else lives in options (Advanced for diagnostics).
3. Focus session start: duration presets, then an inline restatement with the absolute end time and the consequences. Specific-verb primary ("Lock until 3:40 PM") and "Not now". No Yes/Confirm.
4. Active-lock banner in popup and options: relative + absolute time, `role="timer"`, milestone-only `aria-live` announcements.
5. Locked controls stay visible and focusable (`aria-disabled`), with an inline "why + until when" reason. Every refused write (`setSettings` throw) surfaces the reason in the status region and never fails silently.
6. Options: left sidebar nav (Blocking, Sites, Schedule, Locks, Privacy, Advanced). Text labels, two active indicators, `aria-current`, `document.title` per section, hash deep-links usable from the popup.
7. One save model per control type: toggles, selects and sliders autosave. Text fields save on blur + debounce. "Edit as text" uses explicit Save list / Cancel. A single polite "Saved" status, no global Save button mixed with autosave.
8. Domain add field: forgiving normalization (URL → host, strip `www.`, lowercase, punycode), Enter to add, duplicate/"already covered" messages instead of errors, removable rows with object-specific `aria-label`s and Undo.
9. WCAG 2.2 AA pass on the warm dark tokens: 4.5:1 text (including muted text), 3:1 for borders, switch tracks and focus rings. Dark text on amber fills. Never colour-only state.
10. Targets ≥24px (32px in popup), `:focus-visible` rings never obscured by sticky header or banner (`scroll-padding-top`).

**P1 — strongly recommended**
11. 3-step first-run wizard: categories → allow list + optional focus goal → live demo and pin icon, with step indicator, Back/Skip and resumable state. The extension works fully if skipped.
12. Incognito-access primer in wizard step 3 and in the popup warning. Detect with `isAllowedIncognitoAccess()`, deep-link to the extension's details page, re-check and show ✓.
13. Verdict confidence as words ("Clear match / Likely / Borderline"), raw score only in Advanced/Details. The basis line names the real signal (category, allow list, block rule, focus goal).
14. Sensitivity control as 3–5 named stops ("Relaxed / Balanced (recommended) / Strict") with a one-line trade-off. The numeric threshold lives in Advanced.
15. Corrections apply immediately, confirm their consequence in plain words, offer Undo, and are listed and editable in options.
16. Schedule cards: day chips (`aria-pressed`), native time inputs, presets (Weekdays 9–5, Evenings, Weekends), an "Ends next day" hint for overnight ranges, From = To meaning all day, and a plain-language summary line. Validate on save.
17. Bulk paste and "Edit as text" for lists: split, normalize and summarize results ("Added 12 · 2 already listed · 1 ignored").

**P2 — polish / test**
18. Type-to-confirm only for heavy commitments (long sessions, password arm, schedule lock). Password fields allow paste and managers. Explain the min length 8 up front.
19. Evaluate a Freedom-style 60-second post-start "Undo" grace for Focus sessions (product decision, not a default).
20. Danger zone at the bottom of Privacy/Advanced (erase shared data, reset settings, clear corrections), red-bordered, each with a consequence line and a verb-object button.
21. `_execute_action` keyboard shortcut and a descriptive action tooltip. Badge only for exceptional states (OFF, lock countdown).
22. `prefers-reduced-motion` respected for all GSAP/transition effects. Copy pass: sentence case, verb-first buttons, no ML jargon outside Advanced, toggle labels describe the ON state.
