// Local worker verification without a Cloudflare account: drives the fetch
// handler with a stubbed D1 binding. Run:  node feedback-worker/test/local-test.mjs
// (For a real local server use `npx wrangler dev` instead.)
import worker from '../src/index.js';

// ── Minimal D1 stub: records what would be inserted, and serves SELECTs from
// a fake table so the export route's pagination is exercised for real ─────────
const inserted = [];
const EXPORT_TOKEN = 'test-export-token';

// 7 fake stored rows, ids 1..7 — enough to page at limit=3.
const storedRows = Array.from({ length: 7 }, (_, i) => ({
  id: i + 1,
  install_id: `install-${i % 2}`,
  ext_version: '0.5.0',
  kind: i % 3 === 0 ? 'false_negative' : 'false_positive',
  title: `Fake page ${i + 1}`,
  channel: null,
  context: null,
  domain: 'example.com',
  model_label: 'video games',
  score: 0.6,
  corrected_label: i % 3 === 0 ? 'video games' : null,
  model_id: 'Xenova/bge-small-en-v1.5',
  ts: 1_700_000_000_000 + i,
  received_at: 1_700_000_001_000 + i,
}));

const env = {
  EXPORT_TOKEN,
  DB: {
    prepare: (sql) => ({
      bind: (...values) => ({
        sql,
        values,
        // Only the export route calls .all(); ingest uses .batch().
        all: async () => {
          const [since, limit] = values;
          return { results: storedRows.filter((r) => r.id > since).slice(0, limit) };
        },
      }),
    }),
    batch: async (stmts) => {
      inserted.push(...stmts.map((s) => s.values));
      return stmts.map(() => ({ success: true }));
    },
  },
};

let failures = 0;
async function expect(name, req, wantStatus, check) {
  const res = await worker.fetch(req, env);
  const body = await res.json().catch(() => null);
  const pass = res.status === wantStatus && (!check || check(body));
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} -> ${res.status} ${JSON.stringify(body)}`);
}

const URL_BASE = 'https://smartblocker-feedback.example.workers.dev';
const post = (body) =>
  new Request(`${URL_BASE}/v1/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

const rows = inserted.length;
console.log(`${rows === 2 ? 'PASS' : 'FAIL'} exactly the 2 valid batches inserted (got ${rows})`);
if (rows !== 2) failures++;

// ── Export route ────────────────────────────────────────────────────────────
// The table holds users' page titles, so every unauthorized shape must be
// rejected before anything is read.
console.log('\n-- export route --');
const get = (qs = '', token) =>
  new Request(`${URL_BASE}/v1/export${qs}`, {
    method: 'GET',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

await expect('export without token rejected', get(''), 401);
await expect('export with wrong token rejected', get('', 'nope'), 401);
await expect('export with short token rejected', get('', 'test'), 401);
await expect(
  'export with valid token returns rows',
  get('', EXPORT_TOKEN),
  200,
  (b) => Array.isArray(b.rows) && b.rows.length === 7 && b.done === true && b.nextCursor === 7,
);
await expect(
  'export paginates by id cursor',
  get('?limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 3 && b.rows[0].id === 1 && b.nextCursor === 3 && b.done === false,
);
await expect(
  'export resumes from cursor',
  get('?since=3&limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 3 && b.rows[0].id === 4 && b.nextCursor === 6 && b.done === false,
);
await expect(
  'export final page reports done',
  get('?since=6&limit=3', EXPORT_TOKEN),
  200,
  (b) => b.rows.length === 1 && b.done === true,
);
await expect('export rejects bad cursor', get('?since=-1', EXPORT_TOKEN), 400);
await expect('export POST is still 404', new Request(`${URL_BASE}/v1/export`, { method: 'POST' }), 404);

// An unconfigured deploy must fail closed, not serve titles openly.
{
  const res = await worker.fetch(get('', EXPORT_TOKEN), { ...env, EXPORT_TOKEN: undefined });
  const pass = res.status === 503;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} export without EXPORT_TOKEN configured fails closed -> ${res.status}`);
}

process.exitCode = failures ? 1 : 0;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
