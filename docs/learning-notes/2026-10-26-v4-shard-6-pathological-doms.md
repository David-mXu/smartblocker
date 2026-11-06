# Learning Note: Generating V4 Shard 6 Adversarial Benchmark for Pathological DOMs

**Date:** 2026-10-26  
**Topic:** Synthetic Dataset Generation for Pathological DOMs (Empty Titles, Ultra-Short Titles, Auth Flows, and Generic Placeholders)  
**Artifacts Generated:**  
- Script: `/tmp/opencode/v4-shards/gen-s6.mjs`  
- Dataset: `/tmp/opencode/v4-shards/shard-6.json`

---

## 1. Goal and Problem Context

SmartBlocker uses authored DOM signals (`title`, `channel`, `context`) and URLs to classify web pages into productive content or specific distracting categories (e.g., `video games`, `online shopping`, `social media and networking`).

Real-world web navigation frequently encounters pathological DOM states where standard titles fail:
1. **Empty Titles (`""`)**: Single-page applications (SPAs) before initial render, dynamic client-side hydration delays, or raw media/PDF endpoints.
2. **Ultra-Short Titles (1–4 characters)**: Acronyms or single glyphs (e.g., `X`, `VK`, `F1`, `EA`, `CNN`, `AWS`, `Git`, `Go`, `知乎`, `原神`).
3. **Authentication Flows on Distracting Domains**: Logins, SSO redirects, 2FA prompts, and password resets on otherwise blockable services (Steam, Reddit, Netflix, Twitch, Amazon). By policy, SmartBlocker must **never** block sign-in pages to prevent user lockouts.
4. **Generic Placeholder Titles**: Boilerplate titles like `Loading...`, `Untitled`, `Just a moment...`, `Redirecting...`, or static brand names like `YouTube` / `Reddit` / `Home` where classification must disambiguate based on URL slug, channel, and DOM context.

The goal was to generate Shard 6 containing exactly 200 adversarial test cases without reading repository files, outputting cleanly structured, schema-compliant JSON.

---

## 2. Core Concepts & Taxonomy

- **Domain-Level Distraction vs. Page-Level Exemption**: Even if `x.com` or `reddit.com` are typically classified as `social media and networking`, an authentication flow (e.g., `https://x.com/i/flow/login`, `https://www.reddit.com/login/`) must evaluate to `"productive"` to allow user credentials entry.
- **Signal Disambiguation with Degrading Metadata**:
  - When `title` is empty (`""`), the model or heuristic must lean entirely on `channel`, `context`, and URL path structure (e.g., `/cart`, `/dp/`, `/app/`, `/reels/` vs. `/docs/`, `/book/`, `/assignments`).
  - When `title` is ambiguous or ultra-short (`F1`, `AWS`, `EA`, `Go`), context keywords and domain semantics provide the discriminative signal.
- **Allowed Classification Targets**:
  - `"productive"` (string)
  - Or an array of 1–2 strings from the strict set of 11 categories:
    - `"video games"`
    - `"memes and entertainment"`
    - `"social media and networking"`
    - `"online shopping"`
    - `"gambling and betting"`
    - `"adult content"`
    - `"sports"`
    - `"music"`
    - `"movies and tv shows"`
    - `"news and politics"`
    - `"finance and investing"`

---

## 3. Implementation Steps

1. **Script Architecture (`/tmp/opencode/v4-shards/gen-s6.mjs`)**:
   - Structured into four explicit cohort arrays:
     - **Cohort 1 (60 Empty Titles)**: 35 Must-Block (e.g., Amazon cart, Steam store apps, Twitch streams, DraftKings, Pornhub, 9GAG) and 25 Productive (e.g., Rust docs, Go docs, Kubernetes reference, arXiv papers, Grafana, Jenkins, university courses, package tracking).
     - **Cohort 2 (60 Ultra-Short Titles)**: 35 Must-Block and 25 Productive spanning 1–4 character strings (`X`, `VK`, `F1`, `EA`, `IGN`, `BBC`, `CNN`, `MAX`, `GOG`, `PSN`, `UFC`, `AWS`, `GCP`, `MDN`, `IRS`, `NIH`, `Git`, `Vim`, `Zig`, `Go`, `Lua`, `Nix`, `淘宝`, `原神`, `知乎`).
     - **Cohort 3 (40 Auth Flows)**: 40 sign-in/login/OAuth/2FA pages across major entertainment, gaming, social media, shopping, and betting platforms, with `"expected": "productive"`, `/login`, `/signin`, `/auth`, or `/oauth` in URL, and `"Account sign-in page."` / `"Enter your password to sign in."` in the context.
     - **Cohort 4 (40 Generic Placeholders)**: 20 Must-Block and 20 Productive cases using titles `Loading...`, `Untitled`, `Just a moment...`, `Redirecting...`, `YouTube`, `Reddit`, `Home`.
2. **Schema & Integrity Validation**:
   - Built programmatic checks within the script to verify item count (200), URL format (`https://`), URL uniqueness (using `Set`), cohort boundaries, string lengths, and category validity.
3. **Execution & Verification**:
   - Ran `node /tmp/opencode/v4-shards/gen-s6.mjs` to emit `/tmp/opencode/v4-shards/shard-6.json`.
   - Executed an independent verification script validating all 200 items against the schema rules.

---

## 4. Verification & Tradeoffs

- **URL Uniqueness**: Ensured 200 unique, valid HTTPS URLs with distinct query parameters or paths across real services.
- **Auth URL Keywords**: Discovered during testing that Twitch 2FA URL was initially `/two-factor-auth`, which didn't contain `/auth/` as an isolated path segment under strict substring checks; updated to `/auth/two-factor` to strictly satisfy `/auth` path matching.
- **Verification Output**:
  - `Total items`: 200
  - `Unique URLs`: 200
  - `Cohort 1 (Empty Titles)`: 60 (35 block, 25 productive)
  - `Cohort 2 (Ultra-Short Titles)`: 60 (1–4 characters)
  - `Cohort 3 (Auth / Sign-In Pages)`: 40 (all productive)
  - `Cohort 4 (Generic Placeholders)`: 40 (20 block, 20 productive)
