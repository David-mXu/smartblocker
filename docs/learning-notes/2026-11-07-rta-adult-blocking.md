# Opt-in Adult-Site Blocking (RTA Meta Tag + `.xxx` TLD)

**Date:** 2026-11-07
**Project:** SmartBlocker (`src/shared/rules.ts`, `src/shared/settings.ts`, `src/content/extract-meta.ts`, `src/background/blocker.ts`, `scripts/lib/eval-harness.mjs`, `src/options/pages/BlockingPage.tsx`, `scripts/rta-test.mjs`, `PRIVACY.md`)

---

## 1. Original Goal

Roadmap Phase 5 batch 1: an **opt-in, off-by-default** `blockAdult` setting that blocks adult sites deterministically, modeled on the Cold Turkey Edge extension's `checkBlockAdult` flow (evidence: `docs/audits/2026-11-07-cold-turkey-blocker-landscape-audit.md` §1.1 — CT triggers when the page carries `<meta name="rating" content="RTA-5042-1996-1400-1577-RTA" or "adult">`; adult blocking there is *meta-tag driven, not a porn list*).

Two signals, either one sufficient when the switch is on:

1. The page **self-declares** an adult rating via `<meta name="rating">` (the string `adult` or the RTA — *Restricted to Adults* — self-labeling tag).
2. The host is inside the **`.xxx` TLD** (the adult-sponsored top-level domain).

Hard constraint: with the switch **off** (the default, and every stored install until the user flips it), classifier input and every block decision must be **byte-identical** — zero eval-baseline shift.

## 2. Root Concepts

- **The block-decision ladder.** `src/background/blocker.ts` `onTitle` decides in order: whitelist → deterministic URL blocklist → ML classifier. The eval harness (`scripts/lib/eval-harness.mjs` `decideBlock`) mirrors the same ladder offline. New checks had to slot *between* whitelist and classifier so whitelisted hosts still win (a user may deliberately whitelist a `.xxx` domain).
- **`extractMeta` is serialized.** The DOM probe runs inside the page via `scripting.executeScript({ func: extractMeta })`, whose function body is stringified at runtime — so it can contain **no imports**. That is why the meta-tag check is duplicated inline there, while the host check (no DOM needed) lives in a new pure shared module (`src/shared/rules.ts`), erasable-syntax-only so Node's type stripping can unit-test it directly (same trick as `lock-math.ts`).
- **Additive settings need no migration.** `getSettings()` spreads `DEFAULTS` under the stored blob, so existing installs automatically read `blockAdult: false`.
- **Settings sweeps are allow-listed.** `SETTINGS_SWEEP_KEYS` in `blocker.ts` names the settings whose change re-evaluates open tabs. A new blocking-relevant key must be added or toggling it would not affect already-open tabs.

## 3. Implementation Steps (in order)

1. Read CLAUDE.md, `extract-meta.ts`, `settings.ts`, `config.ts`, `blocker.ts`, `eval-harness.mjs`, `url-signals.ts`, options UI files, `docs/design-notes.md`, plus the CT audit §1.1 and `lock-math-test.mjs` for house test style.
2. **`src/shared/rules.ts` (new):** `isAdultHost(hostname)` — lowercase/trim/strip root dot, then `host === 'xxx' || host.endsWith('.xxx')`. The anchor on `.xxx` (dot included) is what makes `xxx.com` and `fooxxx.net` correctly *not* match: the TLD **position** is tested, not the substring.
3. **`extract-meta.ts`:** added `probeAdultMeta()` — `document.querySelector('meta[name="rating" i]')` (the `i` flag makes the attribute *value* "rating" case-insensitive), content trimmed + lowercased, accepted iff `=== 'adult'` or `=== 'rta-5042-1996-1400-1577-rta'`. Computed once near the top and attached as `adultContent: true` (only when detected) to all five return branches (YouTube browsing, YouTube video, Reddit, SERP, generic). Field absent when not detected, and never feeds `channel`/`context`/`fallbackTitle`, so classifier input is untouched.
4. **`settings.ts`:** `blockAdult: boolean` added to `Settings` with doc comment; `DEFAULTS.blockAdult = false`.
5. **`blocker.ts`:**
   - `gatherMeta` type widened with `adultContent?: boolean`.
   - After the whitelist early-return: `const adultHost = settings.blockAdult && isAdultHost(hostnameOf(url));`
   - First deterministic branch is now `if (blocklistHit || adultHost)` with label `blocklistHit ? 'blocked rule: "…"' : 'adult'` (user-authored rule names intent on a double match).
   - Post-`gatherMeta` branch computes `adultMeta = settings.blockAdult && meta.adultContent === true` and joins the second blocklist check the same way.
   - YouTube-browsing-surface bypass guarded by `!adultHost` too (unreachable in practice — `youtube.com` is not `.xxx` — but documents precedence).
   - Added `'blockAdult'` to `SETTINGS_SWEEP_KEYS` (caught on review: without it the toggle would not re-sweep open tabs).
