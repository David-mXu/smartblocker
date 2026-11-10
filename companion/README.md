# SmartBlocker Companion

The Phase 4 desktop companion: turns the extension's **soft** Cold-Turkey
lock into **hard** enforcement. While **any** lock is armed — a timer, a
password lock, Frozen Turkey, or an active schedule window — it:

- keeps its own persisted copy of the lock (`lock-state.json`) — uninstalling
  or wiping the extension does not clear a lock; states re-merge on reconnect
  (monotonic CRDT-style merge, locks can be extended, never shortened), and
  the daemon **reverse-syncs** (`merge.rs merge_in`) its copy back into a
  wiped/reinstalled extension, so a storage wipe heals back to the lock
  instead of freeing you,
- watches supported browsers (Chrome/Edge/Firefox): running without a
  responsive SmartBlocker extension → notification → grace (default 60s,
  tunable 15–300s in desktop Settings) → browser closed. Browsers are
  identified **behaviorally**, not by filename:
  `procwatch.rs classify_process` reads each process's command line for
  renderer structure (`--type=renderer` on Chromium, `-contentproc` on
  Firefox) — renaming `brave.exe` to `chrome.exe` no longer inherits trust,
- flags **private / extensionless launches** (`--incognito`, `--inprivate`,
  `--guest`, `--disable-extensions`): incognito-class windows run with
  extensions disabled, so such a browser can never host SmartBlocker and is
  treated as a bypass attempt (the extension popup also warns when
  incognito access isn't granted — an extension that can see private windows
  blocks far earlier than a kill),
- closes **incompatible browsers** (Brave/Opera/Vivaldi/Arc/LibreWolf/…)
  after a 10s notice,
- tolerates the **developer launch pair** (`--load-extension=<dir>` +
  `--disable-extensions-except=<dir>`) only while a paired, heartbeating
  extension of that same browser kind is connected — with no healthy
  pairing it is a full bypass attempt (notice, then close). **Electron apps
  are carved out** of browser fingerprinting entirely (`--type=renderer`
  plus `app.asar` on the command line, or a known Electron stem like VS
  Code, is never flagged or killed) — an embedded Electron window is the
  accepted residual for a self-control tool, and killing every Electron
  app would be far out of scope,
- closes user-blocklisted desktop apps immediately — by **typed identity**
  (Microsoft Store package family, normalized full exe path, or exact exe
  stem; `config.json` `appTargets`) with the original case-insensitive
  substring list (`appBlocklist`) still honored for old configs. Path matches
  are exact-file equality, never a folder prefix, and legacy contains rules
  keep their broad semantics until the user removes them,
- records **local-only app usage** (Windows): foreground executable active time
  in five-second samples, gated on the system's 30-second idle signal, split by
  local calendar day and retained for 35 days. Only the executable basename and
  millisecond totals are stored — no window titles, document names, paths or
  URLs. The Usage page can export or clear it, and it never changes blocking.
