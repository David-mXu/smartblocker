// Local worker verification without a Cloudflare account: drives the fetch
// and scheduled handlers with a stubbed D1 binding. Run:
//   node feedback-worker/test/local-test.mjs        (or: cd feedback-worker && npm test)
// (For a real local server use `npx wrangler dev` instead.)
import worker from '../src/index.js';

// ── Minimal D1 stub: actually keeps a fake `feedback` table and a `rate_limits`
// map so ingest inserts, TTL deletes/lazy-purges, rate-limit counters, the
// delete route, cron cleanup and export pagination all run against real state ─
const EXPORT_TOKEN = 'test-export-token';
const DAY = 86_400_000;
const FUTURE = 4_000_000_000_000; // ~2096: unexpired rows in seeds
const PAST = 1_600_000_000_000; // 2020: expired rows in seeds

let fakeId = 100;
const seedRow = (over = {}) => ({
  id: ++fakeId,
  install_id: 'seed-install',
  ext_version: '0.5.0',
  kind: 'false_positive',
  title: 'Seeded page',
  channel: null,
  context: null,
  domain: 'example.com',
  model_label: 'video games',
  score: 0.6,
  corrected_label: null,
  model_id: 'Xenova/bge-small-en-v1.5',
  ts: 1_700_000_000_000 + fakeId,
  received_at: 1_700_000_001_000 + fakeId,
  expires_at: FUTURE,
  ...over,
});

// 7 fixed rows, ids 1..7 — enough to page at limit=3 (export cursor tests).
const storedRows = Array.from({ length: 7 }, (_, i) =>
  seedRow({
    id: i + 1,
    install_id: `install-${i % 2}`,
    kind: i % 3 === 0 ? 'false_negative' : 'false_positive',
    title: `Fake page ${i + 1}`,
    corrected_label: i % 3 === 0 ? 'video games' : null,
    ts: 1_700_000_000_000 + i,
    received_at: 1_700_000_001_000 + i,
  }),
);
fakeId = 100;

function createEnv({ feedback = [], rate = new Map(), token = EXPORT_TOKEN, failRateReads = false } = {}) {
  const table = [...feedback];
  const buckets = new Map(rate); // key -> { n, expires_at }
  const inserted = [];
  let nextId = table.reduce((m, r) => Math.max(m, r.id), 0);

  const exec = (sql, values) => {
    if (sql.startsWith('INSERT OR IGNORE INTO feedback')) {
      const cols = [
        'install_id', 'ext_version', 'kind', 'title', 'channel', 'context', 'domain',
        'model_label', 'score', 'corrected_label', 'model_id', 'ts', 'received_at', 'expires_at',
      ];
      const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
      // Honor UNIQUE (install_id, ts, kind, title) — INSERT OR IGNORE.
      const dup = table.some(
        (e) => e.install_id === row.install_id && e.ts === row.ts && e.kind === row.kind && e.title === row.title,
      );
      if (dup) return { meta: { changes: 0 }, success: true };
      row.id = ++nextId;
      table.push(row);
      inserted.push(row);
      return { meta: { changes: 1 }, success: true };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM feedback')) {
      const [since, nowMs, limit] = values;
      // Mirror the route's explicit column list: expires_at stays server-side.
      const COLS = [
        'id', 'install_id', 'ext_version', 'kind', 'title', 'channel', 'context', 'domain',
        'model_label', 'score', 'corrected_label', 'model_id', 'ts', 'received_at',
      ];
      return {
        results: table
          .filter((r) => r.id > since && r.expires_at >= nowMs)
          .slice(0, limit)
          .map((r) => Object.fromEntries(COLS.map((c) => [c, r[c]]))),
      };
    }
    if (sql.startsWith('DELETE FROM feedback WHERE expires_at')) {
      const before = table.length;
      for (let i = table.length - 1; i >= 0; i--) {
        if (table[i].expires_at < values[0]) table.splice(i, 1);
      }
      return { meta: { changes: before - table.length }, success: true };
    }
    if (sql.startsWith('DELETE FROM feedback WHERE install_id')) {
      const before = table.length;
      for (let i = table.length - 1; i >= 0; i--) {
        if (table[i].install_id === values[0]) table.splice(i, 1);
      }
      return { meta: { changes: before - table.length }, success: true };
    }
    if (sql.startsWith('SELECT n FROM rate_limits')) {
      if (failRateReads) throw new Error('D1 read outage (simulated)');
      const row = buckets.get(values[0]);
      return row ? { n: row.n } : null;
    }
    if (sql.startsWith('INSERT INTO rate_limits')) {
      const [key, delta, expires_at] = values;
      const cur = buckets.get(key) ?? { n: 0 };
      buckets.set(key, { n: cur.n + delta, expires_at });
      return { meta: { changes: 1 }, success: true };
    }
    if (sql.startsWith('DELETE FROM rate_limits')) {
      let changes = 0;
      for (const [k, v] of [...buckets]) {
        if (v.expires_at < values[0]) {
          buckets.delete(k);
          changes++;
        }
      }
      return { meta: { changes }, success: true };
    }
    throw new Error(`fakeD1: unstubbed SQL: ${sql}`);
  };

  const env = {
    EXPORT_TOKEN: token,
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          sql,
          values,
          all: async () => {
            const r = exec(sql, values);
            return r?.results ? r : { results: [] };
          },
          first: async () => {
            const r = exec(sql, values);
            return r && !r.results && !r.meta ? r : null;
          },
          run: async () => exec(sql, values),
        }),
      }),
      batch: async (stmts) => stmts.map((s) => exec(s.sql, s.values)),
    },
    // Test handles into the fake backend:
    _table: table,
    _buckets: buckets,
    _inserted: inserted,
    _rate: (key) => buckets.get(key)?.n ?? 0,
  };
  return env;
}

