# Desktop-Companion Anti-Bypass Hardening, Offline Licensing & Roadmap/Documentation Completion

**Date:** 2026-11-05
**Project:** SmartBlocker (`companion/crates/smartblocker-core/src/`, `companion/crates/smartblocker-daemon/src/main.rs`, `src/background/lock-enforcer.ts`, `src/background/index.ts`, `src/options/OptionsApp.tsx`, `README.md`, `ROADMAP.md`, `CLAUDE.md`, `companion/README.md`)

---

## 1. Original Problem, Symptoms & Audit Findings

Two loose threads converged on this pass.

**A. Documentation drift.** The classifier had grown from the original 395-case
`v1+v2` dataset to **15,874 cases** (`v1`–`v8`, 518 support-vector seed texts,
95.4% top-1 / 0.4% productive FP / 97.6% must-block recall / 98.7% e2e), the UI
had been rebuilt in React 19 + Tailwind v4 + shadcn/ui + GSAP, and sub-frame /
SERP / shadow-DOM blocking had shipped — but `README.md` still quoted the
2026-07 numbers (87.4% top-1 / 91.0% e2e over 395 cases) and `ROADMAP.md` still
framed Phase 3 as unstarted and Phase 4 as "a stub license + missing icons."

**B. The companion was honest-but-soft.** The Phase 4 core (2026-07-04) shipped
a working watchdog/merge/enforcer loop with an explicit disclaimer in
`companion/README.md`: *"task-manager kills still win — this is deliberate,
honest soft-tamper-proofing."* `license.rs` was a 12-line stub returning Pro for
everyone. A deliberate bypass audit found **ten concrete escape vectors**:

1. **Rename-spoofing.** Process classification trusted exe *stems*: copy
   `brave.exe` and rename it `chrome.exe` and the incompatible browser inherits
   the trusted-browser treatment.
2. **Private windows.** `chrome --incognito`, `msedge --inprivate`, `--guest`,
   and Firefox `-private-window` run with extensions unloaded — invisible to the
   blocker while looking like a supported browser.
3. **Extensionless launches.** `--disable-extensions` (and `--load-extension`
   side-loading) produce a nominally supported browser with no enforcement.
4. **Clock rollback.** Lock math keyed off wall-clock timestamps: set the OS
   clock back and a timer lock "expires."
5. **Extension storage wipe.** Clearing profile data / `chrome.storage.local`
   (or reinstalling) erased the extension's `lockState`; the merge only
   protected against the extension wiping the *daemon's* copy.
6. **Companion config tampering.** `config.json` (app blocklist, policy flags)
   could be edited mid-lock to disarm enforcement.
7. **Task-Manager kill.** The daemon is a user-space process; one End-task
   stopped all OS-level enforcement.
8. **Mid-lock uninstall.** `smartblocker-daemon uninstall` happily tore down NM
   registration and autostart while a lock was running.
9. **Masquerading immunity.** Self-protection matched by name, so renaming a
   blocked app to `smartblocker-daemon.exe` could inherit kill-immunity.
10. **Firefox MV3 event-page suspension.** With no offscreen API, a sleeping
    Firefox event page either stalled enforcement or looked like a "dead
    extension" to the companion watchdog (a false-positive kill waiting to
    happen) — while a private Firefox window was a genuine blind spot the UI
    never warned about.

## 2. Root Causes & Underlying Concepts

### A. CRDT state convergence ≠ host boundary enforcement
The Phase 4 merge (`merge.rs` / `lock-math.ts`) is a **CRDT**: commutative,
idempotent, monotonic — two copies converge no matter the delivery order. But
convergence only answers *"what is the lock state?"* on both machines-in-sync.
It says nothing about the **host boundary**: whether the process calling itself
`chrome` really is Chrome, whether the wall clock is honest, whether the enforcer
itself is still alive. The audit's ten vectors are all boundary failures, and
every fix is a boundary check, not a sync improvement.

