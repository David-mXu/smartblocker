# SmartBlocker Design System — "Lamplight"

> **Read this before touching any UI** (`src/popup/`, `src/options/`,
> `src/blocked/`, `src/background/blockscreen*.ts`, `src/components/ui/`,
> `src/styles/`). It is the single source of design decisions. The landing
> site (`site/`) shares the tokens but follows its own editorial spec (§9).
>
> History: 2026-11-07 (a) moved the marketing showcase to `site/` and
> introduced the Warm Obsidian + Amber tokens; (b) **this rewrite** replaced
> the card-heavy "HUD" look with the Lamplight system below, after a
> rendered audit (§1) showed the extension UI read as generic.

---

## 0. How this doc was made (provenance)

- **Design skill (primary): `Dammyjay93/interface-design`.** Chosen via the
  Lazyweb design-skill routing table (fetched through Lazyweb
  `lazyweb_fetch_best_practice`): it is the pick for *product UI — dashboards,
  settings pages, tools* and explicitly **not** for marketing pages. Drives:
  intent-first brief, domain exploration, one focal point per view,
  weight-over-size hierarchy, borders-only depth, the swap/squint/signature/
  token checks (§8).
- **Component rules: `shadcn-ui/ui` skill.** Semantic tokens only, variants
  live in `cva`, `gap-*` not `space-y-*`, compose existing components first.
- **Rejected for the extension UI:** `gpt-taste` (landing-page skill — its own
  routing entry says "do not use for dashboards"; it is why the options page
  previously looked like a brochure — it now lives only in `site/`) and
  `ui-ux-pro-max` (greenfield system generator; we already had tokens and
  needed hierarchy, not a palette lookup).
- **Product references (Lazyweb):** board
  <https://www.lazyweb.com/agentic-search/699981d4-0acf-4bf4-ae54-e28bdb662eaa>
  | Ref | What we took |
  | :-- | :-- |
  | Linear settings `screens:7463e0a2461687b16b38174a`, `screens:151bec759a7c4533348290e3` | Settings = ONE surface: section heading → grouped rows; row = label + one-line description left, control right. No nested cards. |
  | Notion settings `screens:8401db8a7bb5bec8c8e6a39b` | Sticky left nav + flat rows; every toggle on one right-hand rail. |
  | Supercut settings `screens:65a6e853abb0210d70b55a6c` | Dark warm-neutral surfaces with a single quiet accent. |
  | Opal Blocks / Clarity Mode `screens:708623e609f4349e404f086a`, `screens:c1adb689a999b7e2ae70d2a2` | Status first; time shown as relative chips ("Starting in 10h 52m"); exactly one primary action. |
  | Opal interstitial `screens:8e205c9f0ec15656c593b1dc`, Endel session-over `screens:2b5f5da7c0c57517cfd64137` | Block/limit screens are near-empty, calm, one focal element, one action — not an error page. |
  | Counter-example `screens:30beddaecf4445cf2e211401` | Card-grid "protection dashboard" with gradients — what we moved away from. |

---

- **UX overhaul references (2026-11-07, second pass — structure & flow):**
  Lazyweb board <https://www.lazyweb.com/agentic-search/9ec1ed31-bb59-477b-bb92-95bce0261180>
  (Opal session setup / onboarding / blocks, Linear settings sidebar, Alma
  commit, Sleep Cycle + Motion schedules, Threads/Dealfront list editors,
  Bing presets) plus sourced web research (Chrome/Firefox extension UX,
  NN/g, Primer save patterns, GOV.UK input, Apple ML + Google PAIR on
  explaining verdicts, WCAG 2.2). Full reports:
  `docs/ux-research/2026-11-07/lazyweb-references.md` and
  `docs/ux-research/2026-11-07/web-ux-research.md`.

## 1. Audit of the previous UI (why it read as slop)

Rendered with Playwright at 1280px / 390px / popup 392px (`.design-work/before/`,
gitignored). Findings, most severe first:

