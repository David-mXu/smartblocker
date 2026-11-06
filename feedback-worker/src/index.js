// SmartBlocker feedback ingestion worker. Receives opt-in misclassification
// batches from the extension (src/background/feedback-uploader.ts) and stores
// them in D1. Records contain page title + hostname + verdicts only — the
// extension never sends full URLs or browsing history (see ../PRIVACY.md).
//
// Deliberately boring: POST ingest with schema validation, size caps, CORS for
// extension origins, idempotent inserts (the uploader retries un-acked
// batches), plus an authenticated GET export used by scripts/import-feedback.mjs
// to turn shared corrections into eval cases, a self-service POST /v1/delete,
// and a daily cron that purges expired rows (see schema.sql `expires_at` and
// PRIVACY.md "Data retention").
//
// AUTH ASYMMETRY, on purpose: ingest is unauthenticated (the data is
// low-sensitivity, and every install would otherwise need a shared secret
// baked into a public extension bundle) — but it is NOT unbounded. The
// per-request caps bound a single request only; they do nothing about
// attacker-minted installIds flooding the dataset or burning the free tier.
// So ingest ALSO carries fixed-window D1 rate limits (per install id AND per
// IP, per minute AND per day — see rateLimit.js semantics below) and a hard
// body cap rejected BEFORE the body is read. EXPORT remains the guarded side:
// the table holds users' page titles, so bulk read requires the EXPORT_TOKEN
// secret. Never relax that.

const MAX_BATCH = 100;
const MAX_TEXT = 500;
const KINDS = new Set(['false_positive', 'false_negative']);
const EXPORT_PAGE_MAX = 500;
const EXPORT_PAGE_DEFAULT = 200;

// A fully maxed-out legitimate batch is ~314 KB on the wire (100 records ×
// ~3.1 KB: every string field at its validation cap, plus JSON overhead), so
// the pre-read cap must sit above that or it would reject bodies the uploader
// is contractually allowed to send. 350 KiB leaves ~11% headroom and still
// bounds what request.text() will buffer.
const MAX_BODY_BYTES = 350 * 1024;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const RETENTION_MS = 90 * DAY_MS; // PRIVACY.md "Data retention": 90 days.

