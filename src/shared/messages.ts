// popup/options/offscreen <-> background message contract.
import type { CompanionSnapshot } from './companion-protocol';
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
  | { type: 'EMBED'; texts: string[] }
  // label/score = the verdict being corrected, so the false-positive feedback
  // record captures what the model actually said at decision time.
  | { type: 'OVERRIDE'; title: string; url?: string; label?: string; score?: number }
  // Popup "this page should have been blocked" report (false negative).
  | { type: 'REPORT_FN'; title: string; url: string; correctedLabel: string }
  | { type: 'CLOSE_TAB' }
  // Options page: state of the Native Messaging bridge to the desktop
  // companion (silently 'not-installed' for free-tier users without it).
  | { type: 'GET_COMPANION_STATUS' };

export type EventMessage =
  | { type: 'MODEL_PROGRESS'; file?: string; progress?: number; status: string };

export interface SettingsResponse {
  ok: boolean;
  settings?: Settings;
  error?: string;
}

export interface CompanionStatusResponse {
  ok: boolean;
  snapshot?: CompanionSnapshot;
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

/** Raw embedding result from the feature-extraction model (embed backend). */
export interface EmbedResult {
  /** One normalized embedding vector per input text, in input order. */
  vectors: number[][];
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
  /** Raw entries chrome.history.search returned, before the classifiable/
   *  whitelist/dedupe filters — lets the UI explain a 0 `total` (empty
   *  history vs. everything filtered out, e.g. by the whitelist). */
  historyCount: number;
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
