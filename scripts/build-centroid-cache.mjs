// Builds src/shared/seed-centroid-vectors.json — the precomputed base seed
// embeddings that let a fresh install skip the ~30s first-classification
// centroid rebuild.
//
// Vectors are produced by the REAL Chromium/WASM runtime through the
// extension's offscreen EMBED path (not Node's native ORT), so they match the
// query embeddings the shipped classifier computes. Regenerate after any seed
// or model-revision change, then run scripts/centroid-asset-test.mjs (it fails
// if the asset is stale).
//
//   npm run build:chrome && node scripts/build-centroid-cache.mjs
//
// The profile (default .e2e-centroid-profile, override with SB_E2E_PROFILE)
// keeps the downloaded model between regenerations.
import { chromium } from 'playwright';
import { mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EMBED_MODEL_ID, EMBED_MODEL_REVISION, LABELS } from '../src/shared/config.ts';
import { centroidSpecs } from '../src/shared/prototypes.ts';
import { hashSeedText } from '../src/shared/prototype-cache.ts';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve(process.env.SB_E2E_PROFILE ?? '.e2e-centroid-profile');
const OUT = resolve('src/shared/seed-centroid-vectors.json');
const BATCH = 16;
const MODEL_TIMEOUT_MS = 10 * 60_000;

mkdirSync(PROFILE, { recursive: true });
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });
rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });

function clearStaleSingleton(dir) {
  const lock = resolve(dir, 'SingletonLock');
  try {
    const target = readlinkSync(lock);
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
      return;
    } catch {
      // dead owner
    }
    rmSync(lock, { force: true });
    rmSync(resolve(dir, 'SingletonCookie'), { force: true });
    rmSync(resolve(dir, 'SingletonSocket'), { force: true });
  } catch {
    // no lock
  }
}

async function launch() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    clearStaleSingleton(PROFILE);
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      timeout: 60_000,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let sw = ctx.serviceWorkers()[0];
    if (!sw) {
      const event = ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      sw = ctx.serviceWorkers()[0] ?? (await event);
      await waker.close();
    }
    if (sw) return { ctx, sw };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    rmSync(resolve(PROFILE, 'Default/Service Worker/Database'), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('service worker did not boot');
}

const specs = centroidSpecs([...LABELS], {});
const unique = [...new Set(specs.flatMap((spec) => spec.texts))];
console.log(`building seed vectors for ${unique.length} unique texts across ${specs.length} centroids`);

const { ctx, sw } = await launch();
try {
  const vectorsByName = await sw.evaluate(
    async ({ texts, batch, timeoutMs }) => {
      if (typeof chrome.offscreen?.hasDocument !== 'function') {
        throw new Error('chrome.offscreen is unavailable in this browser');
      }
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Precompute the shipped classifier seed embeddings.',
        });
      }
      const out = [];
      const started = Date.now();
      for (let i = 0; i < texts.length; i += batch) {
        const slice = texts.slice(i, i + batch);
        let lastError = 'no response';
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'EMBED', texts: slice });
            if (res && Array.isArray(res.vectors) && res.vectors.length === slice.length) {
              out.push(...res.vectors);
              done = true;
            } else {
              lastError = res?.error ?? 'malformed EMBED response';
            }
          } catch (e) {
            lastError = String(e?.message ?? e);
          }
          if (!done && Date.now() - started > timeoutMs) {
            throw new Error(`EMBED timed out: ${lastError}`);
          }
        }
        if (!done) throw new Error(`EMBED failed for batch ${i / batch}: ${lastError}`);
        if ((i / batch) % 8 === 0) {
          console.log(`  … ${Math.min(i + batch, texts.length)}/${texts.length}`);
        }
      }
      return out;
    },
    { texts: unique, batch: BATCH, timeoutMs: MODEL_TIMEOUT_MS },
  );

  if (vectorsByName.length !== unique.length) {
    throw new Error(`got ${vectorsByName.length} vectors for ${unique.length} texts`);
  }
  const dim = vectorsByName[0]?.length;
  if (!dim || vectorsByName.some((v) => v.length !== dim)) {
    throw new Error(`inconsistent embedding dimensions (expected ${dim})`);
  }

  const vectorByText = new Map(unique.map((text, i) => [text, vectorsByName[i]]));
  const encode = (vec) => {
    const f = new Float32Array(vec);
    return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
  };

  const byName = {};
  for (const spec of specs) {
    byName[spec.name] = {
      hashes: spec.texts.map(hashSeedText),
      vectors: spec.texts.map((text) => encode(vectorByText.get(text))),
    };
  }

  const asset = {
    format: 1,
    modelId: EMBED_MODEL_ID,
    modelRevision: EMBED_MODEL_REVISION,
    dim,
    byName,
  };
  writeFileSync(OUT, `${JSON.stringify(asset)}\n`);
  console.log(
    `wrote ${OUT} (${(JSON.stringify(asset).length / 1024 / 1024).toFixed(2)} MB, dim ${dim})`,
  );
} finally {
  await ctx.close();
}
