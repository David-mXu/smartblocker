// popup/options/offscreen <-> background message contract.
import type { CompanionSnapshot, CompanionStatus } from './companion-protocol';
import type { UsageStatsExport } from './usage-stats';
import type { BreakMode } from './breaks';
import type { LockStatus } from './lock-math';
import type { SubItemEvalRequest, SubItemEvalResult } from '../content/sanitize-page';
import type { AllowanceAuthorityState, AllowanceCommand } from './allowance-state';
import type { RewardAccrualStatus } from './reward-accrual';
import type { FocusCycleMode, FocusCycleProgram } from './focus-cycle-types';

/** Classifier input. Phase 2 widens it from a bare title to richer page
 *  signals (channel, description/post-body snippet) — see build-input.ts. */
export interface ClassifyInput {
  title: string;
  channel?: string;
  context?: string;
  /** Optional explicit focus goal + open-tab context for gray-zone disambiguation. */
  focusContext?: {
    focusGoal?: string;
    openTabTitles?: string[];
  };
}

/** A user correction: a title the user forced through the block screen. */
export interface Override {
  title: string;
  ts: number;
}

export type Request =
  // Local-only idle-aware aggregates; export shape contains no URLs or titles.
  | { type: 'GET_USAGE_STATS' }
  | { type: 'CLEAR_USAGE_STATS' }
  | { type: 'TEST_PAIR' }
  | { type: 'VERIFY_PROTECTION' }
  | { type: 'COMPLETE_ONBOARDING' }
  | { type: 'SCAN_HISTORY' }
  // Offscreen-document RPC: pure inference primitives, so the offscreen worker
  // stays decoupled from settings + text assembly (those live SW-side).
  | { type: 'CLASSIFY'; text: string; labels: string[] }
  | { type: 'EMBED'; texts: string[] }
  // label/score = the verdict being corrected, so the false-positive feedback
  // record captures what the model actually said at decision time.
  // nonce = one-time token minted by the SW when it injected the block
  // screen; the OVERRIDE handler drops messages without a valid one.
  | { type: 'OVERRIDE'; title: string; url?: string; label?: string; score?: number; nonce?: string }
  // Popup "this page should have been blocked" report (false negative).
  | { type: 'REPORT_FN'; title: string; url: string; correctedLabel: string }
  | { type: 'CLOSE_TAB' }
  // Options page: state of the Native Messaging bridge to the desktop
  // companion (silently 'not-installed' for free-tier users without it).
  | { type: 'GET_COMPANION_STATUS' }
  // Options page: reveal the installId (or null when corrections were never
  // shared — the id is only minted on first upload) so the user can
  // self-serve erasure (#32 P3).
  | { type: 'GET_SHARED_FEEDBACK_INFO' }
  // Options page: delete every feedback record this install shared, via the
  // worker's self-service POST /v1/delete (rate-limited 1/hr per installId).
  | { type: 'DELETE_SHARED_FEEDBACK' }
  // Explicit-release lock controls. Delay completion and random-text proof
  // verification are background-only; a page never decides its own gate.
  | { type: 'START_DELAY_UNLOCK' }
  | { type: 'CANCEL_DELAY_UNLOCK' }
  | { type: 'COMPLETE_DELAY_UNLOCK' }
  | { type: 'REQUEST_RANDOM_TEXT_UNLOCK_CHALLENGE' }
  | { type: 'ATTEMPT_RANDOM_TEXT_UNLOCK'; challengeId: string; text: string }
  // Locked popup break controls. Text proof is generated and verified by the
  // service worker; the page never decides its own gate result.
  | { type: 'REQUEST_BREAK_CHALLENGE' }
  | { type: 'START_BREAK'; mode: BreakMode; text?: string }
  | { type: 'CANCEL_BREAK' }
  // Accountability-partner public setup/redeem. Offline Ed25519 secrets never
  // enter this channel; only public keys, arm operations, and signed codes.
  | { type: 'PARTNER_COMMAND'; command:
      | { action: 'add-key'; publicKey: string }
      | { action: 'arm' }
      | { action: 'begin-operation' }
      | { action: 'redeem'; token: string }
  }
  // Item 10: valid commands only; the background/daemon owns every resulting
  // balance and revision. The options page never uploads a replacement ledger.
  | { type: 'GET_ALLOWANCE_AUTHORITY' }
  | { type: 'ALLOWANCE_COMMAND'; command: AllowanceCommand }
  /** Live, read-only productivity-earning status. No balance is uploaded. */
  | { type: 'GET_REWARD_STATUS' }
  // Immediate focus timer or a timed Pomodoro program. These never create
  // Frozen locks; only completed work earns reward and fixed breaks.
  | { type: 'GET_FOCUS_CYCLE' }
  | { type: 'START_FOCUS_CYCLE'; category: string; mode: FocusCycleMode; workMinutes: number; breakMinutes: number; cycles: number }
  | { type: 'CANCEL_FOCUS_CYCLE' }
  // Content sanitizer: batch-classify embedded videos & SERP result cards.
  | { type: 'EVAL_SUBITEMS'; items: SubItemEvalRequest[] };