1. **Wrong font everywhere (bug).** Chrome injects an *unlayered* stylesheet
   into extension pages (`body { font-family: <system>; font-size: 75% }`).
   Tailwind v4 puts our `html, body` rule in `@layer base`, and **unlayered
   CSS beats any layer**, so popup/options rendered in DejaVu/system sans at
   12px and Geist never loaded (`document.fonts` → `unloaded`). Fix: body
   typography is declared **unlayered** in `src/styles/globals.css`.
2. **Cards inside cards.** Every section was a shadowed, blurred card holding
   more bordered cards. Nine sections at identical weight → no focal point.
3. **Jargon as decoration.** "BGE-Small Local Centroid Engine", "SYSTEM 1.5",
   "Inference & Telemetry Stream", "q8 / WASM", "Local ONNX verdict" — mono
   uppercase labels used for texture, not meaning.
4. **Amber everywhere.** Icons, toggles, badges, slider, status pill all
   amber → the accent signified nothing.
5. **Decorative badges** ("Active Goal", "Subdomain-aware", "Always Blocked").
6. **Block screen promoted the bypass.** The ivory primary button was
   "This is actually productive — let me through"; "Stay focused" was
   secondary. The product's goal action must be the primary one.
7. **Diagnostics first in the popup.** Test Pair / Latency Log took the
   primary-button slot over the things a user actually opens the popup for.
8. Title-cased category names ("Memes And Entertainment"), native white
   checkboxes, red used for *commitment* (felt punitive).

---

## 2. Intent

- **Who:** a student or knowledge worker, mid-task, who just tried to open
  something distracting — or who opens settings rarely (first run, then a
  tweak a week later). They are *not* debugging a model.
- **What they must do:** popup → see whether protection is on and *commit*
  (focus goal, focus session). Options → decide what gets blocked and how
  hard it is to undo. Block screen → choose to go back to work.
- **Feel:** a desk lamp at night in a quiet reading room. Warm, low,
  focused; nothing shouts. Commitment feels like signing your name, not like
  being punished.

**Domain:** attention, detour, threshold, verdict, commitment, seal, lamp,
reading room, focus hours. **Color world:** walnut desk in shadow
(obsidian), lamplight (amber), paper (ivory), graphite (muted text), brass
(warning), library-green banker's lamp (success), the red "do not disturb"
bulb (destructive).

**Signatures (only this product has them):**
1. **The Threshold Meter** — a 2px track showing a classifier score with an
   amber tick at the user's threshold. Appears on the options Sensitivity
   control (where the tick is *set*) and on the block screen (where the page
   *landed* relative to it). Explains a block in one glance; no jargon.
2. **Lamplight = commitment.** Amber appears **only** for focus and
   commitment (locks, focus sessions, focus goal, schedules in effect). Locked
   state = amber seal line + tabular countdown — never red.

**Defaults rejected:** card-per-section with icon+title → one surface of
grouped rows, one page at a time behind a sidebar · mono uppercase labels → plain
language, mono only for numbers/domains/code · accent on every control →
neutral controls, amber reserved · bypass as primary → "Stay focused" primary.

---

## 3. Tokens (`src/styles/tokens.css`)

Single source of truth for the extension **and** `site/`. OKLCH, one warm hue
family (H ≈ 72–87°); elevation steps only in lightness.

### Surfaces (darkest → lightest)
| Token | Hex | Use |
| :-- | :-- | :-- |
| `--background` | `#0e0c09` | Page canvas. Also **inputs** on cards (inset = darker). |
| `--card` | `#17130e` | Settings groups, popup panels. |
| `--muted` / `--popover` | `#1d1812` | Row hover, code wells, segmented control track. |
| `--secondary` | `#241d14` | Secondary buttons, switch track (off). |
| `--border` / `--input` | `#2e2718` | Hairlines and input strokes. |

### Text (four tiers)
| Token | Hex | Use |
| :-- | :-- | :-- |
| `--foreground` | `#f4efe4` | Primary: labels, values, headings. |
| `--muted-foreground` | `#a29a89` | Secondary: descriptions. |
| `--faint` | `#7d7768` | Tertiary: meta, timestamps, helper text. |
| `opacity-45` on control | — | Disabled. |

