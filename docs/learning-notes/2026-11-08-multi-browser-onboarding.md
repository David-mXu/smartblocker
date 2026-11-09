# Multi-browser onboarding and registration repair

**Date:** 2026-11-08

**Scope:** Phase 5 item 11 across the Rust core, companion command contract,
desktop UI, and preview mock. The work is uncommitted. Unrelated worktree files
and both eval datasets were left unchanged.

## 1. Problem and goal

The desktop companion needed to detect supported browsers and offer a useful
per-browser repair flow. The old registration flow was blanket-oriented: it
could write registrations for browsers that were not installed, and the desktop
UI reduced several different facts to one browser-connection message.

The implementation keeps three facts independent:

1. **Installation detected:** positive executable/App Paths evidence exists for
   Chrome, Edge, or Firefox.
2. **Registration healthy:** the browser's Native Messaging registration points
   to the expected manifest, whose contents and host executable read back
   correctly.
3. **Authenticated extension connected:** the daemon has live evidence from the
   extension. Only this fact produces the desktop **Protected** state.

A manifest repair does not install an extension, enable one, or prove that one
is connected. Missing inspection data is also different from evidence that a
browser is absent.

## 2. Underlying concepts

**Native Messaging** lets an extension communicate with a local host process.
Platform-specific registrations (for example, Linux browser configuration
files or Windows registry values) point each browser at a manifest (a file read
by the browser), which identifies that host and its allowed extension grants.
They configure a channel; they do not establish that the extension exists, is
enabled, or has authenticated to the daemon.

**Positive detection** means acting only on evidence that supports the action.
On Unix, a regular file with a browser-like name is insufficient: at least one
execute permission bit is required. Profile directories are not executable
evidence because an earlier installer could create them for absent browsers.
Windows uses App Paths and known installation locations.

**Readback verification** means a successful write syscall is not enough. The
code re-reads the manifest and host, and the Windows health path also re-reads
the registry value before returning `Repaired`.

## 3. Investigation and implementation

### 3.1 Separate inspection from connection status

[`onboarding.rs`](../../companion/crates/smartblocker-core/src/onboarding.rs)
adds typed installation, registration, and repair-result models. Linux
inspection covers Chrome, Chromium, Edge, and Firefox targets. A detected
Chrome/Chromium installation repairs only detected targets. An undetected
Chromium sibling's orphaned manifest does not make an installed Chrome target
unhealthy.

For an undetected browser, orphaned manifests can still be reported, but only
`NotFound` metadata results are omitted. Other metadata/read failures remain
`Unreadable`; they are not downgraded to `Missing`.

### 3.2 Make selected and global repairs explicit

[`main.rs`](../../companion/crates/smartblocker-companion/src/main.rs) exposes
inspection plus selected repair. Selected repair changes only the chosen
browser's registration and has no autostart side effect. The global Settings
action repairs currently detected browsers, reports per-browser successes or
failures, and preserves its historical autostart behavior only after detecting
at least one browser and completing repairs without failure.

Debug-only test mode returns explicit skipped results and performs no
registration or startup writes. Startup is displayed as **Unchanged** rather
than **Off**, because test mode does not inspect or modify the real setting.

### 3.3 Keep UI claims within the evidence

[`BrowsersPage.tsx`](../../src/desktop/pages/BrowsersPage.tsx) always shows
available installation/registration evidence, including while the daemon is
stopped. Only the authenticated connection becomes unknown in that state. An
undetected browser has no repair button. A connected browser may independently
show unhealthy registration and offer repair.

The UI uses backend result text instead of replacing it with blanket success
copy. Instructions explicitly say that repair does not install the extension
and that only an authenticated connection shows **Protected**.

[`mock.ts`](../../src/desktop/mock.ts) mirrors those contracts for labeled
previews. Registration repair never fabricates a `browsers[]` connection.
Unavailable inspection throws for ordinary global repair, while test mode still
returns explicit skip results with `Unreadable` when inspection is absent.

### 3.4 Address the focused review findings

The first static follow-up review found one medium Windows-isolation issue and
five low issues. The corresponding changes are:

- **Windows sibling isolation:** formerly Chrome and Edge new repairs shared
  `dev.davidxu.smartblocker.json`. New writes now use
  `dev.davidxu.smartblocker.chrome.json`,
  `dev.davidxu.smartblocker.edge.json`, and the Firefox-specific path. Healthy
  legacy shared Chromium registrations remain accepted for compatibility, but
  the shared file is never a selected-repair write target.