// Anti-abuse limits (#18). install/day matches the uploader's cadence exactly
// (the daily alarm sends at most one 100-record batch), so real users never
// feel it; only floods do. IP/day allows several installs behind one NAT.
const LIMITS = {
  installRecordsPerDay: 100,
  ipRecordsPerDay: 300,
  burstRequestsPerMinute: 10, // per install AND per IP
  deletesPerHourPerInstall: 1,
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*', // extension origins are per-install ids
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...headers },
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
 * Fixed-window rate limiting (#18) — one D1 upsert per bucket, in the rate_limits
 * table (schema.sql). Buckets are minute/hour/day slots keyed by install id or
 * IP, e.g. `i:d:<installId>:<daySlot>`. Two honest caveats, both accepted for
 * anti-flooding (and both covered by the dashboard rule — see wrangler.toml):
 *  1. Fixed windows, not a true sliding window: at a bucket boundary the
 *     effective burst is up to 2x for one instant. A true sliding log costs a
 *     row per request and a count query per check; buckets are O(1) D1 writes.
 *  2. Check-then-increment races at high concurrency, slightly over-admitting.
 * Deliberately FAILS OPEN if D1 errors: ingest availability beats a perfect
 * counter, and the per-request caps still bound a single request.
 *
 * Each entry is { key, delta, expiresAt, limit, windowMs }. Day buckets count
 * RECORDS (the thing that burns storage/quota); minute buckets count REQUESTS
 * (the classic burst shape).
 */
async function checkRateLimits(env, buckets, now) {
  let rows;
  try {
    rows = await Promise.all(
      buckets.map((b) =>
        env.DB.prepare('SELECT n FROM rate_limits WHERE bucket = ?').bind(b.key).first(),
      ),
    );
  } catch (e) {
    console.warn('[rate-limit] counter read failed; allowing request:', e);
    return null;
  }
  for (let i = 0; i < buckets.length; i++) {
    const n = rows[i]?.n ?? 0;
    if (n >= buckets[i].limit) {
      const retryAfter = Math.ceil((buckets[i].windowMs - (now % buckets[i].windowMs)) / 1000);
      return json(
        429,
        { error: 'rate limited', retryAfter },
        { 'retry-after': String(retryAfter) },
      );
    }
  }
  try {
    await env.DB.batch(
      buckets.map((b) =>
        env.DB.prepare(
          `INSERT INTO rate_limits (bucket, n, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(bucket) DO UPDATE SET n = n + excluded.n`,
        ).bind(b.key, b.delta, b.expiresAt),
      ),
    );
  } catch (e) {
    console.warn('[rate-limit] counter write failed; continuing:', e);
  }
  return null;
}

const slot = (windowMs, now) => Math.floor(now / windowMs);
/** Bucket expires one full extra window late so the cron doesn't vacuum a
 *  live counter; expiry only needs "sometime after the window closed". */
const bucket = (prefix, id, windowMs, delta, limit, now) => {
  const s = slot(windowMs, now);
  return {
    key: `${prefix}:${id}:${s}`,
    delta,
    expiresAt: (s + 2) * windowMs,
    limit,
    windowMs,
  };
};

/**
 * Reads a JSON body with a hard pre-read cap (#18): reject on a declared
 * content-length above MAX_BODY_BYTES without touching the body, and again
 * after text() in case the length header was absent. Returns [body, errorResponse].
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return [null, json(413, { error: 'body too large' })];
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return [null, json(400, { error: 'unreadable body' })];
  }
  if (raw.length > MAX_BODY_BYTES) return [null, json(413, { error: 'body too large' })];
  try {
    return [JSON.parse(raw), null];
  } catch {
    return [null, json(400, { error: 'invalid JSON' })];
  }
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
 * DELETE FROM feedback WHERE expires_at < now (+ stale rate-limit buckets).
 * Called by the daily cron and lazily on the write path (defense in depth: a
 * row past its TTL must never live long even if the cron were paused).
 */
function cleanupExpired(env, now) {
  return [
    env.DB.prepare('DELETE FROM feedback WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
  ];
}

/**
 * GET /v1/export?since=<id>&limit=<n>
 * Cursor-paginated by autoincrement id (stable under concurrent inserts, which
 * a timestamp cursor would not be). Returns { rows, nextCursor, done }.
 * Expired rows are excluded: TTL is a real guarantee, not a cron convenience.
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
      WHERE id > ? AND expires_at >= ?
      ORDER BY id ASC
      LIMIT ?`,
  )
    .bind(since, Date.now(), limit)
    .all();

  const rows = results ?? [];
  return json(200, {
    rows,
    nextCursor: rows.length ? rows[rows.length - 1].id : since,
    done: rows.length < limit,
  });
}

/**
 * POST /v1/delete { installId, token? } — self-service erasure of every row
 * shared by one install (#32).
 *
 * HONEST AUTH DESIGN: there is no server-side per-install secret to verify
 * `token` against — this worker's config ships in a PUBLIC extension bundle,
 * so any secret baked in would be public, and the unauthenticated ingest
 * deliberately never issued per-install credentials. A "real" proof would be
 * security theater. Instead the route is:
 *   - rate-limited to 1 request/hour per installId (and the usual IP limits),
 *   - fully logged (Workers Logs) so wipe patterns are visible,
 *   - consequence-bounded: it can only delete rows that carry that
 *     attacker-known installId — they were already destined for expiry within
 *     90 days. InstallIds are random UUIDv4s never exposed anywhere, so an
 *     attacker must already know (or have observed) the victim's id.
 * Imperfect but honest, and better than "no erasure route". Documented in
 * PRIVACY.md "Data retention". `token` is accepted for forward compatibility
 * and currently ignored.
 */
async function handleDelete(request, env) {
  const [body, err] = await readJsonBody(request);
  if (err) return err;
  const { installId, token } = body ?? {};
  if (!isShortString(installId, 64)) return json(400, { error: 'bad installId' });
  if (token !== undefined && token !== null && !isShortString(String(token), 256)) {
    return json(400, { error: 'bad token' });
  }

  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const limited = await checkRateLimits(
    env,
    [
      bucket('del', `i:${installId}`, HOUR_MS, 1, LIMITS.deletesPerHourPerInstall, now),
      bucket('del', `p:${ip}`, HOUR_MS, 1, LIMITS.deletesPerHourPerInstall * 5, now),
    ],
    now,
  );
  if (limited) return limited;

  const result = await env.DB.prepare('DELETE FROM feedback WHERE install_id = ?')
    .bind(installId)
    .run();
  const deleted = result?.meta?.changes ?? 0;
  console.log(`[delete] installId=${installId} ip=${ip} deleted=${deleted}`);
  return json(200, { ok: true, deleted });
}

async function handleFeedback(request, env) {
  const [body, err] = await readJsonBody(request);
  if (err) return err;

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

  // Rate-limit AFTER validation so rejected junk never consumes quota.
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const limited = await checkRateLimits(
    env,
    [
      bucket('i:d', installId, DAY_MS, records.length, LIMITS.installRecordsPerDay, now),
      bucket('p:d', ip, DAY_MS, records.length, LIMITS.ipRecordsPerDay, now),
      bucket('i:m', installId, MINUTE_MS, 1, LIMITS.burstRequestsPerMinute, now),
      bucket('p:m', ip, MINUTE_MS, 1, LIMITS.burstRequestsPerMinute, now),
    ],
    now,
  );
  if (limited) return limited;

  const expiresAt = now + RETENTION_MS;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO feedback
       (install_id, ext_version, kind, title, channel, context, domain,
        model_label, score, corrected_label, model_id, ts, received_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    // Lazy TTL enforcement on the write path: a paused cron must not extend retention.
    cleanupExpired(env, now)[0],
    ...records.map((r) =>
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
        expiresAt,
      ),
    ),
  ]);

  return json(200, { ok: true, stored: records.length });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/v1/export') {
      return handleExport(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/v1/feedback') {
      return handleFeedback(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/v1/delete') {
      return handleDelete(request, env);
    }
    return json(404, { error: 'not found' });
  },

  /** Daily cron (see [triggers] in ../wrangler.toml): purge expired rows (#32). */
  async scheduled(_event, env, ctx) {
    const p = env.DB.batch(cleanupExpired(env, Date.now()));
    ctx?.waitUntil?.(p);
    await p;
  },
};
