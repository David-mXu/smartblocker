// P2 security e2e (red-team 2026-11-05):
//   #21 — password-lock KDF upgrade (PBKDF2-SHA256 v2 + legacy migration)
//   #19 — Hugging Face model revision pin
//
// Usage: node scripts/e2e-p2-kdf-modelpin.mjs   (requires a built dist/chrome)
// Profile (and the cached model) persists in .e2e-profile-p2/ across runs.
//
// v2 hash format note: the stored `passwordHash` stays a bare 64-hex string —
// the daemon sanitizes it as ^[0-9a-f]{64}$ and merges it opaquely, so no
// scheme marker may be embedded in it. The "v2 marker" asserted below is the
// separate `lockKdf` storage entry ({ v: 2, salt, iterations }), which lives
// outside the merged lockState CRDT (companion.ts only forwards 'lockState').
import { chromium } from 'playwright';
import { readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.e2e-profile-p2');
const MODEL_TIMEOUT_MS = 5 * 60_000; // first run downloads the model (~35MB)
const PASSWORD = 'correct horse battery'; // new arms require >= 8 chars
const LEGACY_PASSWORD = 'horsepassword';

// Expected pins come from the source of truth so this test self-syncs.
const cfg = readFileSync(resolve('src/shared/config.ts'), 'utf8');
const EMBED_MODEL_REVISION = cfg.match(/EMBED_MODEL_REVISION = '([0-9a-f]{40})'/)?.[1];
const MODEL_REVISION = cfg.match(/MODEL_REVISION = '([0-9a-f]{40})'/)?.[1];

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  if (!ok) failures = 1;
}