6. **`eval-harness.mjs` (no-op wiring):** eval cases' `captured` field *is* the raw `extractMeta` result (`c.captured = { title, ...meta }` in `eval.mjs` --capture), so inputs already carry the extracted-meta shape. Threaded `adultContent` through `signalsFor` (captured branch only; authored object inputs spread it automatically), added `blockAdult: false` to `EVAL_SETTINGS`, and added the two gates in `decideBlock` after whitelist / around the blocklist check with the same reason label `'adult'` and blocklist-reason precedence. With the default settings every gate short-circuits false → zero baseline diff.
7. **UI (`BlockingPage.tsx`):** a `SettingRow` with `Switch id="block-adult-toggle"`, label "Adult sites", helper "Block sites that self-declare as adult (RTA meta tag) and all .xxx domains.", placed directly under the master "Block distracting pages" row in the Protection group. Disabled + `LockedNote` while locked, like its neighbors. Saves through `useOptionsState.save`, which is the page's established try/catch wrapper around `setSettings`' lock throw (optimistic update, rollback + error flash on refusal). No existing DOM ids touched; the new id was registered in `docs/design-notes.md` §7, the contract the e2e suites read.
8. **`PRIVACY.md`:** one short section — detection is a local meta-tag/TLD check, entirely on-device, no list download, nothing sent (fits the local-first posture; adds zero entries to the "Network requests" list).
9. **`scripts/rta-test.mjs` (new):** 17 tests — `isAdultHost` positives (`example.xxx`, `a.b.xxx`, bare `xxx`, `xxx.xxx`, case-insensitivity, FQDN dot, whitespace) and negatives (`xxx.com`, `fooxxx.net`, `notxxx.co`, `sub.xxx.com`, `.xx`, empty, localhost/IP) — plus source-level tripwires pinning the probe's selector flag and both accepted strings in `extract-meta.ts` (the probe itself needs a DOM, so it is covered by inspection, with the exact accepted meta strings documented in the file header).
10. **Docs truthfulness:** CLAUDE.md (new command bullet, `rules.ts` in the shared/ inventory, ladder sentence in `blocker.ts` architecture, extract-meta description).

## 4. Alternatives & Tradeoffs

- **`isAdultMeta` helper in `rules.ts`:** sketched in the task as "if useful" — deliberately omitted. `extractMeta` cannot import it (serialization), and the harness reads only the boolean field, so it would have been a dead third copy.
- **Sub-frame (`onSubFrame`) adult checks:** not wired. The feature is specified at page level; embedded `.xxx` iframes inside allowed pages remain governed by the existing embed rules. Listed as an open question for batch 2.
- **Tab-status kind for adult blocks:** reuses `kind: 'blocked'` with label `'adult'` (popup renders "Blocked — Likely adult.") rather than a new `blocked-adult` kind — minimal, and the popup needed no change.
- **Probe cost when the switch is off:** one cheap `querySelector` per `extractMeta` invocation, no side effects; since `extractMeta` cannot read settings, the probe always runs and the flag is simply ignored downstream. Chosen over threading settings into the injected function args (which would have changed its signature for every caller).

## 5. Verification

- `node scripts/rta-test.mjs` — **17 passed, 0 failed.**
- `npm run typecheck` — clean (`tsc --noEmit`, no output).
- `npm run build` — both targets built; RTA string confirmed present in `dist/chrome/background.js` and `dist/firefox/background.js`, toggle id in the options bundle.
- Harness no-op proof (synthetic cases, throwaway script): with `blockAdult:false` a `.xxx` URL and a captured `adultContent:true` fall through to `classifier`; with `blockAdult:true` both block with reason `adult`; whitelisted `.xxx` still allows (`whitelist`); a matching blocklist rule wins the reason label (`blocklist:…`). 8/8 pass.
- `npm run eval` — exit 0, **zero change vs baseline** (see gate output reported to the orchestrator; no dataset or baseline files edited).
- Not run (out of scope per task): Playwright e2e suites, companion gates.