- **Unix executable evidence:** discovery and Native Messaging host health now
  require execute permission bits. Test fixtures create mode-0755 files;
  negative tests cover a non-executable browser lookalike and host.
- **Honest test-mode startup:** Settings says **Unchanged**, and the mock keeps
  the seeded startup value rather than forcing it off.
- **Mock/shell parity:** test-mode selected repair precedes the missing-data
  error; ordinary global repair rejects unavailable inspection.
- **Stopped-daemon evidence:** disk/registry inspection remains visible and the
  unavailable-inspection warning no longer depends on daemon health.
- **Metadata failures:** only `NotFound` is treated as absence. A deterministic
  regular-file-as-parent `NotADirectory` regression expects `Unreadable`
  without relying on permissions or test UID.

The final read-only follow-up review reported **no actionable findings** and
explicitly closed all six findings. It was a static review; the commands below
are the separately observed verification evidence.

## 4. Alternatives and tradeoffs

- **Treat profile directories as installations:** rejected because repair
  itself could manufacture false installation evidence.
- **Treat healthy registration as protection:** rejected because it says nothing
  about extension installation, enablement, or authentication.
- **Rewrite the legacy shared Windows manifest:** rejected for selected repair
  because it can change an undetected sibling's registration inputs. Compatible
  legacy health remains readable; new writes are browser-specific.
- **Remove all legacy registrations:** not done. Compatible healthy shared
  registrations avoid an unnecessary migration, while a selected repair of an
  unhealthy legacy registration moves only that browser to its selected path.
- **Automatically install extensions:** not attempted. The repair flow provides
  install/enable guidance and limits itself to Native Messaging registration.
- **Collapse all errors into Missing:** rejected because it would turn an
  unreadable system into inaccurate absence evidence and could encourage writes
  from incomplete information.
- **Call preview checks native verification:** rejected. Headless mock tests
  check the UI state machine only.

## 5. Verification

Observed in this Linux/WSL worktree after the review fixes:

- `cargo test -p smartblocker-core onboarding::tests -- --nocapture` — **12
  passed**. Coverage includes selected/undetected repair, readback, sibling
  isolation, execute-bit detection and host health, metadata classification,
  malformed/wrong manifests, test-mode messaging, and portable Windows
  write-path isolation.
- `cargo test` with workspace default members — **180 core + 4 fixture + 2
  stdio integration tests passed**.
- `cargo clippy -p smartblocker-core -p smartblocker-nm-host
  -p smartblocker-daemon --all-targets -- -D warnings` and `cargo fmt --all --
  --check` — passed.
- `node scripts/grace-math-test.mjs` — **24 passed, 0 failed**.
- `npm run typecheck` — passed.
- `npm run build` and `npm run build:desktop` — Chrome, Firefox, and desktop
  frontend builds passed. The desktop command does not build or run Tauri.
- `node scripts/e2e-companion-test.mjs` — **COMPANION E2E: ALL PASSED** with real
  headless Linux Chromium, the built extension, nm-host, and daemon.
- Temporary headless preview suite at `/tmp/opencode/sb-item11/` run with
  `npx playwright test --config=/tmp/opencode/sb-item11/playwright.config.cjs`
  — **10 passed**. Checks include the item 8 countdown **42s → 41s**, selected
  repair without autostart or a fabricated connection, undetected no-op,
  independent protection/registration states, unavailable inspection, stopped
  daemon evidence, test-mode skips, and startup **Unchanged**. The Preview data
  badge was visible.

The Windows isolation regression executes the same browser-specific manifest
write helper used by production Windows repair. It observes that a Chrome write
preserves Edge-specific and legacy shared bytes and Edge's manifest-health
inputs. It is portable path/file coverage on Linux, not a native registry or
Windows execution result.

## 6. Residual limits

- No native-Windows App Paths lookup, registry write/readback, executable, or
  browser was built or run. The `#[cfg(windows)]` shell path still requires the
  item 12 Windows verification environment.
- No real Tauri shell was run. The desktop build and Playwright checks exercise
  the frontend and in-memory mock.
- No extension was installed or claimed to be installed, and registration
  repair was not presented as extension verification.
- The full Linux companion E2E is enforcement/protocol evidence for the combined
  worktree; it is not a native onboarding repair test.
