// Local worker verification without a Cloudflare account: drives the fetch
// handler with a stubbed D1 binding. Run:  node feedback-worker/test/local-test.mjs
// (For a real local server use `npx wrangler dev` instead.)
import worker from '../src/index.js';

// ── Minimal D1 stub: records what would be inserted ──────────────────────────
const inserted = [];
const env = {
  DB: {
    prepare: (sql) => ({
      bind: (...values) => ({ sql, values }),
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

const URL_BASE = 'https://flowguard-feedback.example.workers.dev';
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

process.exitCode = failures ? 1 : 0;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
