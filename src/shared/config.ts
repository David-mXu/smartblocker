// Default values. These are the DEFAULTS for src/shared/settings.ts, which is
// the runtime source of truth (user-overridable from the options page).

// Chosen by smoke test (scripts/smoke-test.mjs): DeBERTa scored 9/10 vs
// MobileBERT's 5/10 at comparable speed (~60-100ms/title in Node).
// Known ceiling: the model doesn't recognize newer proper nouns — e.g.
// "Elden Ring Boss Fight" classifies as sports. Phase 2 plumbed richer page
// signals (channel + description) through, but on this tiny model that does NOT
// reliably fix it (and can backfire — see the CLAUDE.md richer-signal caveat);
// a stronger model is the Phase 3 plan.
export const MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

export const HYPOTHESIS_TEMPLATE = 'This video or post is about {}.';

// Zero-shot NLI runs ONE forward pass PER label — 8 labels = 8 inferences per
// title. Trimming to 5 labels is a free 38% speedup if latency disappoints.
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
];

export const BLOCKED_LABELS = new Set(['video games', 'memes and entertainment']);
export const BLOCK_THRESHOLD = 0.5;

export const HISTORY_CAP = 200; // raiseable to 1000; ~1-4 min scan at 200
export const TITLE_CACHE_MAX = 500;
export const LATENCY_LOG_MAX = 50;

// "Elden Ring Boss Fight" is kept deliberately: it demonstrates the model's
// proper-noun knowledge ceiling (classifies as sports). The Minecraft title
// shows a correct video-game hit.
export const TEST_TITLES = [
  'Elden Ring Boss Fight',
  'React Router Tutorial',
  'I spent 100 days in Hardcore Minecraft',
];
