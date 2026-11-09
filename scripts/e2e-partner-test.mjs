// Real partner UI + offline signing + native daemon loop. Signing key material
// is generated locally for this test only and never persisted by production.
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const DATA = mkdtempSync('/tmp/opencode/partner-e2e-data-');
const PROFILE = mkdtempSync('/tmp/opencode/partner-e2e-profile-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
const SOCKET = `partner-e2e-${process.pid}`;
const DAEMON = join(ROOT, 'companion/target/debug/smartblocker-daemon');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(ok, label) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; }
async function poll(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  … poll timed out: ${label}`);
  return false;
}
const read = (name) => { try { return JSON.parse(readFileSync(join(DATA, name), 'utf8')); } catch { return null; } };
const write = (name, value) => writeFileSync(join(DATA, name), JSON.stringify(value, null, 2));
execFileSync('cargo', ['build', '-p', 'smartblocker-nm-host', '-p', 'smartblocker-daemon'], {
  cwd: join(ROOT, 'companion'), stdio: 'ignore', timeout: 300_000,
});
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', timeout: 300_000 });

function generateKey() {
  const lines = execFileSync(DAEMON, ['partner-keygen'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  return Object.fromEntries(lines.map((line) => line.split('=')));
}
const first = generateKey();
// keygen returns ordered NAME=value lines; parse explicitly, not hand-coded crypto.
const second = generateKey();
const activeKey = first.PRIVATE_KEY_HEX;
const activePublic = first.PUBLIC_KEY_HEX;
const installationId = '5175716756573656572000000000000000000000000000000000000000000000'.slice(0, 64);
const now = Date.now();
write('partner-state.json', {
  version: 1, installationId,
  publicKeys: [{ publicKey: activePublic, addedAtMs: now - 86_400_001, activeAtMs: now - 1 }],
  pendingOperations: [], spentCodes: [], lastObservedAtMs: 0,
});
write('lock-state.json', {});
write('blocking-state.json', { enabled: true, revision: 3 });
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(join(PROFILE, 'NativeMessagingHosts/dev.davidxu.smartblocker.json'), JSON.stringify({
  name: 'dev.davidxu.smartblocker', description: 'partner e2e', path: join(ROOT, 'companion/target/debug/smartblocker-nm-host'),
  type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
}));
write('config.json', { appBlocklist: [], extraIncompatibleBrowsers: [] });
let daemon = spawn(DAEMON, ['run', '--socket', SOCKET, '--data-dir', DATA], { stdio: ['ignore', 'inherit', 'inherit'] });
await sleep(700);
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${join(ROOT, 'dist/chrome')}`, `--load-extension=${join(ROOT, 'dist/chrome')}`],
  env: { ...process.env, SMARTBLOCKER_SOCKET: SOCKET },
});
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#locks`);
  check(await poll(() => options.locator('#partner-public-key').isVisible(), 15_000, 'partner setup visible'), 'Locks page exposes partner setup without private key material');
  await options.locator('#partner-public-key').fill(second.PUBLIC_KEY_HEX);
  await options.getByRole('button', { name: 'Register public key', exact: true }).click();
  check(
    await poll(() => {
      const keys = read('partner-state.json')?.publicKeys ?? [];
      const registered = keys.find((key) => key.publicKey === second.PUBLIC_KEY_HEX);
      return registered && registered.activeAtMs >= now + 86_399_000;
    }, 15_000, 'second public key registered with full delay'),
    'new partner key gets the real 24-hour activation delay',
  );

  await options.getByRole('button', { name: 'Arm partner gate', exact: true }).click();
  check(await poll(() => /^[0-9a-f]{64}$/.test(read('lock-state.json')?.partnerArmGeneration ?? ''), 15_000, 'fresh partner arm persisted'), 'daemon arms a fresh generation with its already-active key');
  const arm = read('lock-state.json').partnerArmGeneration;
  check(
    await poll(async () => {
      const stored = await sw.evaluate(() => chrome.storage.local.get('lockState'));
      return stored.lockState?.partnerArmGeneration === arm;
    }, 15_000, 'daemon arm reaches browser lockState'),
    'daemon-issued arming reaches chrome.storage.local.lockState',
  );
  check(
    await poll(() => options.locator('#break-mode').isDisabled(), 10_000, 'partner arm locks settings controls'),
    'an active partner arm makes settings writes unavailable in the real UI',
  );
  const blockingBefore = read('blocking-state.json');

  // Raw generic lockStateSync may never forge a partner release.
  await sw.evaluate(() => chrome.storage.local.get('lockState').then(async ({ lockState }) => {
    await chrome.storage.local.set({ lockState: { ...lockState, partnerArmGeneration: null, partnerArmUpdatedAt: Date.now() + 60_000 } });
  }));
  await sleep(800);
  check(read('lock-state.json')?.partnerArmGeneration === arm, 'raw browser storage cannot release a live partner arm through generic lock merge');

  // Release must preserve completely independent gates, exactly.
  const untilTimer = Date.now() + 600_000;
  const untilFrozen = Date.now() + 720_000;
  await sw.evaluate(async ({ untilTimer, untilFrozen }) => {
    const stored = await chrome.storage.local.get('lockState');
    await chrome.storage.local.set({
      lockState: {
        ...stored.lockState, timerUntil: untilTimer, frozenUntil: untilFrozen,
        delayUntil: stored.lockState.delayUntil ?? 0,
        delayDurationMs: stored.lockState.delayDurationMs ?? 60_000,
        delayUpdatedAt: stored.lockState.delayUpdatedAt ?? Date.now(),
        randomTextLen: 25, randomTextUpdatedAt: Date.now(),
      },
    });
  }, { untilTimer, untilFrozen });
  await options.getByRole('button', { name: 'Create operation', exact: true }).click();
  check(await poll(() => options.locator('#partner-operation').isVisible(), 15_000, 'pending operation visible'), 'daemon exposes the exact pending operation for offline signing');
  const operation = JSON.parse(await options.locator('#partner-operation').inputValue());
  check(
    operation.installationId === installationId && operation.armGeneration === arm && operation.nonce.length === 64 && operation.operationId.length === 64,
    'operation is bound to the exact installation and arm with unique nonce/id',
  );

  const wrongCode = execFileSync(DAEMON, ['partner-sign', JSON.stringify(operation), String(operation.expiresAtMs), second.PRIVATE_KEY_HEX], { encoding: 'utf8' }).trim();
  await options.locator('#partner-redeem-code').fill(wrongCode);
  await options.getByRole('button', { name: 'Redeem', exact: true }).click();
  await sleep(700);
  check(read('lock-state.json')?.partnerArmGeneration === arm, 'a wrong private key never releases the arm');

  const signedCode = execFileSync(DAEMON, ['partner-sign', JSON.stringify(operation), String(operation.expiresAtMs), activeKey], { encoding: 'utf8' }).trim();
  await options.locator('#partner-redeem-code').fill(signedCode);
  await options.getByRole('button', { name: 'Redeem', exact: true }).click();
  check(
    await poll(() => {
      const released = read('lock-state.json')?.partnerArmGeneration;
      return (released === null || released === undefined) && (read('partner-state.json')?.spentCodes.length ?? 0) === 1;
    }, 15_000, 'valid partner code consumed and released the arm'),
    'correct offline Ed25519 code releases its exact arm and persists replay tombstone',
  );
  const other = read('lock-state.json');
  check(
    other.timerUntil > untilTimer - 1_000 && other.timerUntil < untilTimer + 1_000 && other.frozenUntil === untilFrozen &&
      other.randomTextLen === 25 && other.delayUntil === 0 && JSON.stringify(read('blocking-state.json')) === JSON.stringify(blockingBefore),
    'timer, Frozen, delay/random-text gates, and ordinary blocking are untouched by release',
  );
  check(
    await poll(async () => {
      const stored = await sw.evaluate(() => chrome.storage.local.get('lockState'));
      return !stored.lockState?.partnerArmGeneration;
    }, 15_000, 'release reaches browser lockState'),
    'the exact released arm disappears from chrome.storage.local.lockState',
  );
  await options.locator('#partner-redeem-code').fill(signedCode);
  await options.getByRole('button', { name: 'Redeem', exact: true }).click();
  await sleep(700);
  check(!read('lock-state.json').partnerArmGeneration && (read('partner-state.json')?.spentCodes.length ?? 0) === 1, 'replayed signed code cannot create another arm release or erase tombstone');
  const msg = await options.locator('#partner-msg').textContent();
  check(!msg?.includes('PRIVATE_KEY_HEX'), 'partner UI never displays private signing material');
} catch (error) {
  failures++;
  console.error(error.stack ?? error);
} finally {
  await context.close().catch(() => {});
  daemon.kill('SIGTERM');
  rmSync(DATA, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
}
console.log(failures === 0 ? 'PARTNER E2E: ALL PASSED' : `PARTNER E2E: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
