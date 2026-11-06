# Learning Note: V4 Adversarial Benchmark Shard 2 — Trojan Horse Distractions

**Date:** 2026-10-26  
**Topic:** Adversarial False-Negative Minefield Generation for Content Blockers

---

## 1. Goal & Context
The goal was to generate `/tmp/opencode/v4-shards/shard-2.json` containing exactly 200 unique adversarial test cases for SmartBlocker's evaluation suite (Shard 2: "Trojan Horse Distractions — the False-Negative Minefield"), created via a standalone generation script `/tmp/opencode/v4-shards/gen-s2.mjs`.

In content-filtering systems and distraction blockers (like SmartBlocker), standard text-classification models frequently fail on **Trojan Horse Distractions**. These are entertainment, gaming, gambling, or shopping activities that superficially disguise themselves with academic, financial, engineering, or productivity jargon (e.g., "stochastic optimization", "Markov decision process", "ergonomic telemetry", "sociological discourse").

---

## 2. Core Concepts & Definitions
- **Trojan Horse Distraction (False-Negative Minefield):** Content whose primary intent is leisure, entertainment, gambling, or consumer spending, but whose linguistic surface utilizes technical vocabulary that tricks naïve keyword-matching or bag-of-words classifiers into predicting "work", "research", or "education".
- **Must-Block Classification:** High-distraction pages that should trigger blocking despite sophisticated domain vocabulary.
- **Signal Multi-labeling:** Categorization where items may straddle two categories (such as viral stream discourse matching both `memes and entertainment` and `social media and networking`).

---

## 3. Implementation Steps & Architectural Choices
1. **Category Division:**
   The 200 items were partitioned into four 50-item quadrants:
   - **Video Game Theorycrafting & Esports (50 items):** Path of Exile currency arbitrage, Factorio 10k SPM rail signaling, EVE Online Jita station trading, League of Legends wave mechanics, World of Warcraft Mythic+ WarcraftLogs telemetry, CS2/Valorant post-match breakdowns, and Elden Ring frame data tables. Expected label: `["video games"]`.
   - **Gambling, Sportsbooks & Crypto Casinos (50 items):** Polymarket/Kalshi binary prediction contracts, +EV betting models on DraftKings/FanDuel, Stake/Roobet Plinko and Crash martingale curves, r/wallstreetbets 0DTE options loss porn, PrizePicks flex slips, GTO poker solvers, and pump.fun memecoin snipers. Expected label: `["gambling and betting"]`.
   - **Shopping Hauls & Luxury Configurators (50 items):** Porsche/BMW configurators, Sweetwater/B&H/Thomann checkout flows, SSENSE/Zara lookbook carts, minimalist WFH desk affiliate guides, Sephora/Ulta beauty hauls, and custom mechanical keyboard group-buys. Expected label: `["online shopping"]`.
   - **Influencer Drama & Streamer Culture (50 items):** 2+ hour video essays on creator fallouts, 24/7 Twitch/Kick subathons (Kai Cenat, xQc, Asmongold), Deuxmoi/Fauxmoi celebrity gossip threads, reality TV reunion meltdowns, and TikTok prank compilations. Expected labels: `["memes and entertainment"]` or `["memes and entertainment", "social media and networking"]`.

2. **Script Design (`/tmp/opencode/v4-shards/gen-s2.mjs`):**
   - Implemented an ES Module script structuring each section as explicit, well-formed JSON objects.
   - Preserved all required fields: `url`, `input` (`title`, `channel`, `context`), `expected`, `set: "v4"`, and `noCapture: "v4 adversarial benchmark — scored on authored signals"`.
   - Guaranteed 200 globally unique, realistic URLs matching canonical platform conventions.

---

## 4. Tradeoffs & Alternatives
- **Dynamic Programmatic Generation vs. Authored Semantic Depth:**
  - *Alternative:* Templating titles with random permutations (e.g., combining `[Math Term] + [Game Mechanic]`).
  - *Tradeoff:* Templated items often sound synthetic and lack the nuanced jargon of real subcultures (e.g., "Kovarex stable equilibrium", "Mythic Tindral seed clearing", "closing line value regression", "Tadpole gasket mounting"). Authoring realistic items produces far higher adversarial fidelity for benchmarking.

---

## 5. Verification
The dataset was verified by executing an inline Node.js verification script checking:
- JSON parsability of `/tmp/opencode/v4-shards/shard-2.json`.
- Array length: Exactly 200 items.
- Uniqueness: 200 distinct URLs across all items (`urls.size === 200`).
- Valid schema and fields on every object (`url`, `input.title`, `input.channel`, `input.context`, `expected`, `set`, `noCapture`).
- Expected labels: Exactly 50 items per category, with all labels drawn strictly from the approved set.
- All checks exited with code 0.