### B. Filename-stem spoofing vs. behavioral command-line fingerprinting
A filename is **user-controlled metadata**; a browser engine's command line is
**structural behavior**. Chromium always spawns children with fixed flags
(`--type=renderer`, `--type=gpu-process`,
`--utility-sub-type=network.mojom.networkservice`), Firefox with `-contentproc`.
`browsers.rs classify_process` keeps the fast stem match first, then applies two
behavioral rules: a *supported* stem carrying a bypass flag
(`BYPASS_FLAG_PREFIXES`: `--incognito`, `--inprivate`, `--guest`, `-private*`,
`--disable-extensions`, `--load-extension`) is downgraded to `Incompatible`; an
*unknown* stem carrying engine child flags is a renamed browser — *unless* it's
an Electron/WebView host (`NON_BROWSER_HOSTS`: VS Code, Slack, `msedgewebview2`,
…, or cmdline markers like `app.asar`, `--webview-exe-name`), because those
legitimately carry Chromium flags while being apps, not browsers. Skip that
exclusion list and every developer's editor gets shot during a lock.

### C. Wall-clock vs. monotonic time anchoring
Wall time (`SystemTime`/`Date.now()`) is a *display* coordinate — users can set
it. Monotonic time (`Instant`) is an *elapsed* coordinate — it only moves
forward and is unforgeable from userland. The enforcer now makes every timing
decision (grace periods, heartbeat gaps) on `now_mono_ms` and quotes wall time
only in logs; lock *expiry* compensation pairs the stored wall timestamp with a
monotonic anchor so a backward clock jump pauses countdown instead of completing
it. The extension's `lock-enforcer.ts` mirrors this so both sides degrade
identically.

### D. Unidirectional no-op suppression vs. reverse-sync healing
The original loop-protection rule was *suppress*: each side re-broadcasts a
merged state only if the merge changed it. Safe against sync storms, but a wiped
extension (empty state) merged against the daemon's lock produced "no change,"
and the extension stayed empty — a silent unlock. **Reverse-sync healing** makes
the daemon *push back* after `merge_in`: a wiped/reinstalled extension receives
the daemon's persisted state and re-materializes the lock. Suppression prevents
loops; the push-back guarantees convergence to the *stronger* state, which is
the only direction that matters for locks.

### E. Precise self-reference
Self-protection binds to two things the attacker can't cheaply forge: the
daemon's own recorded PID set and the **exact exe stem** of its own binaries
(`smartblocker-*` by exact stem — substring matches like `smartblocker-steam`
get no exemption). Renaming a victim app to a protected stem therefore gains
nothing.

## 3. Investigation & Implementation Steps (in order)

1. **Behavioral fingerprinting** — [`companion/crates/smartblocker-core/src/browsers.rs`](../../companion/crates/smartblocker-core/src/browsers.rs):
   `classify_process` + `has_bypass_flags`, with `BYPASS_FLAG_PREFIXES`,
   `ENGINE_FLAG_PREFIXES`, `NON_BROWSER_HOSTS`, and `NON_BROWSER_CMD_MARKERS`.
   [`procwatch.rs`](../../companion/crates/smartblocker-core/src/procwatch.rs)
   grew a lowercased `cmd: Vec<String>` on `ProcInfo` (selective
   `ProcessRefreshKind::with_cmd` refresh) as the fingerprint input.
2. **Monotonic enforcement clock** — [`enforcer.rs`](../../companion/crates/smartblocker-core/src/enforcer.rs):
   all timing decisions via `now_mono_ms`; extension mirror in
   [`src/background/lock-enforcer.ts`](../../src/background/lock-enforcer.ts)
   (plus the Firefox keepalive alarm below).
3. **Exact-stem/PID self-protection** — `enforcer.rs`: own PIDs + exact
   `smartblocker-*` stems are unkillable; substring lookalikes get no exemption
   (closes vector 9 without opening a namesake loophole).
4. **Reverse-sync + config self-healing** — daemon
   [`daemon.rs merge_in`](../../companion/crates/smartblocker-core/src/daemon.rs)
   merges a wiped extension's state and pushes the persisted copy back down the
   same IPC channel; mid-lock `config.json` edits are merged against
   enforcement-critical fields instead of adopted wholesale.
