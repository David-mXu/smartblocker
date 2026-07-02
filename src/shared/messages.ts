// popup/options/offscreen <-> background message contract.
import type { Settings } from './settings';

/** Classifier input. Phase 2 widens it from a bare title to richer page
 *  signals (channel, description/post-body snippet) — see build-input.ts. */
export interface ClassifyInput {
  title: string;
  channel?: string;
  context?: string;
}

/** A user correction: a title the user forced through the block screen. */
export interface Override {
  title: string;
  ts: number;
}

export type Request =
  | { type: 'TEST_PAIR' }
  | { type: 'SCAN_HISTORY' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  // Offscreen-document RPC: pure inference primitives, so the offscreen worker
  // stays decoupled from settings + text assembly (those live SW-side).
  | { type: 'CLASSIFY'; text: string; labels: string[] }
  | { type: 'OVERRIDE'; title: string; url?: string }
  | { type: 'CLOSE_TAB' };

export interface SettingsResponse {
  ok: boolean;
  settings?: Settings;
  error?: string;
}

/** Raw inference result from the model (pre-cache, pre-verdict). */
export interface InferResult {
  label: string;
  score: number;
  all: { labels: string[]; scores: number[] };
  /** Pipeline (re)load time — 0 when the model was already warm. */
  loadMs: number;
  inferMs: number;
}

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
