// Interactive dev browser for the desktop-companion loop.
//
//   node scripts/dev-live-browser.mjs
//
// Launches a VISIBLE Chromium (WSLg) with dist/chrome loaded and the Native
// Messaging manifest wired to the RELEASE nm-host, against the installed
// daemon (smartblocker-daemon watchdog). Close the window or Ctrl+C to quit.
// Profile persists at .dev-profile/ so the ~35MB model downloads only once.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXT_PATH = resolve('dist/chrome');
const PROFILE = resolve('.dev-profile');
const EXTENSION_ID = 'dhbhbhhcjkfdkfbloeaeedndfjfadajh'; // fixed by manifest "key"
const NM_HOST_BIN = resolve('companion/target/release/smartblocker-nm-host');

// Chromium reads NM manifests from <user-data-dir>/NativeMessagingHosts on Linux.
mkdirSync(join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(
  join(PROFILE, 'NativeMessagingHosts/dev.davidxu.smartblocker.json'),
  JSON.stringify(
    {
      name: 'dev.davidxu.smartblocker',
      description: 'SmartBlocker companion bridge (dev-live)',
      path: NM_HOST_BIN,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  ),
);

// Stale SW script cache (same hazard as the e2e scripts).
rmSync(join(PROFILE, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WSLg display quirk (2026-11-07): the X11 socket accepts chromium and then
// kills the connection ~30-80s in ("X connection error received", fatal to
// ozone-x11), while the Wayland compositor is healthy — but its socket is not
// linked into XDG_RUNTIME_DIR, so apps never find it. Link it, then force
// ozone-wayland. No-op on non-WSL systems.
const WSLG_RUNTIME = '/mnt/wslg/runtime-dir';
function headedArgs() {
  if (!existsSync(join(WSLG_RUNTIME, 'wayland-0'))) return [];
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && !existsSync(join(runtimeDir, 'wayland-0'))) {
    try {
      symlinkSync(join(WSLG_RUNTIME, 'wayland-0'), join(runtimeDir, 'wayland-0'));
    } catch {
      /* best effort */
    }
  }
  return ['--ozone-platform=wayland'];
}

// Fresh-profile Chromium sometimes doesn't boot the unpacked extension's SW
// on first launch (same flake the e2e scripts work around): nudge it with a
// page visit, and relaunch outright if it stays down.
async function launchWithServiceWorker() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-first-run',
        ...headedArgs(),
      ],
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
    console.log(`[dev-live] extension SW did not boot (attempt ${attempt}), relaunching`);
    await ctx.close();
    await sleep(2_000);
  }
  throw new Error('service worker did not boot after 3 launches');
}

const { context } = await launchWithServiceWorker();

console.log(`[dev-live] Chromium up with ${EXTENSION_ID}`);
console.log('[dev-live] Daemon events:  tail -f ~/.local/share/smartblocker/events.log');
console.log('[dev-live] Daemon notices: tail -f ~/.config/smartblocker/daemon.out');
console.log('[dev-live] Close the browser window or Ctrl+C to quit.');

await new Promise((resolvePromise) => {
  context.on('close', resolvePromise);
  process.on('SIGINT', resolvePromise);
});
await context.close().catch(() => {});
process.exit(0);