### Action & meaning
| Token | Hex | Meaning — and only this |
| :-- | :-- | :-- |
| `--primary` / `-foreground` | `#efe8d8` / `#1c1405` | The one primary action per view. Switch "on". |
| `--accent` / `-soft` / `-foreground` | `#e8a33d` / `#f2cd8b` / `#1c1405` | **Commitment & focus only** (lock, focus session, focus goal, schedule active, meter tick). Also focus ring. |
| `--success` / `-soft` | `#5cb98a` / `#93d5b5` | Saved, connected, protection on (status dot). |
| `--warning` / `-soft` | `#e8c356` / `#f0d489` | Something weakens protection (incognito access off). |
| `--destructive` / `-soft` | `#e0655a` / `#f2a192` | Data deletion, blocked-content verdict, errors. |

Tint recipe for callouts: `bg-<hue>/10 border-<hue>/30 text-<hue>-soft`.

### Shape, type, space
- **Radius:** `6px` small controls/chips · `8px` buttons & inputs · `12px`
  groups/panels · `9999px` switches, status dots. Nested: outer = inner + padding.
- **Depth: borders-only + surface shifts.** No drop shadows, no
  backdrop-blur, no glows, no gradients on product surfaces. (Block screen
  may use one very faint radial lamp glow, ≤ 8% alpha.)
- **Type:** Geist (UI) + Geist Mono (numbers, domains, code), self-hosted.
  Scale (1.25 from 14): `11 meta · 12 caption · 13 small · 14 body ·
  16 section title · 20 page title · 34 block headline`. Hierarchy via
  **weight + color first**: label 500/foreground, description 400/muted,
  meta 400/faint. Headings ≥ 20px get `tracking-tight`. All dynamic numbers
  `tabular-nums`. Sentence case everywhere (incl. category names).
- **Spacing (4px base):** row padding `14px 16px` · group gap `12px` ·
  section gap `48px` (options) · popup gutter `16px`, block gap `16px`.
- **Motion:** popup and options are opened many times a day → **no entrance
  animations**. Interaction feedback only: color transitions 150ms,
  `active:scale-[0.98]` on buttons, ease-out. Respect reduced-motion.

---

## 4. Components (`src/components/ui/`)

