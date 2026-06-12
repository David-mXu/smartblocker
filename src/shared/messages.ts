// popup <-> background message contract.

export type Request =
  | { type: 'TEST_PAIR' }
  | { type: 'SCAN_HISTORY' };

export interface ClassifyOutcome {
  text: string;
  label: string;
  score: number;
  /** Full label distribution, best-first. */
  all: { labels: string[]; scores: number[] };
  /** Pipeline (re)load time — 0 when the model was already warm. */
  loadMs: number;
  inferMs: number;
  /** True when served from the title cache (no inference ran). */
  cached: boolean;
}

export interface TestPairResponse {
  ok: boolean;
  results?: ClassifyOutcome[];
  error?: string;
}

export interface HistoryScanState {
  status: 'idle' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  items: { title: string; url: string; label: string; score: number }[];
  categoryCounts: Record<string, number>;
  elapsedMs: number;
  error?: string;
}

export interface LatencySample {
  url: string;
  title: string;
  label: string;
  score: number;
  blocked: boolean;
  cached: boolean;
  /** Navigation commit -> title available. The page's own slowness. */
  pageDelayMs: number;
  /** Model (re)load — isolates service-worker cold starts. */
  loadMs: number;
  inferMs: number;
  injectMs: number;
  /** Title available -> overlay painted (or verdict, if not blocked). */
  totalMs: number;
  ts: number;
}