// Chromium caches the MV3 service-worker SCRIPT in the profile — drop only
// ScriptCache; CacheStorage (the downloaded model) must survive across runs.
rmSync(resolve(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let worker = ctx.serviceWorkers()[0];
    if (!worker) {
      const swPromise = ctx.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
      const waker = await ctx.newPage();
      await waker.goto('https://example.com').catch(() => {});
      worker = ctx.serviceWorkers()[0] ?? (await swPromise);
      await waker.close();
    }
    if (worker) return { context: ctx, sw: worker };
    console.log(`… extension did not load (attempt ${attempt}), relaunching`);
    await ctx.close();
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('service worker did not boot after 3 launches');
}

async function poll(fn, { timeout = 20_000, interval = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const { context, sw } = await launchWithServiceWorker();

try {
  console.log('PASS service worker booted:', sw.url());
  const extensionId = new URL(sw.url()).host;
  sw.on('console', (msg) => console.log('  [sw]', msg.text()));

  const readLock = () =>
    sw.evaluate(() =>
      chrome.storage.local
        .get(['lockState', 'lockKdf'])
        .then((o) => ({ lockState: o.lockState ?? null, lockKdf: o.lockKdf ?? null })),
    );

  // Reset lock state that leaks across runs of the persistent profile.
  await sw.evaluate(() => chrome.storage.local.remove(['lockState', 'lockKdf']));

  const opts = await context.newPage();
  const openOptions = async () => {
    await opts.goto(`chrome-extension://${extensionId}/options.html#locks`);
    await opts.waitForSelector('#lock-password');
    await opts.waitForTimeout(1_200); // applyLockUI runs at load + 1s tick
  };

  // ---- (a) new arm via the real UI path → v2 format --------------------------
  await openOptions();
  await opts.fill('#lock-password', PASSWORD);
  await opts.click('#lock-password-btn');
  const armed = await poll(async () => {
    const { lockState } = await readLock();
    return typeof lockState?.passwordHash === 'string' ? readLock() : null;
  });
  const armKdf = armed?.lockKdf;
  const armHash = armed?.lockState?.passwordHash ?? '';
  const saltOk = typeof armKdf?.salt === 'string' && /^[0-9a-f]{32}$/.test(armKdf.salt);
  check(
    'arm stores a bare 64-hex passwordHash (opaque to the daemon CRDT)',
    /^[0-9a-f]{64}$/.test(armHash),
  );
  check(
    'arm writes lockKdf v2 with a 16-byte random salt and 210k iterations (the v2 marker)',
    armKdf?.v === 2 && armKdf?.iterations === 210_000 && saltOk,
    JSON.stringify(armKdf),
  );
  // The salt must NEVER live inside the merged lockState CRDT.
  const lockStateKeys = Object.keys(armed?.lockState ?? {}).sort();
  check(
    'lockState carries no salt/KDF fields (lockKdf stays out of lockStateSync)',
    lockStateKeys.every((k) =>
      ['timerUntil', 'passwordHash', 'passwordTs', 'frozenUntil', 'schedules', 'schedulesUpdatedAt'].includes(k),
    ),
    `keys=${lockStateKeys}`,
  );
  // Cross-check the v2 hash with an independent in-page PBKDF2 computation,
  // and confirm it is NOT the legacy single-SHA-256 value.
  const hashes = await sw.evaluate(
    async ([pw, salt, iter]) => {
      const hex = (buf) =>
        [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const legacy = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('smartblocker-lock:' + pw),
      );
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode('smartblocker-lock:' + pw),
        'PBKDF2',
        false,
        ['deriveBits'],
      );
      const saltBytes = new Uint8Array(salt.match(/../g).map((h) => parseInt(h, 16)));
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter },
        key,
        256,
      );
      return { legacy: hex(legacy), v2: hex(bits) };
    },
    [PASSWORD, armKdf?.salt ?? '', armKdf?.iterations ?? 0],
  );
  check(
    'stored hash equals PBKDF2-SHA256(pw, salt, 210k) and differs from legacy SHA-256',
    armHash === hashes.v2 && armHash !== hashes.legacy,
  );

  // ---- (c) wrong password fails ----------------------------------------------
  await openOptions();
  await opts.fill('#lock-password', 'totally-wrong-1');
  await opts.click('#lock-password-btn');
  await opts.waitForFunction(
    () => document.getElementById('lock-password-msg')?.textContent?.includes('Wrong password'),
    { timeout: 10_000 },
  );
  const afterWrong = await readLock();
  check(
    'wrong password rejected; armed v2 hash untouched',
    afterWrong.lockState?.passwordHash === armHash,
  );

  // ---- (d) salt binding: the same v2 hash under a different salt fails -------
  // (Cryptographically identical to copying the hash to a fresh profile whose
  // lockKdf salt differs: PBKDF2(pw, otherSalt) != stored hash.)
  await sw.evaluate(() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return chrome.storage.local.set({ lockKdf: { salt, iterations: 210_000, v: 2 } });
  });
  await openOptions();
  await opts.fill('#lock-password', PASSWORD);
  await opts.click('#lock-password-btn');
  await opts.waitForFunction(
    () => document.getElementById('lock-password-msg')?.textContent?.includes('Wrong password'),
    { timeout: 15_000 },
  );
  const afterSwap = await readLock();
  check(
    'v2 hash + foreign salt does NOT verify (hash still armed, salt not accepted)',
    afterSwap.lockState?.passwordHash === armHash && afterSwap.lockKdf?.salt !== armKdf.salt,
  );
  // Restore the real salt and unlock for the next phase (proves recovery).
  await sw.evaluate((kdf) => chrome.storage.local.set({ lockKdf: kdf }), armKdf);
  await openOptions();
  await opts.fill('#lock-password', PASSWORD);
  await opts.click('#lock-password-btn');
  const unlocked = await poll(async () => ((await readLock()).lockState?.passwordHash === null ? true : null));
  check('unlock with the correct salt succeeds again', unlocked === true);
  await sw.evaluate(() => chrome.storage.local.remove(['lockState', 'lockKdf']));

  // ---- min length: 8 for NEW arms (legacy short passwords still unlock) ------
  await openOptions();
  await opts.fill('#lock-password', 'shortpw'); // 7 chars — would pass the old min of 4
  await opts.click('#lock-password-btn');
  await opts.waitForFunction(
    () => document.getElementById('lock-password-msg')?.textContent?.includes('at least 8'),
    { timeout: 10_000 },
  );
  const afterShort = await readLock();
  check('7-char new arm refused with a min-8 hint; nothing armed', !afterShort.lockState?.passwordHash);

  // ---- (b) legacy v1 lock migrates to v2 on successful verify -----------------
  // Seed exactly the pre-upgrade format the red-team PoCs mirror:
  // sha256('smartblocker-lock:' + pw) inside lockState, no lockKdf anywhere.
  const legacySeed = await sw.evaluate(async (pw) => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('smartblocker-lock:' + pw),
    );
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const seedTs = Date.now() - 60_000;
    await chrome.storage.local.set({
      lockState: {
        timerUntil: null,
        passwordHash: hash,
        passwordTs: seedTs,
        frozenUntil: null,
        schedules: [],
        schedulesUpdatedAt: 0,
      },
    });
    await chrome.storage.local.remove('lockKdf');
    return { hash, seedTs };
  }, LEGACY_PASSWORD);
  // Record every storage write the unlock flow performs (the migration writes
  // lockKdf + a v2 lockState BEFORE the unlock tombstone clears the hash).
  await sw.evaluate(() => {
    globalThis.__kdfEvents = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const e = {};
      if (changes.lockState) e.lockState = changes.lockState.newValue;
      if (changes.lockKdf) e.lockKdf = changes.lockKdf.newValue;
      globalThis.__kdfEvents.push(e);
    });
  });
  await openOptions();
  await opts.fill('#lock-password', LEGACY_PASSWORD);
  await opts.click('#lock-password-btn'); // armed → Unlock (runs the real verify path)
  const migratedUnlock = await poll(
    async () => ((await readLock()).lockState?.passwordHash === null ? true : null),
  );
  check('legacy-armed lock unlocks with the legacy password', migratedUnlock === true);

  const events = await sw.evaluate(() => globalThis.__kdfEvents);
  const v2Rearm = events.find(
    (e) =>
      typeof e.lockState?.passwordHash === 'string' &&
      /^[0-9a-f]{64}$/.test(e.lockState.passwordHash) &&
      e.lockState.passwordHash !== legacySeed.hash,
  );
  const legacyRearm = events.find((e) => e.lockState?.passwordHash === legacySeed.hash);
  const kdfWrite = events.find((e) => e.lockKdf?.v === 2);
  const finalKdf = (await readLock()).lockKdf;
  check(
    'legacy verify transparently re-armed a v2 hash before the unlock tombstone',
    Boolean(v2Rearm) && !legacyRearm && Boolean(kdfWrite),
  );
  check(
    'migration wrote lockKdf v2 (16-byte salt) + a fresh passwordTs that beats the seed',
    typeof finalKdf?.salt === 'string' &&
      /^[0-9a-f]{32}$/.test(finalKdf.salt) &&
      finalKdf?.iterations === 210_000 &&
      (v2Rearm?.lockState?.passwordTs ?? 0) > legacySeed.seedTs,
  );
  // The migrated hash must really be PBKDF2 of the legacy password under the
  // new salt — not a re-stamped legacy value.
  if (v2Rearm && finalKdf?.salt) {
    const migratedV2 = await sw.evaluate(
      async ([pw, salt, iter]) => {
        const hex = (buf) =>
          [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode('smartblocker-lock:' + pw),
          'PBKDF2',
          false,
          ['deriveBits'],
        );
        const saltBytes = new Uint8Array(salt.match(/../g).map((h) => parseInt(h, 16)));
        const bits = await crypto.subtle.deriveBits(
          { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter },
          key,
          256,
        );
        return hex(bits);
      },
      [LEGACY_PASSWORD, finalKdf.salt, finalKdf.iterations],
    );
    check(
      'migrated hash equals PBKDF2-SHA256(legacy pw, new salt) — one-way upgrade',
      v2Rearm.lockState.passwordHash === migratedV2 && migratedV2 !== legacySeed.hash,
    );
  }

  // Restore state so the next run of the persistent profile starts clean.
  await sw.evaluate(() => chrome.storage.local.remove(['lockState', 'lockKdf']));
  await opts.close();

  // ---- (e) model revision pin (#19) -------------------------------------------
  check(
    'config.ts exports 40-hex EMBED_MODEL_REVISION and MODEL_REVISION',
    Boolean(EMBED_MODEL_REVISION && MODEL_REVISION),
    `embed=${EMBED_MODEL_REVISION} nli=${MODEL_REVISION}`,
  );
  // Both pins must be compiled into the shipped bundles (background SW + offscreen).
  const distJs = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) distJs.push(readFileSync(p, 'utf8'));
    }
  })(resolve('dist/chrome'));
  const blob = distJs.join('\n');
  check(
    'pinned SHAs are compiled into dist/chrome bundles',
    blob.includes(EMBED_MODEL_REVISION ?? '\0') && blob.includes(MODEL_REVISION ?? '\0'),
  );

  // Network-evidence pin check, robust warm AND cold: transformers.js caches
  // model files in CacheStorage keyed by their FULL fetch URL, which contains
  // /resolve/<revision>/ — so after any successful load the cache keys prove
  // exactly which revision was fetched. (Cheaper and more reliable than
  // intercepting extension-SW/offscreen fetch, which Playwright versions
  // route inconsistently; CacheStorage is per-extension-origin, so the popup
  // page can read entries written by the offscreen document.)
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#advanced`);
  await page.click('#test-pair');
  console.log('… waiting for classification (first run downloads the model)');
  await page.waitForFunction(
    () => {
      const t = document.getElementById('out')?.textContent ?? '';
      return t.includes('->') || t.startsWith('Error');
    },
    { timeout: MODEL_TIMEOUT_MS },
  );
  const out = await page.locator('#out').textContent();
  check('model load + Test Pair classification succeeded', !out.startsWith('Error'));

  const hfUrls = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      if (!name.includes('transformers')) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(req.url);
    }
    return urls.filter((u) => u.includes('huggingface.co'));
  });
  const resolveUrls = hfUrls.filter((u) => u.includes('/resolve/'));
  check(
    'model cache records Hugging Face fetch URLs',
    resolveUrls.length > 0,
    `(${resolveUrls.length} resolve URLs)`,
  );
  check(
    'every cached HF resolve URL uses the pinned EMBED_MODEL_REVISION',
    resolveUrls.length > 0 && resolveUrls.every((u) => u.includes(`/resolve/${EMBED_MODEL_REVISION}/`)),
    resolveUrls[0] ? `e.g. ${resolveUrls[0]}` : '',
  );
  await page.close();
} finally {
  await context.close();
}
process.exitCode = failures;
console.log(failures ? 'E2E-P2: FAILED' : 'E2E-P2: ALL PASSED');