| Component | Spec |
| :-- | :-- |
| `Button` | h-9 (sm h-8), 8px radius, 13–14px/500. Variants: `default` (ivory, the one primary), `secondary`, `outline`, `ghost`, `commit` (amber — only to *start/confirm a commitment*), `destructive` (tinted). No shadows. |
| `Switch` | Real `<input type=checkbox>` (tests read `.checked`). On = ivory track + dark thumb; off = `secondary`. 36×20. |
| `Checkbox` | Real input, `appearance-none`, 16px, 4px radius; checked = ivory fill + dark check. |
| `Input` / `Textarea` / `Select` | `bg-background` (inset), `border-input`, 8px radius, amber focus ring. Mono for domain lists. |
| `Badge` | Status only, never decoration. `dot` prop for live status. |
| `SettingsSection` | `<section id>` + h2 (16/600) + one-line description (13/muted). |
| `SettingsGroup` | `bg-card border rounded-xl divide-y` — the ONLY container on the options page. |
| `SettingRow` | Label (14/500) + description (13/muted) left, control right (stacks under 520px). `stacked` variant for full-width content (textareas, lists). |
| Threshold Meter | Signature. Editable: `.sb-range` in `globals.css` (2px track, ivory fill via `--fill`, ivory thumb, amber focus). Read-only: inline in `blockscreen.ts` / `blockscreen-ui.ts` — 2px track, ivory fill = score, 2×12px amber tick = threshold (tick only when the threshold is known; the `blocked.html` redirect URL doesn't carry it). |

---

## 5. Surface specs

### Options (`src/options/`) — sidebar, one page at a time (UX overhaul 2026-11-07)
- **Shell** `OptionsApp.tsx`: slim sticky header (wordmark · status pill
  "Blocking on" / "Paused" / amber "Locked · 3h 12m" · `#save-msg` "Saved" ·
  `#model-progress` only while downloading) → `#lock-status` amber seal line
  when locked → `#banner` "Finish setting up SmartBlocker" + "Start setup"
  link when `!onboarded`. State lives in `useOptionsState.ts`; formatting in
  `format.ts`; one file per page in `pages/`.
- **Navigation:** 180px sticky sidebar of real links (`href="#sites"`,
  `aria-current="page"`); below `md` it becomes a horizontally scrollable pill
  row. Now `#dashboard` is first; the wordmark links to it. Hash routing;
  unknown hash → Blocking; legacy hashes (`#categories`, `#history`,
  `#commitment`, `#schedules`) redirect. Focus moves to the page heading on
  navigation.
- **Pages:** Now `#dashboard` (read-only answer to "is it blocking, what happens
  next, what relief is real?": blocking on/paused/forced; every active lock
  reason with its own countdown and aggregate end; active global/category
  windows; break, focus goal, pending focus undo, companion health; next
  global/category transition and armed auto-resume in local time; break mode,
  authority-labelled allowance/opening grants, and the classifier-only relief
  statement; 24-hour focus-hours and category-window lanes with current-time
  marker and textual equivalents) · Blocking `#blocking` (master switch with
  opt-in "Typed confirmation for overrides" and "Turn blocking back on" right
  under it — Never / when the
  browser restarts / when focus hours begin / at a set time — "Hide distractions
  in search results",
  strictness presets
  Relaxed 0.65 / Balanced 0.5 / Strict 0.4 — other values read "Custom",
  categories + "Also block adults-only sites instantly" (RTA label / .xxx)
  directly under the category list, "Find your distractions" history
  review) · Profiles `#profiles` (Default first, then named snapshots with
  Activate / Duplicate / Rename / two-step Delete; create copies the active
  settings without switching; the active association's desktop apps and
  connection status; every action disables with the lock reason) · Backup
  `#backup` (download a versioned configuration JSON; choose a file, pick
  merge or replace with an explicit confirmation, review counts/names/warnings,
  apply, and restore the automatic pre-restore snapshot; restore refuses while
  locked) · Sites
  `#sites` (`ListEditor` Always allow / Always block; a
  collapsed **More rules** disclosure holds Title patterns (`*` wildcard)
  and YouTube channels — always block / never block for their topic) · Focus `#focus` (goal, open-tab
  context, start a focus session) · Locks `#locks` (timer, password, optional delay/random-text break
  gates, incognito warning; break settings disable while locked) · Focus hours `#schedule` (summary cards, S–M–T–W–T–F–S
  day chips in the preferred order, optional per-rule settings-lock lead with
  a badge + "settings lock at … / blocking still starts at …" explanation,
  overnight note, Duplicate per rule, a quiet overlap notice that says
  overlapping is allowed and blocking is the union, presets "Weekdays 9–5" /
  "Every evening 7–10 PM")
  · Notifications `#notifications` (three independent, silent, off-by-default
  reminders — focus hours starting soon, break ending soon, allowance nearly
  used up — each with a 1–60 minute lead; controls disable while locked)
  · Preferences `#preferences` (first day of week, 24-hour time, live preview;
  display-only) · Usage `#usage` (7/35-day protection overview: silenced pages
  by reason, protection coverage, lock and classifier-break time, override
  rate; stacked daily-block chart; local-day site/category Top-N tables with
  an explicit “other” toggle, JSON export, two-step clear) · Desktop app `#companion`
  · Privacy & data `#privacy` (danger zone last) · Advanced `#advanced` (exact sensitivity slider; Diagnostics: Test
  classifier, Scan history, Latency log, `#out`).
- **Welcome wizard** `#welcome` (`welcome/`): full page, no sidebar, ≤560px
  column, "Step N of 3" bar. 1 "What pulls you off track?" (category rows
  with examples, "Block all of these", live "N selected") → 2 "What should
  always stay open?" (focus goal + Always-allow `ListEditor`) → 3 "Verify your
  protection" (fresh all-site-access + gaming/block + programming/allow checks
  in `#welcome-verification`, then summary with Change links, how it works,
  incognito check, and pin hint). Only `ready` enables "Start blocking";
  `checking`, `degraded`, and `error` expose actionable check details and retry
  or settings recovery. The background repeats verification before persisting
  `enabled + onboarded`; Back, Change, and unverified exit disable while that
  commit is pending. "Continue without verification" and "Set up later" leave
  `onboarded` false so the banner stays. Earlier steps persist on Continue.
  First install opens `options.html#welcome`; plain `options.html` never forces
  the wizard.
