// Default values. These are the DEFAULTS for src/shared/settings.ts, which is
// the runtime source of truth (user-overridable from the options page).

// Two classifier backends exist (both fully local):
//   'embed' — embedding-prototype classifier: ONE feature-extraction forward
//             pass per title, classified by cosine similarity against
//             per-category centroid embeddings (src/shared/prototypes.ts).
//             Won the 2026-07 bake-off (scripts/benchmark.mjs): 87.8% top-1,
//             1.8% productive-FP / 75.4% must-block recall @0.5, ~3ms/title —
//             vs 65.2% / 7.1% / 31.9% @ ~111ms for the NLI baseline.
//   'nli'   — legacy zero-shot NLI (one forward pass PER label). Kept as a
//             fallback switch; not exposed in the UI.
export const CLASSIFIER_BACKEND: 'embed' | 'nli' = 'embed';

// Embedding backend model (~34MB q8, cached via Cache API).
export const EMBED_MODEL_ID = 'Xenova/bge-small-en-v1.5';
// Pinned HF Hub commit (red-team #19): without `revision`, pipeline() floats
// on the mutable `main` branch with no integrity check. Bump by resolving the
// current main SHA:
//   curl -s https://huggingface.co/api/models/Xenova/bge-small-en-v1.5 | grep -o '"sha":"[0-9a-f]*"' | head -1
// NOTE: cached title verdicts and centroids are keyed by model ID, not
// revision — when bumping, also bump the ':mp1' version suffix in
// classifier.ts getCentroids()/classify() so stale caches are invalidated.
export const EMBED_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
// Softmax temperature over centroid cosine similarities, calibrated on the
// eval set so the natural operating point sits at the default 0.5 threshold.
// Recalibrated 0.03 -> 0.026 when the 18th centroid (neutral "accounts and
// sign-in") was added: every extra centroid grows the softmax denominator and
// deflates all scores, so the temperature re-sharpens to keep 0.5 natural.
export const SOFTMAX_TEMPERATURE = 0.026;

// Legacy NLI backend (bake-off baseline). Known ceiling: doesn't recognize
// newer proper nouns — e.g. "Elden Ring Boss Fight" classifies as sports.
export const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';
// Pinned HF Hub commit (see EMBED_MODEL_REVISION above). Bump with:
//   curl -s https://huggingface.co/api/models/Xenova/nli-deberta-v3-xsmall | grep -o '"sha":"[0-9a-f]*"' | head -1
export const MODEL_REVISION = '2a4f614a701367a02d51389039afc998faeda637';

export const HYPOTHESIS_TEMPLATE = 'This web page is about {}.';

// Default whitelist: sites that are never classified or blocked out of the box.
// SmartBlocker now watches ALL http(s) sites; these essentials (search, mail, docs,
// dev/work tools, localhost) are exempted so common productive pages are never
// false-positive blocked. Matched by domain + subdomains (see isWhitelisted in
// titles.ts) — "google.com" also exempts mail.google.com, docs.google.com, etc.
// The user edits this list from the options page.
export const DEFAULT_WHITELIST: string[] = [
  // Search
  'google.com',
  'bing.com',
  'duckduckgo.com',
  // Mail
  'outlook.com',
  'outlook.live.com',
  'proton.me',
  // Productivity / docs / dev / work tools
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'notion.so',
  'slack.com',
  'atlassian.net',
  'figma.com',
  'miro.com',
  'zoom.us',
  'teams.microsoft.com',
  // AI assistants
  'chatgpt.com',
  'claude.ai',
  // Banking / Finance
  'mbna.ca',
  // Local development
  'localhost',
  '127.0.0.1',
];

// Zero-shot NLI runs ONE forward pass PER label — 13 labels = 13 inferences
// per title. Trimming labels is a free linear speedup if latency disappoints.
// "video games" (not "gaming") separates games from sports much more
// cleanly: "NBA Finals Game 7 highlights" -> sports 0.95 vs 0.78.
export const LABELS = [
  'programming and software development',
  'video games',
  'finance and investing',
  'memes and entertainment',
  'news and politics',
  'science and education',
  'music',
  'sports',
  'online shopping',
  'social media and networking',
  'gambling and betting',
  'movies and tv shows',
  'adult content',
];

// 'movies and tv shows' is deliberately NOT blocked by default (like 'music'/
// 'sports') — it's the most debatable of the new categories; the rest are
// unambiguous distraction categories in the Cold-Turkey-style premade sense.
export const BLOCKED_LABELS = new Set([
  'video games',
  'memes and entertainment',
  'online shopping',
  'social media and networking',
  'gambling and betting',
  'adult content',
]);
export const BLOCK_THRESHOLD = 0.5;

// Opt-in feedback sharing (settings.shareFeedback, default OFF). Empty string
// disables uploads entirely; this build points at the deployed
// feedback-worker/ (see PRIVACY.md). Deployed 2026-11-06.
export const FEEDBACK_ENDPOINT: string = 'https://smartblocker-feedback.xudavid12613.workers.dev';

export const HISTORY_CAP = 200; // raiseable to 1000; ~1-4 min scan at 200
export const TITLE_CACHE_MAX = 500;
export const LATENCY_LOG_MAX = 50;

// "Elden Ring Boss Fight" is kept deliberately: the legacy zero-shot NLI
// pipeline suffered proper-noun blindness here (misclassifying the title as
// sports), whereas the embedding model with prototype seeds now correctly
// classifies it as video games. The Minecraft title shows an easy
// video-game hit.
export const TEST_TITLES = [
  'Elden Ring Boss Fight',
  'React Router Tutorial',
  'I spent 100 days in Hardcore Minecraft',
];
