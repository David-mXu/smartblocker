// FlowGuard feedback ingestion worker. Receives opt-in misclassification
// batches from the extension (src/background/feedback-uploader.ts) and stores
// them in D1. Records contain page title + hostname + verdicts only — the
// extension never sends full URLs or browsing history (see ../PRIVACY.md).
//
// Deliberately boring: one POST route, schema validation, size caps, CORS for
// extension origins, idempotent inserts (the uploader retries un-acked
// batches). No auth — the data is low-sensitivity and per-IP abuse is bounded
// by the caps; revisit if the endpoint ever attracts junk.

const MAX_BATCH = 100;
const MAX_TEXT = 500;
const KINDS = new Set(['false_positive', 'false_negative']);

const CORS_HEADERS = {
  'access-control-allow-origin': '*', // extension origins are per-install ids
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

const isShortString = (v, max = MAX_TEXT) =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const isOptShortString = (v) => v === undefined || v === null || isShortString(v);

/** Returns null if valid, else a reason string. */
export function validateRecord(r) {
  if (typeof r !== 'object' || r === null) return 'record not an object';
  if (!KINDS.has(r.kind)) return `bad kind: ${r.kind}`;
  if (!isShortString(r.title)) return 'bad title';
  if (!isOptShortString(r.channel)) return 'bad channel';
  if (!isOptShortString(r.context)) return 'bad context';
  if (typeof r.domain !== 'string' || r.domain.length > 253) return 'bad domain';
  if (typeof r.modelLabel !== 'string' || r.modelLabel.length > MAX_TEXT) return 'bad modelLabel';
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return 'bad score';
  if (r.kind === 'false_negative' && !isShortString(r.correctedLabel)) return 'bad correctedLabel';
  if (!isShortString(r.modelId, 200)) return 'bad modelId';
  if (!Number.isInteger(r.ts) || r.ts <= 0) return 'bad ts';
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/feedback') {
      return json(404, { error: 'not found' });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'invalid JSON' });
    }

    const { installId, extVersion, records } = body ?? {};
    if (!isShortString(installId, 64)) return json(400, { error: 'bad installId' });
    if (!isShortString(extVersion, 32)) return json(400, { error: 'bad extVersion' });
    if (!Array.isArray(records) || records.length === 0 || records.length > MAX_BATCH) {
      return json(400, { error: `records must be 1..${MAX_BATCH}` });
    }
    for (const r of records) {
      const reason = validateRecord(r);
      if (reason) return json(400, { error: reason });
    }

    const now = Date.now();
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO feedback
         (install_id, ext_version, kind, title, channel, context, domain,
          model_label, score, corrected_label, model_id, ts, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DB.batch(
      records.map((r) =>
        stmt.bind(
          installId,
          extVersion,
          r.kind,
          r.title,
          r.channel ?? null,
          r.context ?? null,
          r.domain,
          r.modelLabel,
          r.score,
          r.correctedLabel ?? null,
          r.modelId,
          r.ts,
          now,
        ),
      ),
    );

    return json(200, { ok: true, stored: records.length });
  },
};