- **Saving:** everything autosaves (switches, presets, categories, list rows
  via `ListEditor.onChange`) and confirms in `#save-msg`. The only explicit
  saves are multi-field forms: "Edit as text" (Save list / Cancel) and
  "Save focus hours". There is no global Save button.
- **Locked:** editing controls disabled with the reason "Locked until
  3:40 PM"; the timer and password controls stay usable (extend / unlock).

### Popup (`src/popup/`, 380px) — "This page" first
Data is loaded BEFORE first render (`popup.ts`, 250ms cap) and every
unlocked state is the same height (516px), so nothing jumps. Order:
1. Header: wordmark · `#popup-enabled-toggle` ("Blocking on") ·
   `#open-options` gear.
2. `#lock-line` amber when locked: "Locked: focus session — 3h 12m left
   (until 4:28 PM)".
3. **This page** card (focal; `ThisPageCard.tsx`, logic in
   `popup-model.ts`): host in mono + a status dot + one sentence, e.g.
   "Allowed — looks like programming…", "Blocked — likely video games",
   "Blocked by your rule “/cart”", "Matches your channel rule @…",
   "Always allowed — it's on your allowed sites", "Blocking is paused" +
   "Turn blocking on", "SmartBlocker doesn't check this kind of page",
   "Not checked yet". Scores become words: ≥0.85 "very likely", ≥0.65
   "likely", else "possibly" — never a raw %. Actions: "Should've been
   blocked" (reveals category + Report), "Always allow this site" /
   "Remove from allowed". Source: the background's per-tab record
   (`src/shared/tab-status.ts`, `storage.session`) plus local derivation
   (allowed list, paused, unsupported URL).