- anchors lock/expiry math to a **monotonic clock with wall-clock-jump
  compensation** (the extension's `lock-enforcer.ts` mirrors this) —
  rewinding the system clock does not shorten a lock,
- **self-heals `config.json` mid-lock**: user edits merge against
  enforcement-critical fields instead of silently weakening them, so editing
  or truncating the config can't drop the legacy app blocklist / typed
  `appTargets` or disarm the watchdog mid-lock,
- **protects itself precisely**: kill-immunity binds to a **recorded PID
  set** — the daemon's own pid, its supervisor's pid, and every process
  verified at scan time to run a companion executable **from the install
  dir** (the set is rebuilt on every enforcing tick, so dead pids and pid
  reuse can't inherit immunity). Anything else wearing a protected stem is a
  hostile **decoy**: renamed to `smartblocker-daemon`/`smartblocker-nm-host`
  it gains nothing — during a block it's killed immediately like a
  blocklisted app, with `decoy-immune`/`decoy-killed` events logged — and
  the watchdog can never suicide-kill,
- **survives Task Manager / pkill**: autostart launches the **supervisor**
  (`smartblocker-daemon watchdog`), which spawns the daemon at login and
  revives it whenever a bounded **PING/PONG probe** fails — a bare connect
  is not proof of life: a squatter that bound the socket name and answers
  nothing (or garbage) fails the probe, so the supervisor respawns and the
  real daemon re-binds the moment the squatter dies. The daemon — told the
  supervisor's pid via env, or started with `--watchdog` — respawns the
  supervisor within seconds if the supervisor dies, so one `pkill` after
  login can't end hard enforcement; `uninstall` is **lock-guarded** and
  refuses to tear down NM registration and autostart while a lock is
  active,
- **hardens the IPC surface**: Linux peers must pass a **same-uid gate**
  (SO_PEERCRED effective-uid check — abstract-namespace sockets have no
  filesystem permission layer, so without it any local user could connect),
  the connection registry is capped (64) with per-connection **bounded
  outbound queues** written by dedicated writer threads — a client that
  stops reading is evicted and can never stall a broadcast — and
  unauthenticated connections idle for 60s are reaped,
- verifies **Pro licenses fully offline** and **fails closed**: `license.rs`
  validates `SBPRO1.<payload_hex>.<hmac_hex>` keys with HMAC-SHA256 — a
  missing or invalid key is NOT Pro; no activation server, no telemetry,
- writes **platform hardening policies** (Firefox `policies.json`, Chromium
  policies) where consumer policy is honored — see the honest limits below.

Everything is **fully local**: the companion has zero network code.

### IPC trust model (protocol v2)

The local IPC socket accepts connections from any process, but a connection
only becomes "a browser" after an **authenticated hello**: each browser
profile's extension holds a random pairing token
(`storage.local.companionPairing`) that the daemon persists in
`config.json pairingTokens` (TOFU — new tokens are adopted only while
**unlocked**, so nothing can self-pair mid-lock). Unauthenticated clients
(Tauri UI, scripts) still get a redacted status stream and can extend
timer/Frozen locks. Their password, schedule, break, delay and random-text
operation fields are pinned to the daemon's state before the merge, and they
never register as a browser for the watchdog. Residual, honestly:
a same-uid process that reads BOTH token stores (the browser profile's
`Local Extension Settings` leveldb and this config) can still impersonate
the browser — the cap for consumer software.

## Architecture

```
browser ──connectNative('dev.davidxu.smartblocker')──▶ smartblocker-nm-host
   (one relay per browser port; dies with the browser)   │ local IPC
                                                         ▼
                              companion daemon (smartblocker_core::daemon)
                              headless `smartblocker-daemon` on Linux,
                              embedded in the Tauri app on Windows
                                                         ▲
                              `smartblocker-daemon watchdog` supervisor —
                              spawns and revives the daemon (mutual watch)
```

Crates (`crates/`): `smartblocker-core` (all logic; Linux-tested),
`smartblocker-nm-host` (stdio↔IPC relay), `smartblocker-daemon` (headless CLI:
`run` / `watchdog` / `install` / `uninstall` / `status` / `block` / `lock`),
`smartblocker-companion` (Tauri shell — **not** in workspace default-members;
it needs webkit2gtk to even compile on Linux, so `cargo test`/`cargo build`
never touch it. Don't use `--workspace` in headless runs).

## Linux / WSL development

```bash
cargo test                        # unit + golden-fixture parity + hardening suites (all crates except the Tauri shell)
cargo clippy --all-targets -- -D warnings
node ../scripts/lock-math-test.mjs        # TS/Rust golden-fixture parity
node ../scripts/e2e-companion-test.mjs    # full loop in a real Chromium
```

Headless install for real Linux use:

```bash
cargo build --release
./target/release/smartblocker-daemon install   # NM manifests + XDG autostart (launches the watchdog supervisor)
./target/release/smartblocker-daemon run       # direct run; autostart normally spawns this via `watchdog`
```

Automation against a running daemon:

```bash
./target/release/smartblocker-daemon block start
./target/release/smartblocker-daemon block stop
./target/release/smartblocker-daemon block toggle
./target/release/smartblocker-daemon lock 30    # minutes; also enables ordinary blocking
./target/release/smartblocker-daemon status
```

`block` changes the daemon's persisted ordinary-blocking value and revision,
then synchronizes every connected browser. It does not start or cancel a lock.
`lock` starts a timer or extends the existing deadline, whichever is later;
there is no shorten/cancel command. `block stop` and a toggle that would turn
blocking off are refused while **any** lock is active. Successful commands
reply only after their state is persisted; refusals and write failures exit
nonzero. Add `--socket NAME` to target a non-default/test daemon.

### Accountability-partner codes

```bash
./target/release/smartblocker-daemon partner-keygen                                    # prints a secret + public pair once
./target/release/smartblocker-daemon partner add-key PUBLIC_KEY_HEX                    # activates after 24 hours
./target/release/smartblocker-daemon partner arm                                       # requires an already-active key and no other lock
./target/release/smartblocker-daemon partner begin                                     # prints the pending operation JSON
./target/release/smartblocker-daemon partner sign OPERATION_JSON EXPIRES_MS PRIVATE_KEY_HEX
./target/release/smartblocker-daemon partner redeem SBP1.<payload>.<signature>
```

Run `partner-keygen` on the partner's device and give the user only
`PUBLIC_KEY_HEX`. Its private half must stay there. `partner-keygen` and
`partner sign` operate entirely offline and never contact the daemon. Signing
binds the installation, exact arm generation, operation ID, nonce, and expiry
(15 minutes maximum). The daemon uses strict Ed25519 verification; a code
redeems only that exact arm and leaves timer/Frozen/schedule/password/delay/
random-text locks and ordinary `enabled` unchanged. Replay tombstones are
persisted before release, so a second use or a stale arm cannot succeed.
There is no expedited activation route; changing keys never releases an arm.

`allowance-state.json` stores revisioned per-category allowance, opening,
Pomodoro, and idempotency receipts. Browser commands are accepted only with the
current base revision and persist before being acknowledged. A browser may
recover a snapshot only into a genuinely uninitialized daemon; present corrupt
files prevent startup rather than silently becoming a new daily pool.

`usage-state.json` is the desktop usage aggregate: a versioned, sanitized map of
local dates to app buckets plus a single foreground checkpoint. It is bounded to
35 retained local days and 80 app rows per day (overflow folds into
`other.apps`), written atomically in 15-second batches, and cleared through the
live daemon over `UsageCommand` so an in-flight sample cannot resurrect old
totals. On non-Windows platforms the probe reports unavailable and the file is
not extended.

## Windows build (the real target)

Prereqs: MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`),
VS 2022 Build Tools ("Desktop development with C++"), WebView2 runtime
(preinstalled on Win10 21H2+/Win11), `cargo install tauri-cli`.

The UI is React + Vite in `src/desktop/` (spec:
`docs/design-notes-desktop.md`). `cargo tauri build` runs
`npm run build:desktop` first, so Node is needed; a plain `cargo build` of the
shell needs `ui-dist/` built beforehand. If Git's `link.exe` shadows MSVC's,
build from a shell that has run `vcvars64.bat`.

```powershell
cd companion
cargo build --release -p smartblocker-nm-host   # relay, must sit next to the app
cargo tauri build                            # from crates/smartblocker-companion
# put smartblocker-nm-host.exe next to smartblocker-companion.exe, then run the app
```

**Safe test mode:** a DEBUG build with `SMARTBLOCKER_TEST_MODE=1` uses a scratch
data dir and socket, logs kills instead of performing them, and skips registry
and autostart writes. Use it for anything that starts a lock on a machine with
real browsers open. Add
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` to drive the
window with Playwright `connectOverCDP`.

Icons for both the extension (`dist/*/`) and the tray app
(`crates/smartblocker-companion/icons/`) are real, shipped assets — if the
tray icon art ever changes, regenerate via `cargo tauri icon <1024px png>`.

### Manual Windows checklist (run once per release, on real hardware)

1. Launch the app → **Install / Repair** → verify HKCU
   `Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\dev.davidxu.smartblocker`
   exist and point at the manifest JSONs next to the exe; autostart enabled.
   Then Settings → **Start with Windows** off/on removes and restores the HKCU
   `...\CurrentVersion\Run` value named `SmartBlocker Companion`; Repair turns
   it back on. Set **Extension-loss grace** to 15, relaunch the app, and confirm
   the value survives in `config.json`.
2. Load `dist/chrome` unpacked in Chrome AND Edge (same stable ID
   `dhbhbhhcjkfdkfbloeaeedndfjfadajh`), the signed build in Firefox
   (`smartblocker-poc@davidxu.dev`). Options page of each shows
   **"Connected — hardcore mode active"**.
3. Add `notepad` to Blocked apps; start a 2-minute Frozen Turkey from the
   extension popup; open Notepad → closed within ~3s, toast shown.
4. During the same lock: disable the extension in Chrome → toast warning →
   Chrome closed after the configured extension-loss grace (60s by default;
   set it to 15 and 120 once each to confirm the boundary moves).
5. During the same lock: open Brave (or any incompatible browser) → closed
   after the 10s notice.
6. Tray → Quit while locked → refused with a toast; after expiry → quits.
7. Reboot → companion is running (tray icon present) before any browser.
8. During a lock: launch Chrome with `--incognito` (or any private window) →
   flagged and handled as a bypass; then launch with `--disable-extensions`
   → same.
9. During a lock: set the system clock back 2 hours → the lock does NOT
   expire early (monotonic compensation); end-task the daemon in Task
   Manager → the watchdog supervisor respawns it within seconds, and kill
   the supervisor → the daemon respawns IT (a `supervisor-respawned` event
   lands in `events.log`); `smartblocker-daemon uninstall` mid-lock →
   refused.
10. During a lock: copy `brave.exe` (or any blocked app) to a folder and
    rename it `chrome.exe`, then launch → NOT treated as a trusted browser
    (command-line fingerprinting); rename a blocked app to
    `smartblocker-daemon.exe` → gains no kill-immunity: it's closed as a
    decoy (`decoy-killed` in `events.log`).
11. Usage: work in Notepad for two minutes, then switch to another app → the
    Usage page shows both, with Notepad's time stopping at the switch. Leave
    the machine idle for a minute → active time does not grow with idle time.
    Export, then clear → the JSON contains app names and durations only (no
    title/path/URL), and the page returns to zero. Quit the companion and
    reopen the window → the last aggregate is still readable from disk.

## The stable extension ID

`manifests/chrome.json` carries a committed `"key"` so every unpacked load
(and, later, the store upload made with the same private key) gets the ID
`dhbhbhhcjkfdkfbloeaeedndfjfadajh` — which the NM host manifests whitelist.
The private key lives at the repo root as `smartblocker-dev-key.pem`
(**gitignored — back it up; losing it changes the ID**). Regenerate the
public fields if ever needed:

```bash
openssl rsa -in smartblocker-dev-key.pem -pubout -outform DER | base64 -w0            # manifest "key"
openssl rsa -in smartblocker-dev-key.pem -pubout -outform DER | sha256sum | head -c32 | tr '0-9a-f' 'a-p'   # extension ID
```

## Policy hardening status (honest limits)

`policy.rs` writes Firefox `policies.json` and Chromium
`ExtensionSettings`/hardening policies from Install/Repair. Verified
2026-07: Chrome/Edge honor `ExtensionSettings` force-install from OUTSIDE
their web stores only on managed devices (domain/Azure-AD-joined or
enrolled), so the force-install half stays gated on the Phase 3 Chrome Web
Store listing (`update_url`); Firefox force-install additionally requires a
Mozilla-signed XPI. The consumer-honored hardening entries still close what
the platform allows closing (e.g. private-mode availability), and where
policy is silently ignored the behavioral watchdog — process
fingerprinting + private-launch detection — remains the enforcement that
always works. Hosts-file/proxy blocking stays out of scope (2026-07-03
decision).

## Licensing

`license.rs` verifies **offline** the Pro keys the payment flow will issue:
a key is `SBPRO1.<payload_hex>.<hmac_hex>` where the payload is
`pro:<email-or-id>` (perpetual) or `pro:<email-or-id>:<expiry-epoch-ms>`
and the tag is HMAC-SHA256 over the payload bytes keyed with an embedded
product salt (a legacy `sb_pro_<payload_hex>_<hmac_hex>` spelling verifies
too). Verification needs no activation server and no network — the
companion stays zero-network, and it never phones home to check.

The gate is **fail-closed**: a missing, malformed, or wrongly-signed key is
NOT Pro. Pre-store development is covered by `SBPRO_DEV_OPEN=1` in the
daemon's environment (the `dev-open` posture) — an explicit escape hatch
instead of a silent fail-open. An expired key keeps Pro for a 7-day renewal
grace (`pro-grace`), then reads as free (`free-expired`); a numeric id tail
below 10¹² never parses as an expiry, so legacy `pro:<id>` keys stay
perpetual. Enforcement-critical like the app blocklist, the key is **pinned
at lock start** and self-healed against mid-lock `config.json` edits, and
every posture transition is logged as a `license` event in `events.log`.
`$39 lifetime` (Stripe / Lemon Squeezy — ROADMAP Phase 4) only needs a
signing service that issues keys; `config.json licenseKey` is the single
storage seam, and nothing in the daemon changes when payments go live.
