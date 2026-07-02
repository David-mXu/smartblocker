// Opt-in feedback uploader. Once a day, IF (and only if) the user enabled
// settings.shareFeedback AND a FEEDBACK_ENDPOINT is configured, POST the
// not-yet-uploaded feedback records to the ingestion worker (feedback-worker/)
// and mark them uploaded. Everything else about FlowGuard stays telemetry-free;
// see PRIVACY.md for exactly what a record contains (notably: hostname only,
// never full URLs, never browsing history).
import { api } from '../shared/api';
import { FEEDBACK_ENDPOINT } from '../shared/config';
import { getFeedback, markUploaded } from '../shared/feedback';
import { getSettings } from '../shared/settings';

const ALARM_NAME = 'feedback-upload';
const PERIOD_MINUTES = 24 * 60;
const MAX_BATCH = 100;

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

async function uploadPending(): Promise<void> {
  if (!FEEDBACK_ENDPOINT) return;
  const { shareFeedback } = await getSettings();
  if (!shareFeedback) return;

  const pending = (await getFeedback()).filter((r) => !r.uploaded).slice(0, MAX_BATCH);
  if (pending.length === 0) return;

  const res = await fetch(`${FEEDBACK_ENDPOINT.replace(/\/$/, '')}/v1/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installId: await getInstallId(),
      extVersion: api.runtime.getManifest().version,
      // `uploaded` is local bookkeeping — strip it from the wire format.
      records: pending.map(({ uploaded: _uploaded, ...r }) => r),
    }),
  });
  if (!res.ok) {
    // Leave records unmarked; the next daily alarm retries automatically.
    console.warn(`[FlowGuard] feedback upload failed: HTTP ${res.status}`);
    return;
  }
  await markUploaded(pending.map((r) => r.ts));
  console.log(`[FlowGuard] shared ${pending.length} feedback record(s)`);
}

/** MV3: called synchronously from index.ts startup. */
export function initFeedbackUploader(): void {
  // create() with the same name just reschedules — safe on every SW start.
  void api.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 5 });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void uploadPending().catch((e) => console.warn('[FlowGuard] feedback upload error:', e));
  });
}