4. **What are you working on?** focus goal + open-tab context.
5. **Focus session** (`FocusSession.tsx`): 1h / 4h / 8h radio chips +
   amber "Start focus session" with the consequence inline ("Blocks
   distractions until 2:16 PM. You can undo for 1 minute, then it can't be
   cancelled."). Pending → "Locks in 0:42" + Undo; active → "Running until
   4:28 PM".
6. **Take a break** (`BreakControl.tsx`, only while locked with a configured
   break gate, or while a break survives its lock): delay start or fresh random
   text first, then a live pending/active countdown and "End break". Copy
   states that only classifier blocks relax; the lock and deterministic rules
   stay on. Proofs are generated and verified in the service worker.
No diagnostics, model names or telemetry in the popup (they live on options
→ Advanced).

**Conditional extension-loss warning:** while a lock is active, a previously
observed watchdog companion that disconnects adds `#extension-grace` directly
under the lock line. Use the warning tint, one plain sentence, and tabular
numbers. The numeric sentence is allowed only from an enforcing-peer grace
observation. Protocol v2 carries no such observation, so the current fallback
explicitly says the remaining time is unavailable instead of guessing from
heartbeat sends. Missing/never-observed companions and unlocked sessions stay
quiet. The options Desktop app status section uses the same conditional notice
as `#companion-grace`.

### Focus session undo window (`src/shared/focus-session.ts`)
User-facing name for Frozen Turkey (`lockState.frozenUntil`). The 60-second
undo is a **deferred commit**, not a cancellable lock: Start stores
`pendingFocusSession { until, commitAt }` + a one-shot alarm; the background
commits via `startFrozenTurkey(until - now)` when the window closes (also on
SW start and popup open — idempotent). Undo deletes the pending record. The
lock store and the companion merge stay strictly monotonic and never see an
uncommitted session. Normal blocking is already on during the window; only
the lock is deferred — copy says "Locks in 0:42", never "Starts in".

### Block screen (`blockscreen.ts` injected + `blockscreen-ui.ts` → `blocked.html`)
Full-bleed obsidian, **no card**, centered column ≤ 520px:
wordmark (faint) → eyebrow `Blocked · <category>` → headline **"This one can
wait."** (34/600) → quoted page title (muted) → optional user note
(`#smartblocker-block-message`, plain text, ≤160 chars, configured on
Blocking) → **Threshold Meter**
("87% confidence", tick at threshold) → buttons: **Stay focused (close tab)**
primary ivory, *This is actually productive — let me through* outline,
Dismiss text → meta "Checked on-device in 12ms" (faint).
Locked: amber seal note "Smart Blocker is locked — bypass is disabled" +
Stay focused only. Fail-closed: amber warning variant, no score, no meter.
With opt-in `surrenderMode: 'phrase'` (default `'off'`), the unlocked override
opens an inline typed-confirmation wall: Stay focused remains available, a
15-second countdown disables the textarea and release button, then the fixed
neutral sentence must match exactly apart from surrounding whitespace. A wrong
attempt clears the text and restarts the full delay; Cancel sends no override.
The wall never renders while locked and is deliberately UX friction, not an
authentication boundary. Its phrase/time math is mirrored by the pure,
Node-tested `src/shared/surrender.ts`; the injected function cannot import it.
Inline styles must use the hexes in §3 (host pages have no extension CSS);
`blockscreen.ts` stays import-free.

---

## 6. Rules

**Do**
- Semantic tokens only (`bg-card`, `text-muted-foreground`, `text-faint`,
  `border-border`, `bg-accent/10`…). Change color in `tokens.css`, nowhere else.
- One primary (ivory) button per view. Amber only for commitment/focus.
- Plain-language copy, sentence case, verb + object buttons ("Arm password
  lock", "Add schedule").
- Compose `SettingsSection` → `SettingsGroup` → `SettingRow`; don't hand-roll rows.

**Don't**
- No raw palette classes or hexes in `.tsx`:
  `grep -rnE "zinc-[0-9]|emerald-[0-9]|amber-[0-9]|red-[0-9]|#[0-9a-fA-F]{6}" src/ site/ --include="*.tsx"` must be empty.
- No cards inside cards, no shadows/blur/glow on product surfaces, no
  decorative badges, no mono-uppercase "telemetry" labels, no emoji.
- No entrance animations in popup/options; no GSAP outside `site/`.
- No marketing sections in `src/options/` (they live in `site/`).

**Where a new setting goes (options):** put it in the group of the thing it
modifies (a pause-related option sits under the master switch; a
category-related option under the category list) — never a new top-level
section by default. Rare power-user rules go inside the Sites page's
**More rules** disclosure (auto-open when non-empty). Name settings by the
outcome the user gets ("Hide distractions in search results"), not the
mechanism ("search element masking", "RTA meta tag", "classifier").

**Naming:** users see **"Focus session"**; "Frozen Turkey" survives only in
code identifiers (`startFrozenTurkey`, `frozenUntil`) and internal docs.

---

## 7. Extension contract (tests depend on these — never rename)

### Popup
`#lock-line` (hidden unless locked; text starts "Locked:"),
`#extension-grace` (locked + observed companion loss only; numeric only with an
authoritative grace observation), `#popup-enabled-toggle`, `#open-options`,
`#focus-goal`, `#save-focus-goal`, `#use-tab-context`,
`.frozen-btn[data-mins=60|240|480]` (radio chips), `#start-focus-session`,
`#undo-focus-session`, `#always-allow-site`, `#remove-allowed-site`,
`#should-have-blocked` → `#report-category` + `#report-fn`, `#page-host`,
`#page-verdict`, `#turn-on-blocking`, `#break-heading`, `#break-start`,
`#break-countdown`, `#break-challenge`, `#break-proof`, `#break-verify`,
`#break-cancel`, `#status`.
**No diagnostics ids.**

### Options (navigate to `options.html#<page>` — only the active page renders)
Global: `#banner`, `#lock-status` (visible only when locked, contains
"Locked"), `#active-profile-banner` (visible only while a NAMED profile is
active; contains its name), `#save-msg`, `#model-progress`. `#save-btn` no
longer exists.
- `#dashboard`: `#dashboard-now`, `#dashboard-blocking`,
  `#dashboard-blocking-detail`, `#dashboard-lock`, `#dashboard-lock-summary`,
  `#dashboard-lock-reasons` (`li` per active reason), `#dashboard-companion`,
  `#dashboard-next`, `#dashboard-next-global`, `#dashboard-next-category`,
  `#dashboard-next-resume`, `#dashboard-next-focus`, `#dashboard-relief`,
  `#dashboard-relief-break`, `#dashboard-relief-allowance`,
  `#dashboard-relief-statement`, `#dashboard-timeline`,
  `#dashboard-timeline-now`, `#dashboard-timeline-global` /
  `#dashboard-timeline-category` (each with a `-marker` child),
  `#dashboard-timeline-text` (`li` per occurrence). Read-only; no controls.
- `#blocking`: `#enabled-toggle`, `#surrender-mode-toggle`, `#resume-mode`,
  `#resume-at`, `#mask-search-elements-toggle`, `#block-adult-toggle`, `#label-list` (`li`,
  `.delete-label-btn`),
  `#custom-category-input`, `#add-category-btn`, `#scan-btn`,
  `#block-top-btn`, `#scan-status`, `#scan-out`.
- `#profiles`: `#profiles-list`, `#profile-default` (`.profile-row`,
  `data-active`), named rows `.profile-row[data-profile-id]`,
  `.profile-activate`, `.profile-duplicate`, `.profile-rename`,
  `.profile-delete` (second click confirms), `#profile-name`,
  `#profile-create`, `#profile-msg`, `#profiles-lock-note`,
  `#profile-rename-input`, `#profile-apps-status`, `#profile-apps-list`.
- `#backup`: `#backup-export`, `#backup-pick`, `#backup-import` (file input),
  `#backup-file`, `#backup-mode-merge`, `#backup-mode-replace`,
  `#backup-errors`, `#backup-preview`, `#backup-preview-summary`,
  `#backup-preview-changes` (`li[data-kind][data-action]`),
  `#backup-preview-warnings`, `#backup-confirm-replace`,
  `#backup-confirm-replace-note`, `#backup-apply`, `#backup-msg`,
  `#backup-lock-note`, `#backup-pre-restore`, `#backup-pre-restore-info`,
  `#backup-pre-restore-download`, `#backup-pre-restore-apply`,
  `#backup-pre-restore-msg`.
- `#sites`: `#whitelist`, `#blocklist`, and inside the `#more-rules`
  `<details>` (auto-open when it holds rules): `#title-rules`,
  `#channel-blocklist`, `#channel-allowlist` (`ListEditor` roots; `-input`,
  `.list-row`, `.list-remove`, `-text`).
- `#focus`: `#focus-goal`, `#use-tab-context`, `#focus-session-start`,
  `#focus-session-undo`.
- `#locks`: `#lock-duration`, `#lock-unit`, `#lock-timer-btn`,
  `#lock-delay-duration`, `#lock-delay-unit`, `#lock-delay-arm-btn`,
  `#lock-delay-start-btn`, `#lock-delay-cancel-btn`, `#lock-delay-msg`,
  `#lock-password`, `#lock-password-btn`, `#lock-password-msg` ("Wrong
  password", "at least 8"), `#lock-random-length`, `#lock-random-arm-btn`,
  `#lock-random-challenge-btn`, `#lock-random-challenge`, `#lock-random-proof`,
  `#lock-random-verify-btn`, `#lock-random-msg`, `#break-mode`,
  `#break-delay-minutes`, `#break-duration-minutes`, `#break-text-length`,
  `#incognito-warning`.
- `#schedule`: `#schedule-list` (`.schedule-row`, `.day-label`,
  `.schedule-remove`, `.schedule-duplicate` with
  `#schedule-duplicate-<rule id>`), `#schedule-add`, `#schedule-save`,
  `#schedule-msg`, `#schedule-overlap-warning` (present only while at least
  two global windows overlap; `role="status"`, `aria-live="polite"`, carries
  `data-overlap-count`). `#category-schedule-list` (`.category-schedule-row`,
  `.category-schedule-remove`, `.category-schedule-duplicate` with
  `#category-schedule-duplicate-<rule id>`), `#category-schedule-add`,
  `#category-schedule-save`, `#category-schedule-msg`,
  `#category-schedule-overlap-warning` (same visibility and accessibility
  contract for category rules).
- `#notifications`: `#notify-schedule-toggle`, `#notify-schedule-lead`,
  `#notify-break-toggle`, `#notify-break-lead`, `#notify-allowance-toggle`,
  `#notify-allowance-threshold` (minute inputs are `1–60`; switches and
  inputs disable while locked). Alarm names: `sb-notify:schedule-start`,
  `sb-notify:break-end`, `sb-notify:allowance-low`; OS notification ids:
  `smartblocker-notify-schedule-start`, `…-break-end`, `…-allowance-low`
  (no sound; `silent: true`).
- `#usage`: `#usage-pages-silenced`, `#usage-override-rate` (dash for an empty
  denominator), `#usage-active-time`, `#usage-protection-coverage`,
  `#usage-protected-time`, `#usage-unprotected-time`, `#usage-locked-time`,
  `#usage-break-time`, `#usage-range-7`, `#usage-range-35`,
  `#usage-tab-blocks`, `#usage-tab-websites`, `#usage-chart` (one
  `[data-day]` bar per selected day), `#usage-day-today`,
  `#usage-day-yesterday`, `#usage-day`, `#usage-show-other`, `#usage-sites`,
  `#usage-categories`, `#usage-sites-toggle`, `#usage-categories-toggle`,
  `#usage-export`, `#usage-clear` (second click confirms), `#usage-status`.
- `#companion`: `#companion-status` ("Get SmartBlocker Companion — coming
  with the Pro release" / "Connected — hardcore mode active…"),
  `#companion-enforcement`, `#companion-grace` (same visibility and truthfulness
  rules as popup `#extension-grace`).
- `#privacy`: `#feedback-count`, `#feedback-export`, `#feedback-clear`,
  `#share-toggle`, `#oembed-toggle`, "Your shared feedback data", button
  "Delete shared data", "none yet — created the first time you share a
  correction", "Feedback sharing is not configured in this build".
- `#advanced`: `#threshold` (0.3–0.9 step 0.05), `#threshold-val`,
  `#test-pair`, `#scan-history`, `#latency-log`, `#status`, `#out` (`->`
  result format, `Scan done` text).
- `#welcome`: `#welcome-wizard`, `#welcome-whitelist`, `#welcome-verification`
  (`data-state="checking|ready|degraded|error"`), `#protection-check-*` (one of
  `site-access`, `distraction`, `productive`, with `data-status`),
  `#welcome-retry-verification`, `#welcome-continue-unverified`, and the footer
  `#welcome-start` / `#welcome-continue` / `#welcome-back`.

### Block screens
- `blockscreen.ts`: self-contained functions, zero imports/module closures.
- Root ids `#smartblocker-overlay` (injected, shadow root) /
  `#smartblocker-blocked` (blocked.html).
- Unlocked buttons contain "actually productive", "Stay focused", "Dismiss";
  locked: only "Stay focused" + note "Smart Blocker is locked — bypass is disabled".
- Normal variant shows "% confidence"; fail-closed shows **no** "% confidence".
- Optional typed-confirmation wall: `#smartblocker-surrender-wall`,
  `#smartblocker-surrender-phrase`, `#smartblocker-surrender-countdown`,
  `#smartblocker-surrender-input` (textarea), `#smartblocker-surrender-status`,
  `#smartblocker-surrender-submit`, `#smartblocker-surrender-cancel`.
- `blocked.html`: `document.title === 'Blocked — Smart Blocker'`, **zero `<h1>`**.

---

## 8. Checks before shipping UI

1. `npm run typecheck && npm run build`, then screenshot popup / options
   (1280 + 390) / block screens (`node .design-work/shoot.mjs <dir>` — local
   helper, or the e2e suites) and **look at them**.
2. **Swap test:** would swapping in Inter + a stock card template change
   nothing? Then it's default — fix.
3. **Squint test:** one focal element per view; nothing harsh.
4. **Signature test:** meter + amber-means-commitment visible on every surface.
5. **Token test:** the hex grep in §6 is empty.
6. Contract IDs in §7 present; run `node scripts/e2e-test.mjs` and the
   p1/p2 suites that touch the surface you changed.

---

## 9. Landing site (`site/`)

Separate editorial surface (gpt-taste spec): shares `tokens.css`, may use
GSAP ScrollTrigger, large type, the showcase SVGs, and marketing copy. None
of that crosses back into the extension.
