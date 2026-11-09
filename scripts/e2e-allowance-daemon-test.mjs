// Focused real item10 loop: isolated Chromium + actual built extension + real
// nm-host relay + real daemon + direct second authenticated daemon client.
// The browser remains Linux Chromium evidence, not Firefox/Windows/Tauri.
import { chromium } from 'playwright';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
// Data directories are always isolated beneath the approved test temp root.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const EXT_PATH = join(ROOT, 'dist/chrome');
const pid = process.pid;
const SOCKET = `allowance-daemon-e2e-${pid}`;
const DATA = mkdtempSync('/tmp/opencode/allowance-daemon-e2e-data-');
const PROFILE = mkdtempSync('/tmp/opencode/allowance-daemon-e2e-profile-');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh';
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  … timed out: ${label}`);
  return false;
}
function frameEncode(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
class Frames {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.error = null;
    sock.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); });
    sock.on('error', (error) => { this.error = error; });
  }
  async next(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.buf.length >= 4) {
        const len = this.buf.readUInt32LE(0);
        if (this.buf.length >= len + 4) {
          const value = JSON.parse(this.buf.subarray(4, len + 4).toString());
          this.buf = this.buf.subarray(len + 4);
          return value;
        }
      }
      if (this.error) throw this.error;
      await sleep(15);
    }
    throw new Error('frame timeout');
  }
}
const readAllowance = () => {
  try { return JSON.parse(readFileSync(join(DATA, 'allowance-state.json'), 'utf8')); } catch { return null; }
};
console.log('… build browser bundles and companion binaries');
const npm = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', timeout: 300_000 });
if (npm.status !== 0) throw new Error('browser build failed');
execFileSync('cargo', ['build', '-p', 'smartblocker-nm-host', '-p', 'smartblocker-daemon'], {
  cwd: join(ROOT, 'companion'), stdio: 'inherit',
});
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(join(PROFILE, 'NativeMessagingHosts/dev.davidxu.smartblocker.json'), JSON.stringify({
  name: 'dev.davidxu.smartblocker', description: 'allowance e2e',
  path: join(ROOT, 'companion/target/debug/smartblocker-nm-host'), type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
}));
writeFileSync(join(DATA, 'config.json'), JSON.stringify({ appBlocklist: [], extraIncompatibleBrowsers: [] }));
const DAEMON = join(ROOT, 'companion/target/debug/smartblocker-daemon');
const startDaemon = () => spawn(DAEMON, ['run', '--socket', SOCKET, '--data-dir', DATA], { stdio: ['ignore', 'inherit', 'inherit'] });
let daemon = startDaemon();
await sleep(700);
const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  env: { ...process.env, SMARTBLOCKER_SOCKET: SOCKET },
});
let sw;
try {
  sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  sw.on('console', (message) => console.log('  [sw]', message.text()));
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${EXTENSION_ID}/options.html#allowance`);
  const rpc = (message) => opts.evaluate((value) => chrome.runtime.sendMessage(value), message);
  const opId = (n) => `${pid.toString(16).padStart(8, '0')}a11ce${n}`.padEnd(32, '0');
  const day = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };
  check(
    await poll(async () => {
      const response = await rpc({ type: 'GET_ALLOWANCE_AUTHORITY' });
      return response?.ok === true && response.source === 'daemon' && response.state?.version === 1;
    }, 15_000, 'daemon authority initializes'),
    'actual daemon authority is exposed through native messaging',
  );
  const configured = await rpc({
    type: 'ALLOWANCE_COMMAND', command: { kind: 'configure', operationId: opId('0001'), category: 'video games',
      config: { dailyAllowanceMs: 60_000, dailyOpenings: 1, waitingBaseMs: 0,
        waitingStepMs: 0, waitingMaxMs: 0, rewardCapMs: 60_000 } },
  });
  check(configured?.ok === true && configured.source === 'daemon' && readAllowance()?.revision === 1,
    'configure ACK follows durable daemon revision 1');

  await context.route('**://www.youtube.com/**', (route) => {
    const u = new URL(route.request().url());
    const title = decodeURIComponent(u.searchParams.get('t') ?? 'YouTube');
    route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><html><head><title>${title} - YouTube</title></head><body><h1>${title}</h1></body></html>` });
  });
  const tab = await context.newPage();
  const url = 'https://www.youtube.com/watch?v=allowancedaemon01&t=' + encodeURIComponent('speedrunning Dark Souls');
  const blocked = async () => (await tab.locator('#smartblocker-overlay').count().catch(() => 0) > 0) || new URL(tab.url()).protocol === 'chrome-extension:';
  await tab.goto(url);
  check(await poll(blocked, 240_000, 'normal blocked verdict precedes allowance'), 'normal classifier block precedes daemon relief');
  const requested = await rpc({
    type: 'ALLOWANCE_COMMAND', command: {
      kind: 'request', operationId: opId('0002'), category: 'video games',
      grantId: 'e2e-daemon-allowance', nowMs: Date.now(), dayKey: day(), durationMs: 60_000,
    },
  });
  const granted = readAllowance();
  check(
    requested?.ok === true && granted?.revision === 2 && granted.categories['video games'].ledger.grant.status === 'active',
    'daemon persists an active grant before its ACK',
  );
  await tab.reload();
  check(await poll(async () => !(await blocked()), 30_000, 'daemon grant relaxes primary label'), 'daemon allowance relaxes its primary classifier category');
  const cancelled = await rpc({
    type: 'ALLOWANCE_COMMAND', command: {
      kind: 'cancel', operationId: opId('0003'), category: 'video games',
      grantId: 'e2e-daemon-allowance', nowMs: Date.now(), dayKey: day(),
    },
  });
  const afterCancel = readAllowance();
  check(
    cancelled?.ok === true && afterCancel?.revision === 3 &&
      afterCancel.categories['video games'].ledger.grant.refundedMs > 0 &&
      afterCancel.categories['video games'].ledger.grant.chargedMs < 60_000,
    'early cancellation refunds unused reservation without resetting escalation',
  );
  await tab.reload();
  check(await poll(blocked, 30_000, 'cancelled grant re-blocks'), 'cancelled allowance cannot keep the page relaxed');
  await tab.close();

  const client = net.createConnection({ path: `\0${SOCKET}` });
  const frames = new Frames(client);
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
  client.write(frameEncode({ v: 2, type: 'hello', browser: 'chrome', extVersion: '0.5.0',
    extensionId: 'second-allowance-client', pairing: `second-${pid}` }));
  let authority;
  for (let n = 0; n < 8; n++) {
    const frame = await frames.next(5_000);
    if (frame.type === 'companionStatus' && frame.status?.extensionLoss) { authority = frame.status.allowance; break; }
  }
  client.destroy();
  check(authority?.revision === 3, 'second authenticated daemon client sees the same authoritative revision');

  const beforeRestart = readAllowance();
  daemon.kill('SIGTERM');
  await sleep(600);
  daemon = startDaemon();
  check(
    await poll(async () => {
      const disk = readAllowance();
      const response = await rpc({ type: 'GET_ALLOWANCE_AUTHORITY' });
      return JSON.stringify(disk) === JSON.stringify(beforeRestart) && response?.source === 'daemon' &&
        response.state?.revision === 3 && JSON.stringify(response.state.categories) === JSON.stringify(disk.categories) &&
        JSON.stringify(response.state.receipts) === JSON.stringify(disk.receipts);
    }, 25_000, 'restart restores exact allowance persistence'),
    'daemon restart restores categories, grants, and operation receipts exactly',
  );
  await opts.close();
} catch (error) {
  failures++;
  console.error(error.stack ?? error);
} finally {
  await context.close().catch(() => {});
  daemon.kill('SIGTERM');
  rmSync(DATA, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
}
console.log(failures === 0 ? 'ALLOWANCE DAEMON E2E: ALL PASSED' : `ALLOWANCE DAEMON E2E: ${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