export interface SubItemsResponse {
  ok: boolean;
  results?: SubItemEvalResult[];
  error?: string;
}

export type EventMessage =
  | { type: 'MODEL_PROGRESS'; file?: string; progress?: number; status: string };

export interface CompanionStatusResponse {
  ok: boolean;
  snapshot?: CompanionSnapshot;
  /** Whether "Allow in Incognito" is on for the extension — off means
   *  Incognito windows bypass all blocking (warned about in the options UI). */
  incognitoAllowed?: boolean;
  error?: string;
}

export interface SharedFeedbackInfoResponse {
  ok: boolean;
  /** Random UUID minted at first share, or null when nothing was ever shared. */
  installId?: string | null;
  error?: string;
}

export interface DeleteSharedFeedbackResponse {
  ok: boolean;
  /** Rows the worker reported deleted (0 is normal if nothing was shared). */
  deleted?: number;
  error?: string;
}

export interface UsageStatsResponse {
  ok: boolean;
  stats?: UsageStatsExport;
  error?: string;
}

export interface AllowanceResponse {
  ok: boolean;
  source?: 'daemon' | 'fallback' | 'pending';
  state?: AllowanceAuthorityState;
  reason?: string;
  duplicate?: boolean;
  error?: string;
}

export interface RewardStatusResponse {
  ok: boolean;
  status?: RewardAccrualStatus;
  error?: string;
}

export interface PartnerCommandResponse {
  ok: boolean;
  message?: string;
  status?: CompanionStatus;
  error?: string;
}

export interface FocusCycleResponse {
  ok: boolean;
  program?: FocusCycleProgram | null;
  error?: string;
}

export interface BreakResponse {
  ok: boolean;
  /** Present only for REQUEST_BREAK_CHALLENGE. */
  text?: string;
  status?: LockStatus;
  error?: string;
}

export interface LockTypeResponse {
  ok: boolean;
  /** Present with a newly minted random-text lock challenge. */
  challengeId?: string;
  text?: string;
  status?: LockStatus;
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

export interface ProtectionVerdictEvidence {
  label: string;
  score: number;
  effectiveScore: number;
  decision: 'block' | 'allow';
  /** Must be false for a successful readiness check. */
  cached: boolean;
}

export interface ProtectionCheck {
  id: 'site-access' | 'distraction' | 'productive';
  status: 'passed' | 'failed' | 'error';
  label: string;
  detail: string;
  verdict?: ProtectionVerdictEvidence;
}

export interface VerifyProtectionResponse {
  /** Only `ready` may complete onboarding. */
  status: 'ready' | 'degraded' | 'error';
  checks: ProtectionCheck[];
  /** Transport/unexpected failure detail; per-check errors live in `checks`. */
  error?: string;
}

export interface CompleteOnboardingResponse extends VerifyProtectionResponse {
  /** True only after the background persisted enabled + onboarded together. */
  saved: boolean;
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
