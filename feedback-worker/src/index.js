// FlowGuard feedback ingestion worker. Receives opt-in misclassification
// batches from the extension (src/background/feedback-uploader.ts) and stores
// them in D1. Records contain page title + hostname + verdicts only — the
// extension never sends full URLs or browsing history (see ../PRIVACY.md).
//
// Deliberately boring: POST ingest with schema validation, size caps, CORS for
// extension origins, idempotent inserts (the uploader retries un-acked
// batches), plus an authenticated GET export used by scripts/import-feedback.mjs
// to turn shared corrections into eval cases.
//
// AUTH ASYMMETRY, on purpose: ingest is unauthenticated (the data is
// low-sensitivity, per-IP abuse is bounded by the caps, and every install would
// otherwise need a shared secret baked into a public extension bundle) but
// EXPORT IS NOT. The table holds users' page titles, so bulk read requires the
// EXPORT_TOKEN secret. Never relax that.

const MAX_BATCH = 100;
const MAX_TEXT = 500;
const KINDS = new Set(['false_positive', 'false_negative']);
const EXPORT_PAGE_MAX = 500;
const EXPORT_PAGE_DEFAULT = 200;

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

/**
 * Constant-time-ish bearer check. Returns null when authorized, else a
 * Response. A missing EXPORT_TOKEN secret disables export entirely rather than
 * defaulting open — an unconfigured deploy must never serve user titles.
 */
function authorizeExport(request, env) {
  if (!env.EXPORT_TOKEN) return json(503, { error: 'export not configured' });
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = env.EXPORT_TOKEN;
  // Length check first, then a full-width compare so early bytes don't leak.
  let diff = presented.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.max(presented.length, expected.length); i++) {
    diff |= presented.charCodeAt(i % (presented.length || 1)) ^ expected.charCodeAt(i % (expected.length || 1));
  }
  if (diff !== 0) return json(401, { error: 'unauthorized' });
  return null;
}

/**
 * GET /v1/export?since=<id>&limit=<n>
 * Cursor-paginated by autoincrement id (stable under concurrent inserts, which
 * a timestamp cursor would not be). Returns { rows, nextCursor, done }.
 */
async function handleExport(request, env, url) {
  const denied = authorizeExport(request, env);
  if (denied) return denied;

  const since = Number(url.searchParams.get('since') ?? '0');
  const limitRaw = Number(url.searchParams.get('limit') ?? String(EXPORT_PAGE_DEFAULT));
  if (!Number.isInteger(since) || since < 0) return json(400, { error: 'bad since' });
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), EXPORT_PAGE_MAX)
    : EXPORT_PAGE_DEFAULT;

  const { results } = await env.DB.prepare(
    `SELECT id, install_id, ext_version, kind, title, channel, context, domain,
            model_label, score, corrected_label, model_id, ts, received_at
       FROM feedback
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?`,
  )
    .bind(since, limit)
    .all();

  const rows = results ?? [];
  return json(200, {
    rows,
    nextCursor: rows.length ? rows[rows.length - 1].id : since,
    done: rows.length < limit,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/v1/export') {
      return handleExport(request, env, url);
    }

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
