// Opt-in feedback uploader. Once a day, IF (and only if) the user enabled
// settings.shareFeedback AND a FEEDBACK_ENDPOINT is configured, POST the
// not-yet-uploaded feedback records to the ingestion worker (feedback-worker/)
// and mark them uploaded. Everything else about SmartBlocker stays telemetry-free;
// see PRIVACY.md for exactly what a record contains (notably: hostname only,
// never full URLs, never browsing history).
import { api } from '../shared/api';
import { FEEDBACK_ENDPOINT } from '../shared/config';
import { getFeedback, markSkipped, markUploaded, type FeedbackRecord } from '../shared/feedback';
import { getSettings } from '../shared/settings';

const ALARM_NAME = 'feedback-upload';
const PERIOD_MINUTES = 24 * 60;
const MAX_BATCH = 100;

// Wire-contract mirrors of the ingestion worker's validation caps
// (feedback-worker/src/index.js MAX_TEXT / MAX_MODEL_ID / hostname ceiling).
// A record failing these can NEVER be accepted — and the worker 400s the
// whole batch, so without this check one oversized legacy record (stored
// before addFeedback started capping fields) makes the daily alarm re-send
// the same doomed batch forever. Such records are marked skipped once and
// never retried; they still count for local on-device learning.
const WORKER_MAX_TEXT = 500;
const WORKER_MAX_MODEL_ID = 200;
const WORKER_MAX_DOMAIN = 253;

/**
 * True if the worker's validateRecord() would accept this record — a faithful
 * mirror of feedback-worker/src/index.js semantics (exact parity matters: a
 * false negative here means the worker 400s the whole batch and the daily
 * alarm retries forever; a false positive permanently skips a sendable
 * record). Kind/score/ts are guaranteed by the FeedbackRecord type and only
 * defensively re-checked.
 */
function withinWorkerCaps(r: FeedbackRecord): boolean {
  if (r.kind !== 'false_positive' && r.kind !== 'false_negative') return false;
  // isShortString: nonempty, ≤ cap.
  if (!r.title || r.title.length > WORKER_MAX_TEXT) return false;
  // isOptShortString: absent is fine, present must be nonempty and ≤ cap.
  const optShort = (v: string | undefined) =>
    v === undefined || (v.length > 0 && v.length <= WORKER_MAX_TEXT);
  if (!optShort(r.channel)) return false;
  if (!optShort(r.context)) return false;
  // domain: string ≤ 253 (the worker allows empty).
  if (r.domain.length > WORKER_MAX_DOMAIN) return false;
  // modelLabel: string ≤ cap (the worker allows empty here, unlike title).
  if (r.modelLabel.length > WORKER_MAX_TEXT) return false;
  if (r.kind === 'false_negative' && (!r.correctedLabel || r.correctedLabel.length > WORKER_MAX_TEXT))
    return false;
  if (!r.modelId || r.modelId.length > WORKER_MAX_MODEL_ID) return false;
  if (!Number.isFinite(r.score)) return false;
  if (!Number.isInteger(r.ts) || r.ts <= 0) return false;
  return true;
}

/** Random, resettable install id so the server can de-duplicate batches
 *  without anything identifying: delete it (clear extension storage) and the
 *  next upload looks like a brand-new install. */
async function getInstallId(): Promise<string> {
  const { installId } = await api.storage.local.get('installId');
  if (typeof installId === 'string' && installId) return installId;
  const fresh = crypto.randomUUID();
  await api.storage.local.set({ installId: fresh });
  return fresh;
}

/** Read-only variant for the options UI (#32 P3): does NOT mint an id, so
 *  installs that never shared corrections honestly render "no id yet". */
export async function getExistingInstallId(): Promise<string | null> {
  const { installId } = await api.storage.local.get('installId');
  return typeof installId === 'string' && installId ? installId : null;
}

/** Self-service erasure (#32 P3): ask the worker to delete every record this
 *  install shared. Mirrors the worker's honest-auth design: no per-install
 *  secret exists (the bundle is public), so the route is rate-limited to
 *  1/hr per installId, fully logged, and consequence-bounded — documented in
 *  PRIVACY.md "Data retention". A 429 surfaces as an error string so the UI
 *  can say "try again later" instead of pretending the wipe failed worse. */
export async function deleteSharedFeedback(): Promise<{
  ok: boolean;
  deleted?: number;
  error?: string;
}> {
  if (!FEEDBACK_ENDPOINT) return { ok: false, error: 'feedback endpoint not configured' };
  const installId = await getExistingInstallId();
  // Nothing was ever uploaded from this install — there is nothing to delete
  // server-side, and minting an id just to DELETE 0 rows would be noise.
  if (!installId) return { ok: true, deleted: 0 };
  try {
    const res = await fetch(`${FEEDBACK_ENDPOINT.replace(/\/$/, '')}/v1/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installId }),
    });
    if (res.status === 429) return { ok: false, error: 'rate-limited — try again in an hour' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { deleted?: number };
    return { ok: true, deleted: typeof body.deleted === 'number' ? body.deleted : 0 };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function uploadPending(): Promise<void> {
  if (!FEEDBACK_ENDPOINT) return;
  const { shareFeedback } = await getSettings();
  if (!shareFeedback) return;

  const unsent = (await getFeedback()).filter((r) => !r.uploaded && !r.skipped);
  // Permanently retire records that can never satisfy the worker's wire
  // contract, so they stop poisoning every daily batch.
  const unsendable = unsent.filter((r) => !withinWorkerCaps(r));
  if (unsendable.length > 0) {
    try {
      await markSkipped(unsendable.map((r) => r.ts));
      console.warn(
        `[SmartBlocker] feedback upload: skipped ${unsendable.length} record(s) outside the worker's wire caps`,
      );
    } catch (e) {
      console.warn('[SmartBlocker] feedback skip marking failed:', e);
    }
  }
  const pending = unsent.filter(withinWorkerCaps).slice(0, MAX_BATCH);
  if (pending.length === 0) return;

  const res = await fetch(`${FEEDBACK_ENDPOINT.replace(/\/$/, '')}/v1/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installId: await getInstallId(),
      extVersion: api.runtime.getManifest().version,
      // `uploaded`/`skipped` are local bookkeeping — strip from the wire format.
      records: pending.map(({ uploaded: _uploaded, skipped: _skipped, ...r }) => r),
    }),
  });
  if (!res.ok) {
    // Leave records unmarked; the next daily alarm retries automatically.
    console.warn(`[SmartBlocker] feedback upload failed: HTTP ${res.status}`);
    return;
  }
  await markUploaded(pending.map((r) => r.ts));
  console.log(`[SmartBlocker] shared ${pending.length} feedback record(s)`);
}

/** MV3: called synchronously from index.ts startup. */
export function initFeedbackUploader(): void {
  // create() with the same name just reschedules — safe on every SW start.
  void api.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 5 });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void uploadPending().catch((e) => console.warn('[SmartBlocker] feedback upload error:', e));
  });
}