5. **Paired supervisor + guarded uninstall** —
   [`companion/crates/smartblocker-daemon/src/main.rs`](../../companion/crates/smartblocker-daemon/src/main.rs):
   `smartblocker-daemon watchdog` supervisor that spawns/revives the daemon
   (mutual watch), and `uninstall` refusing to de-register mid-lock. What
   autostart launches is the supervisor, not a bare daemon.
6. **Offline licensing** — [`license.rs`](../../companion/crates/smartblocker-core/src/license.rs):
   `SBPRO1.<payload>.<sig>` keys verified with HMAC-SHA256 against an embedded
   key — fully offline, fail-closed to free behavior, zero network code added.
7. **Policy hardening** — [`policy.rs`](../../companion/crates/smartblocker-core/src/policy.rs):
   Firefox `policies.json` + Chromium hardening entries written from
   Install/Repair; force-install stays gated on the store `update_url` with the
   behavioral watchdog as the universal fallback (honest limits preserved in
   `companion/README.md`).
8. **Firefox parity** — `lock-enforcer.ts` MV3 keepalive so event-page
   suspension can neither stall enforcement nor impersonate a dead extension;
   incognito-access surfacing via `api.extension.isAllowedIncognitoAccess()` in
   [`src/background/index.ts`](../../src/background/index.ts) and the warning UI
   in [`src/options/OptionsApp.tsx`](../../src/options/OptionsApp.tsx) (state
   defaults to "allowed" until loaded, so no false warning flash).
9. **Real icons** for the extension and the Tauri tray app.
10. **Documentation reconciliation** — [`README.md`](../../README.md)
    (15,874-case metrics, multi-prototype System 1 + Focus Context, sub-frame /
    SERP / shadow-DOM coverage, hardened companion section),
    [`ROADMAP.md`](../../ROADMAP.md) (Phase 3 code ✅ vs. external launch ops;
    Phase 4 hardening ✅ vs. installer/hardware logistics),
    [`CLAUDE.md`](../../CLAUDE.md) and
    [`companion/README.md`](../../companion/README.md) (architecture, honest
    policy limits, licensing, extended manual Windows checklist items 8–10).

## 4. Important Alternatives & Tradeoffs

- **User-space watchdog + behavioral fingerprinting vs. kernel/SYSTEM service +
  WFP driver.** A Windows Filtering Platform driver or SYSTEM service would be
  far stronger — but needs a signed driver (EV cert), admin install, and lifts
  the product out of "fully local, zero-install-friction" territory. The shipped
  pairing (supervisor+daemon mutual respawn, cmdline fingerprinting) closes
  every *casual* bypass with zero elevation, keeps Linux/mac viability, and
  honestly documents the residual strong adversary (safe mode, separate OS user)
  instead of pretending to beat it.
- **Offline beta-grace HMAC licensing vs. online activation.** Online
  activation (phoning a license server) enables revocation and seat counting,
  but adds the companion's *only* network code — against the product's entire
  privacy pitch — and creates an activation failure mode on locked-down
  machines. Offline `SBPRO1` HMAC-SHA256 keys verify with no network, can't be
  forged without the signing key, and accept the tradeoff: a leaked key works
  forever (acceptable at $39 lifetime with human support; keybinding to the
  install id in `<payload>` blunts casual sharing).
- **Monotonic anchoring vs. NTP-reconciliation or wall-clock clamping.**
  Querying time servers adds network + failure modes; clamping naive
  "now ≥ last-seen" rules corrupts legitimate long suspends. The monotonic
  anchor treats clock jumps as *paused countdown* — user-hostile time travel
  gains nothing, laptop sleep loses nothing.
- **Reverse-sync healing vs. daemon-authoritative overwrite.** Pushing the
  daemon's state *as an overwrite* would violate the CRDT invariant (a
  legitimately newer extension state could be clobbered). Healing rides the
  same merge in both directions, so convergence — not authority — picks the
  winner, and the winner is always the *stronger* lock.
