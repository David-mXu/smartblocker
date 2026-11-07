# Simplification and Professional Copy Revision for Options Page

**Date:** 2026-11-07 · **Scope:** [src/options/OptionsApp.tsx](../../src/options/OptionsApp.tsx), dist builds (`dist/chrome`, `dist/firefox`)

## 1. The Problem

The extension options page had accumulated excessive technical jargon, AI internal terminology, and pseudo-academic phrasing in user-facing card descriptions, labels, and badges. Specifically, phrases such as:
- *"Calibrate the softmax decision boundary and supply your current task intention so ambiguous lectures or technical threads are judged against your active work."*
- *"Toggle distraction prototypes or inject custom semantic categories into the vector space."*
- *"— embedding similarity improves with specific phrasing."*
- *"Short-circuit the neural classifier with explicit domain exemptions or zero-latency substring blocks."*
- Technical descriptors such as *"Block Confidence Threshold"*, *"System 1.5"*, *"2:1 Goal Weighting"*, *"PBKDF2 Password Lock"*, *"Monotonic Timer Lock"*, *"Monotonic State Guarantee"*, and *"100% On-Device Inference · Privacy-First Architecture"*.

These phrases exposed internal model mechanics (softmax, vector embeddings, prototype centroids, inference latency, PBKDF2 hashing) to general users instead of communicating clearly and professionally what each setting does.

## 2. Root Cause and Concepts

- **Root Cause:** Early prototypes in this codebase blended developer architecture notes, mathematical explanations, and user-facing UI copy in the same components. Over time, internal machine learning concepts were presented directly to end users.
- **Key Concepts:**
  - *Softmax Decision Boundary / Confidence Threshold:* In classification models, softmax converts logits into a probability distribution. The decision boundary determines the score cutoff for blocking a page. To an end user, this is simply **Blocking Sensitivity** (how strictly pages are evaluated).
  - *Vector Space & Prototype Centroids:* Embedding models map text into high-dimensional vectors, and categories are represented by cluster center vectors (centroids). To an end user, these are simply **Distraction Categories** and **Learned Preferences**.
  - *Deterministic Blocklist / Substring Matching:* String matching against URLs/titles before invoking the embedding model. To an end user, this is a **Keyword & Site Blocklist** that blocks matches immediately.

## 3. Investigation and Implementation Steps

1. **Copy Audit & Grep Inventory:**
   - Scanned `src/options/OptionsApp.tsx` and all script files for target phrases and DOM selectors.
   - Verified that automated test suites (`scripts/e2e-test.mjs`, `scripts/e2e-companion-test.mjs`, `scripts/e2e-p2-kdf-modelpin.mjs`) rely on specific DOM IDs (`#threshold`, `#save-btn`, `#lock-password`, `#companion-status`) and specific privacy strings (`"Your shared feedback data"`, `"Delete shared data"`, `"none yet — created the first time you share"`, `"Feedback sharing is not configured in this build"`).
   - Ensured all functional DOM IDs, test IDs, and required privacy test strings remained intact while revising descriptions and labels.

2. **Removal of Jargon & Technical Terms:**
   - Replaced *"AI Detection & Focus Context"* / *"Semantic Engine & Focus Context"* with *"Blocking Sensitivity & Focus Goal"*.
   - Replaced *"Block Confidence Threshold"* with *"Blocking Sensitivity"*, removing technical jargon and labeling slider ranges with clear adjectives: Strict (30%), Default (50%), and Relaxed (90%).
   - Replaced *"Active Focus Goal (System 1.5)"* with *"Active Focus Goal"*, removing the internal "System 1.5" and "2:1 Goal Weighting" badges.
   - Replaced *"Toggle distraction prototypes or inject custom semantic categories into the vector space"* with *"Select distraction categories to block, or add custom categories."*
   - Trimmed the category tip to remove *"— embedding similarity improves with specific phrasing."*
   - Replaced *"Deterministic Domain & Substring Rules"* and *"Short-circuit the neural classifier..."* with *"Allowed & Blocked Sites"* and *"Always allow specific websites, or immediately block specific sites and keywords."*
   - Replaced *"On-Device Learning"* and centroid references with *"Learned Preferences & Privacy"*, clearly explaining that SmartBlocker remembers unblock decisions without exposing centroid math.
   - Replaced technical footer tags (*"100% On-Device Inference · Privacy-First Architecture"*) with user-centric trust marks (*"100% Private & On-Device · Works Offline"*).

3. **Compilation & Bundle Verification:**
   - Ran `npm run typecheck` (`tsc --noEmit`) to confirm no TypeScript regressions.
   - Built both Chrome and Firefox extensions using Vite.
   - Grepped the resulting bundles in `dist/` to confirm that none of the target phrases remained in compiled assets.

## 4. Alternatives and Tradeoffs

- **Alternative 1: Keep technical explanations in an expandable 'Advanced' accordion.**
  - *Tradeoff:* Adds visual complexity and maintenance overhead for information that standard productivity users do not require. Standard user settings pages benefit from direct, plain-language descriptions.
- **Alternative 2: Completely replace all security references (e.g. 'Commitment Lock').**
  - *Tradeoff:* "Commitment Lock", "Timer Lock", and "Password Lock" are user-relevant behavioral concepts (popularized by productivity tools like Cold Turkey) rather than implementation details. Keeping these names while removing cryptographic labels (like "PBKDF2" or "Monotonic Guarantee") preserves clarity without jargon.

## 5. Verification

- **TypeScript Typecheck:** `npm run typecheck` passed with code 0.
- **Grep Verification:** `grep -E "Calibrate the softmax|Toggle distraction prototypes|embedding similarity improves|Short-circuit the neural" src/options/OptionsApp.tsx dist/chrome/assets/options-*.js dist/firefox/assets/options-*.js` returned 0 matches (exit code 1).
- **Extension Builds:**
  - `vite build -c vite.config.options.ts --mode chrome` succeeded (options bundle 869.80 kB).
  - `vite build -c vite.config.options.ts --mode firefox` succeeded.
  - Full `npm run build:chrome` and `npm run build:firefox` completed with code 0.