let failures = 0;
async function expect(name, req, wantStatus, check, env = mainEnv) {
  const res = await worker.fetch(req, env);
  const body = await res.json().catch(() => null);
  const pass = res.status === wantStatus && (!check || check(body, res));
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} -> ${res.status} ${JSON.stringify(body)}`);
}
function check(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

const URL_BASE = 'https://smartblocker-feedback.example.workers.dev';
const post = (body, { ip } = {}) =>
  new Request(`${URL_BASE}/v1/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
    },
    body: JSON.stringify(body),
  });
const del = (body, { ip } = {}) =>
  new Request(`${URL_BASE}/v1/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    body: JSON.stringify(body),
  });

const goodRecord = {
  kind: 'false_positive',
  title: 'Rust ownership explained',
  domain: 'youtube.com',
  modelLabel: 'video games',
  score: 0.61,
  modelId: 'Xenova/bge-small-en-v1.5',
  ts: Date.now(),
};

// ── Main env: 7 export rows + 1 expired row (id 8) for TTL/export tests ─────
const EXPIRED_ROW = seedRow({ id: 8, install_id: 'install-0', title: 'Expired page', expires_at: PAST });
const mainEnv = createEnv({ feedback: [...storedRows, EXPIRED_ROW] });

await expect('CORS preflight', new Request(`${URL_BASE}/v1/feedback`, { method: 'OPTIONS' }), 204);
await expect('unknown route 404', new Request(`${URL_BASE}/nope`, { method: 'POST' }), 404);
await expect('invalid JSON 400', new Request(`${URL_BASE}/v1/feedback`, { method: 'POST', body: '{' }), 400);
await expect(
  'valid FP batch stored',
  post({ installId: 'test-install-1', extVersion: '0.4.0', records: [goodRecord] }),
  200,
  (b) => b.ok && b.stored === 1,
);
await expect(
  'valid FN batch stored',
  post({
    installId: 'test-install-1',
    extVersion: '0.4.0',
    records: [
      {
        ...goodRecord,
        kind: 'false_negative',
        correctedLabel: 'video games',
        modelLabel: 'neutral: documentation and reference',
      },
    ],
  }),
  200,
  (b) => b.ok && b.stored === 1,
);
await expect(
  'FN without correctedLabel rejected',
  post({ installId: 'i', extVersion: '1', records: [{ ...goodRecord, kind: 'false_negative' }] }),
  400,
);
await expect(
  'missing installId rejected',
  post({ extVersion: '1', records: [goodRecord] }),
  400,
);
await expect(
  'oversize batch rejected',
  post({ installId: 'i', extVersion: '1', records: Array(101).fill(goodRecord) }),
  400,
);
await expect(
  'bad score rejected',
  post({ installId: 'i', extVersion: '1', records: [{ ...goodRecord, score: 'high' }] }),
  400,
);

check(
  'exactly the 2 valid batches inserted',
  mainEnv._inserted.length === 2,
  `got ${mainEnv._inserted.length}`,
);

// ── Retention / TTL (#32) ───────────────────────────────────────────────────
console.log('\n-- retention (#32) --');
check(
  'every inserted row stamped expires_at = received_at + 90 days',
  mainEnv._inserted.every((r) => r.expires_at - r.received_at === 90 * DAY),
  mainEnv._inserted.map((r) => r.expires_at - r.received_at).join(','),
);
check(
  'lazy delete on write purged the expired seed row',
  !mainEnv._table.some((r) => r.expires_at === PAST) && mainEnv._table.length >= 8,
  `table=${mainEnv._table.length}`,
);

// ── Body cap (#18) ──────────────────────────────────────────────────────────
console.log('\n-- body cap (#18) --');
{
  // Declared-over-cap content-length must 413 WITHOUT reading the body.
  let bodyRead = false;
  const fakeReq = {
    method: 'POST',
    url: `${URL_BASE}/v1/feedback`,
    headers: { get: (k) => (k === 'content-length' ? String(400 * 1024) : null) },
    text: async () => {
      bodyRead = true;
      return '{}';
    },
  };
  const res = await worker.fetch(fakeReq, mainEnv);
  check('declared oversize body 413 before reading', res.status === 413 && !bodyRead, `status=${res.status} read=${bodyRead}`);
}
{
  // No/lying length header but an actually-huge body: 413 after text(), before parse.
  const huge = `"${'a'.repeat(390 * 1024)}"`;
  const fakeReq = {
    method: 'POST',
    url: `${URL_BASE}/v1/feedback`,
    headers: { get: () => null },
    text: async () => huge,
  };
  const res = await worker.fetch(fakeReq, mainEnv);
  check('undeclared oversize body 413 after read', res.status === 413, `status=${res.status}`);
}

// ── Rate limits (#18) ───────────────────────────────────────────────────────
console.log('\n-- rate limits (#18) --');
const daySlot = Math.floor(Date.now() / DAY);
const minSlot = Math.floor(Date.now() / 60_000);
const bucketRow = (n) => ({ n, expires_at: FUTURE });

const isRetryAfter = (body, res) => {
  const h = Number(res.headers.get('retry-after'));
  return Number.isFinite(h) && h >= 1 && h <= 86400 && body.retryAfter === h;
};

{
  const env = createEnv({ rate: new Map([[`i:d:over-install:${daySlot}`, bucketRow(100)]]) });
  await expect(
    'install at 100 records/day gets 429 + Retry-After',
    post({ installId: 'over-install', extVersion: '1', records: [goodRecord] }),
    429,
    isRetryAfter,
    env,
  );
  check('429 left nothing inserted', env._inserted.length === 0);
}
{
  const ip = '203.0.113.9';
  const env = createEnv({ rate: new Map([[`p:d:${ip}:${daySlot}`, bucketRow(300)]]) });
  await expect(
    'IP at 300 records/day gets 429',
    post({ installId: 'fresh-install', extVersion: '1', records: [goodRecord] }, { ip }),
    429,
    isRetryAfter,
    env,
  );
}
{
  const env = createEnv({ rate: new Map([[`i:m:bursty:${minSlot}`, bucketRow(10)]]) });
  await expect(
    'install at 10 req/min burst gets 429 (retry ≤ 60s)',
    post({ installId: 'bursty', extVersion: '1', records: [goodRecord] }),
    429,
    (b, res) => isRetryAfter(b, res) && Number(res.headers.get('retry-after')) <= 60,
    env,
  );
}
{
  const ip = '203.0.113.10';
  const env = createEnv({ rate: new Map([[`p:m:${ip}:${minSlot}`, bucketRow(10)]]) });
  await expect(
    'IP at 10 req/min burst gets 429',
    post({ installId: 'fresh-install', extVersion: '1', records: [goodRecord] }, { ip }),
    429,
    isRetryAfter,
    env,
  );
}
{
  // Counters track new traffic: 3-record batch adds 3 to day buckets, 1 to minute buckets.
  const ip = '203.0.113.11';
  const env = createEnv();
  await expect(
    'under-limit batch counts records per day, requests per minute',
    post({ installId: 'counter-install', extVersion: '1', records: [goodRecord, goodRecord, { ...goodRecord, ts: goodRecord.ts + 1 }] }, { ip }),
    200,
    (b) => b.stored === 3,
    env,
  );
  check(
    'day buckets +=3, minute buckets +=1 (install and IP)',
    env._rate(`i:d:counter-install:${daySlot}`) === 3 &&
      env._rate(`p:d:${ip}:${daySlot}`) === 3 &&
      env._rate(`i:m:counter-install:${minSlot}`) === 1 &&
      env._rate(`p:m:${ip}:${minSlot}`) === 1,
  );
}
{
  // Rate-limit backend outage must fail OPEN (ingest availability), not take
  // the endpoint down — the per-request caps still bound one request.
  const env = createEnv();
  env.DB.prepare = ((orig) => (sql) => {
    if (sql.startsWith('SELECT n FROM rate_limits')) throw new Error('outage');
    return orig(sql);
  })(env.DB.prepare);
  await expect(
    'counter outage fails open (200)',
    post({ installId: 'resilient', extVersion: '1', records: [goodRecord] }),
    200,
    (b) => b.ok,
    env,
  );
  check('insert still happened during outage', env._inserted.length === 1);
}
check(
  'main-env rejected junk (400s) never consumed install-day quota',
  mainEnv._rate(`i:d:test-install-1:${daySlot}`) === 2,
  `got ${mainEnv._rate(`i:d:test-install-1:${daySlot}`)}`,
);

// ── Self-service delete route (#32) ─────────────────────────────────────────
console.log('\n-- delete route (#32) --');
{
  const ip = '203.0.113.20';
  const env = createEnv({
    feedback: [
      seedRow({ install_id: 'victim-install', title: 'Mine 1' }),
      seedRow({ install_id: 'victim-install', title: 'Mine 2' }),
      seedRow({ install_id: 'other-install', title: 'Not mine' }),
    ],
  });
  await expect(
    'delete removes every row of the install, spares others',
    del({ installId: 'victim-install', token: 'forward-compat' }, { ip }),
    200,
    (b) => b.ok && b.deleted === 2,
    env,
  );
  check(
    'only the victim rows are gone',
    env._table.length === 1 && env._table[0].install_id === 'other-install',
  );
  await expect(
    'second delete within the hour is 429',
    del({ installId: 'victim-install' }, { ip }),
    429,
    isRetryAfter,
    env,
  );
  await expect('delete without installId is 400', del({}, { ip }), 400, undefined, env);
  await expect(
    'delete with overlong token is 400',
    del({ installId: 'x', token: 't'.repeat(300) }, { ip }),
    400,
    undefined,
    env,
  );
  await expect(
    'GET on the delete route is 404',
    new Request(`${URL_BASE}/v1/delete`, { method: 'GET' }),
    404,
    undefined,
    env,
  );
  check(
    'per-IP delete budget consumed exactly once (429s and 400s not counted)',
    env._rate(`del:p:${ip}:${Math.floor(Date.now() / 3_600_000)}`) === 1,
  );
}

// ── Cron cleanup (#32) ──────────────────────────────────────────────────────
console.log('\n-- cron cleanup (#32) --');
{
  const env = createEnv({
    feedback: [
      seedRow({ title: 'Old and expired', expires_at: PAST }),
      seedRow({ title: 'Fresh', expires_at: FUTURE }),
    ],
    rate: new Map([
      ['i:d:stale:1', { n: 7, expires_at: PAST }],
      [`i:d:live:${daySlot}`, { n: 2, expires_at: FUTURE }],
    ]),
  });
  await worker.scheduled({}, env, undefined);
  check(
    'scheduled() purges expired feedback, keeps fresh rows',
    env._table.length === 1 && env._table[0].title === 'Fresh',
  );
  check(
    'scheduled() purges stale rate-limit buckets, keeps live ones',
    env._buckets.size === 1 && env._rate(`i:d:live:${daySlot}`) === 2,
  );
}

// ── Export route ────────────────────────────────────────────────────────────
// The table holds users' page titles, so every unauthorized shape must be
// rejected before anything is read. Isolated env: 7 fresh seeds + 1 expired
// row (id 8), untouched by the ingest tests above.
console.log('\n-- export route --');
const exportEnv = createEnv({ feedback: [...storedRows, EXPIRED_ROW] });
const get = (qs = '', token) =>
  new Request(`${URL_BASE}/v1/export${qs}`, {
    method: 'GET',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

await expect('export without token rejected', get(''), 401, undefined, exportEnv);
await expect('export with wrong token rejected', get('', 'nope'), 401, undefined, exportEnv);
await expect('export with short token rejected', get('', 'test'), 401, undefined, exportEnv);
await expect(
  'export with valid token returns rows (expired row excluded)',
  get('', EXPORT_TOKEN),
  200,
  (b) =>
    Array.isArray(b.rows) &&
    b.rows.length === 7 &&
    !b.rows.some((r) => r.title === 'Expired page') &&
    b.done === true &&
    b.nextCursor === 7,
  exportEnv,
);
await expect(
  'export paginates by id cursor',
  get('?limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 3 && b.rows[0].id === 1 && b.nextCursor === 3 && b.done === false,
  exportEnv,
);
await expect(
  'export resumes from cursor',
  get('?since=3&limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 3 && b.rows[0].id === 4 && b.nextCursor === 6 && b.done === false,
  exportEnv,
);
await expect(
  'export final page skips expired id 8 and reports done',
  get('?since=6&limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 1 && b.rows[0].id === 7 && b.done === true,
  exportEnv,
);
await expect('export rejects bad cursor', get('?since=-1', EXPORT_TOKEN), 400, undefined, exportEnv);
await expect(
  'export POST is still 404',
  new Request(`${URL_BASE}/v1/export`, { method: 'POST' }),
  404,
  undefined,
  exportEnv,
);
{
  // Consumer contract: scripts/import-feedback.mjs maps exactly these snake_case
  // columns. expires_at intentionally stays server-side (not in the row shape).
  const res = await worker.fetch(get('?limit=1', EXPORT_TOKEN), exportEnv);
  const b = await res.json();
  const keys = Object.keys(b.rows[0]).sort().join(',');
  const expected = [
    'channel', 'context', 'corrected_label', 'domain', 'ext_version', 'id', 'install_id',
    'kind', 'model_id', 'model_label', 'received_at', 'score', 'title', 'ts',
  ].sort().join(',');
  check('export row columns unchanged for import-feedback.mjs', keys === expected, keys);
}

// An unconfigured deploy must fail closed, not serve titles openly.
{
  const res = await worker.fetch(get('', EXPORT_TOKEN), createEnv({ token: null, feedback: storedRows }));
  const pass = res.status === 503;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} export without EXPORT_TOKEN configured fails closed -> ${res.status}`);
}

process.exitCode = failures ? 1 : 0;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