- **Exact-stem protection vs. full-path/signature verification.** Verifying
  the exe path or Authenticode signature of lookalikes would resist even
  in-place replacement; chosen instead is exact stem + own PID set, which is
  cheap, cross-platform, and sufficient because the masquerade has to *replace*
  a running protected process to inherit immunity.
- **Playwright unpacked-extension dev-mode carve-out.** While `--load-extension`
  alone or `--disable-extensions` alone is treated as a bypass flag, the exact
  pair `--load-extension=X` + `--disable-extensions-except=Y` is exempted in
  `classify_process` because Chromium's Playwright harness (`scripts/e2e-companion-test.mjs`)
  uses that exact flag pair to load the unpacked extension under test.
- **Zero-dependency supersampled PNG/ICO generation (`scripts/generate-icons.mjs`).**
  Rather than adding native image libraries (`sharp` / `canvas`), the icon
  generator rasterizes the shield + keyhole geometry at 8× resolution with
  premultiplied-alpha box downsampling and encodes PNG (`IHDR` + `deflateSync`
  `IDAT` + CRC32) and Windows Vista+ PNG-in-ICO directly in pure Node.

## 5. Verification

**Observed across all verification suites:**

1. **Companion unit + integration + stdio relay tests** —
   `cargo test --manifest-path companion/Cargo.toml`:
   **86 passed, 0 failed (6 suites, 0.67s)** (up from 53 baseline), covering:
   - `browsers.rs`: private/guest/extension-kill flag coverage (`--incognito`,
     `--inprivate`, `--guest`, `-private`, `-private-window`,
     `--disable-extensions`, `--load-extension`), supported-stem downgrade on
     bypass flags, renamed-browser detection via engine flags
     (`brave.exe`→`surf.exe` via `--type=renderer`, renamed Firefox via
     `-contentproc`), and Electron/WebView non-browser exclusions (`code`,
     `app.asar`, `--webview-exe-name`, `--ms-enable-electron-run-as-node`).
   - `enforcer.rs`: exact-stem `PROTECTED_STEMS` self-protection (`smartblocker-steam`
     is killed when `steam` is blocked, while `smartblocker-daemon` is spared)
     and incognito/bypass-flagged browsers routed through the incompatible-browser
     grace + kill path.
   - `license.rs`: RFC 4231 HMAC-SHA256 test vectors, `SBPRO1.<payload>.<hmac>`
     and legacy `sb_pro_` round-trip verification, payload/signature tamper
     rejection, and beta-grace `None` handling.
   - `policy.rs`: Chromium hardening policies (`IncognitoModeAvailability = 1`,
     `BrowserGuestModeEnabled = false`, `BrowserAddPersonEnabled = false`,
     `DeveloperToolsAvailability = 2`) and `write_firefox_policies` disk writer.
   - Live smoke tests against temporary data dirs and IPC sockets: `watchdog`
     subcommand auto-respawning a killed daemon during an active lock,
     `uninstall` refusing mid-lock, `merge_in` reverse-sync healing a wiped
     peer without sync loops, and mid-lock `config.json` / `lock-state.json`
     self-healing within a single tick.
2. **Rust linter** — `cargo clippy --all-targets -- -D warnings`:
   **0 warnings, 0 errors**.
3. **Extension typecheck & dual build** — `npm run typecheck && npm run build`:
   **PASS (0 errors)**; both `dist/chrome` and `dist/firefox` emit with
   `icons/icon-{16,32,48,128}.png` and updated manifests.
4. **TS/Rust lock-math parity** — `node scripts/lock-math-test.mjs`:
   **56 passed, 0 failed**.
5. **Feedback worker test suite** — `node feedback-worker/test/local-test.mjs`:
   **ALL PASSED (17/17 assertions)**.

*Residual honesty:* strong-adversary escapes (Windows Safe Mode, separate OS
account, killing both supervisor and daemon simultaneously via a script, or
pre-lock binary tampering) remain documented rather than claimed as solved —
closing those requires an elevated `SYSTEM` Windows Service and WFP kernel
driver, as recorded in §4.
