# FlowGuard Companion

The Phase 4 desktop companion: turns the extension's **soft** Cold-Turkey
lock into **hard** enforcement. While a forced block (Frozen Turkey /
schedule window) is active it:

- keeps its own persisted copy of the lock (`lock-state.json`) — uninstalling
  or wiping the extension does not clear a lock; states re-merge on reconnect
  (monotonic CRDT-style merge, locks can be extended, never shortened),
- watches supported browsers (Chrome/Edge/Firefox): running without a
  responsive FlowGuard extension → notification → 60s grace → browser closed,
- closes **incompatible browsers** (Brave/Opera/Vivaldi/Arc/LibreWolf/…)
  after a 10s notice,
- closes user-blocklisted desktop apps immediately,
- refuses to quit from the tray while the block runs (task-manager kills
  still win — this is deliberate, honest soft-tamper-proofing).

Everything is **fully local**: the companion has zero network code.

## Architecture

```
browser ──connectNative('dev.davidxu.flowguard')──▶ flowguard-nm-host
   (one relay per browser port; dies with the browser)   │ local IPC
                                                         ▼
                              companion daemon (flowguard_core::daemon)
                              headless `flowguard-daemon` on Linux,
                              embedded in the Tauri app on Windows
```

Crates (`crates/`): `flowguard-core` (all logic; Linux-tested),
`flowguard-nm-host` (stdio↔IPC relay), `flowguard-daemon` (headless CLI),
`flowguard-companion` (Tauri shell — **not** in workspace default-members;
it needs webkit2gtk to even compile on Linux, so `cargo test`/`cargo build`
never touch it. Don't use `--workspace` in headless runs).

## Linux / WSL development

```bash
cargo test                        # 53 tests, all crates except the Tauri shell
cargo clippy --all-targets -- -D warnings
node ../scripts/lock-math-test.mjs        # TS/Rust golden-fixture parity
node ../scripts/e2e-companion-test.mjs    # full loop in a real Chromium
```

Headless install for real Linux use:

```bash
cargo build --release
./target/release/flowguard-daemon install   # NM manifests + XDG autostart
./target/release/flowguard-daemon run
```

## Windows build (the real target)

Prereqs: MSVC toolchain (`rustup default stable-x86_64-pc-windows-msvc`),
VS 2022 Build Tools ("Desktop development with C++"), WebView2 runtime
(preinstalled on Win10 21H2+/Win11), `cargo install tauri-cli`.

```powershell
cd companion
cargo build --release -p flowguard-nm-host   # relay, must sit next to the app
cargo tauri build                            # from crates/flowguard-companion
# put flowguard-nm-host.exe next to flowguard-companion.exe, then run the app
```

The placeholder icons in `crates/flowguard-companion/icons/` are generated
solid-color files — replace via `cargo tauri icon <1024px png>` before any
release.

### Manual Windows checklist (run once per release)

1. Launch the app → **Install / Repair** → verify HKCU
   `Software\{Google\Chrome,Microsoft\Edge,Mozilla}\NativeMessagingHosts\dev.davidxu.flowguard`
   exist and point at the manifest JSONs next to the exe; autostart enabled.
2. Load `dist/chrome` unpacked in Chrome AND Edge (same stable ID
   `dhbhbhhcjkfdkfbloeaeedndfjfadajh`), the signed build in Firefox
   (`flowguard-poc@davidxu.dev`). Options page of each shows
   **"Connected — hardcore mode active"**.
3. Add `notepad` to Blocked apps; start a 2-minute Frozen Turkey from the
   extension popup; open Notepad → closed within ~3s, toast shown.
4. During the same lock: disable the extension in Chrome → toast warning →
   Chrome closed after the 60s grace.
5. During the same lock: open Brave (or any incompatible browser) → closed
   after the 10s notice.
6. Tray → Quit while locked → refused with a toast; after expiry → quits.
7. Reboot → companion is running (tray icon present) before any browser.

## The stable extension ID

`manifests/chrome.json` carries a committed `"key"` so every unpacked load
(and, later, the store upload made with the same private key) gets the ID
`dhbhbhhcjkfdkfbloeaeedndfjfadajh` — which the NM host manifests whitelist.
The private key lives at the repo root as `flowguard-dev-key.pem`
(**gitignored — back it up; losing it changes the ID**). Regenerate the
public fields if ever needed:

```bash
openssl rsa -in flowguard-dev-key.pem -pubout -outform DER | base64 -w0            # manifest "key"
openssl rsa -in flowguard-dev-key.pem -pubout -outform DER | sha256sum | head -c32 | tr '0-9a-f' 'a-p'   # extension ID
```

## Policy tamper-proofing status (read before enabling)

`policy.rs` can write Chrome/Edge `ExtensionSettings` (HKLM) and Firefox
`policies.json`, but it ships **flag-off** (`policyEnforce: false`) because:
force-install from outside the web stores is **silently ignored on
unmanaged consumer machines** (Chrome/Edge require domain/Azure-AD/enrolled
devices), and Firefox requires a Mozilla-signed XPI. Until the Phase 3
store listing exists there is nothing truthful to enable — the watchdog
(closing the browser) is the enforcement that always works.

## Licensing

`license.rs` is a stub: every install reports Pro. `config.json` already
has `licenseKey` so real validation lands in one place when payments
(ROADMAP Phase 4: $39 lifetime) arrive.
