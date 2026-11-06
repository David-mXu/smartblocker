# P2 Rust hardening: IPC admission, uninstall guard, dev-flag gating, license reconcile, armed-phase kills

*Date: 2026-11-06. Scope: SmartBlocker companion (Rust workspace under `companion/`) plus the e2e driver. Source requirements: `docs/security/red-team-2026-11-05.md` P2 items #20, #22, #23, #24, #25, and the #7 liveness residual.*

## The problems

Five independent weaknesses, all in the Rust companion:

1. **#20 — the IPC socket had no admission control.** On Linux the daemon
   listens on an *abstract-namespace* socket, which has no filesystem
   permission layer: any local process — including one owned by a *different
   user* — could connect. Connections were unbounded, and every broadcast
   wrote directly to every socket under the registry lock, so one client
   that stopped reading could stall the whole daemon (and a slow consumer
   cost every other client).
2. **#22 — the uninstall guard was inconsistent.** The CLI refused
   uninstall only under `force_blocking` (Frozen Turkey / schedule window),
   so a plain countdown timer could be escaped by simply unregistering the
   daemon.
3. **#23 — the developer launch pair was an undocumented hole.** Chrome
   with `--load-extension=<dir> --disable-extensions-except=<dir>` disables
   every installed extension except the loaded one — indistinguishable at
   the process level from a dev working on the extension.
4. **#24 — licensing failed OPEN.** The old gate (`license.rs is_pro`)
   returned Pro for a missing/empty key ("beta grace"), so deleting one
   line of `config.json` disarmed the license check mid-lock; the README
   also described a key format (base64url JSON claims) the code never
   implemented.
5. **#25 — kills only ran under forced blocks.** The enforcer early-returned
   unless `lock_status.force_blocking`, so during a plain armed timer the
   blocklisted apps, incompatible browsers, decoys, and the watchdog were
   all inert.
6. **#7 residual — liveness was a bare connect.** The watchdog revived the
   daemon when `connect()` failed — but a *squatter* (any process that
   grabs the socket name and accepts connects, answering nothing or
   garbage) looked alive.

## Root causes and concepts

- **Abstract sockets** (`\0name` on Linux) live in a kernel table, not the
  filesystem — there is no `chmod` for them. Admission must therefore be
  checked in-band: `SO_PEERCRED` gives the kernel-authenticated pid/uid/gid
  of the connecting peer at connect time.
- **Backpressure principle**: a fan-out broadcast must never perform a
  blocking write in the loop. The standard fix is a bounded queue per
  consumer with a dedicated writer; overflow evicts the consumer instead of
  stalling producers.
- **Fail-closed design**: every security gate should default to the
  restrictive answer when input is missing or malformed. Development
  conveniences belong behind an explicit, greppable escape hatch
  (`SBPRO_DEV_OPEN=1`), not a silent default.
- **In-band liveness**: "a TCP/IPC connect succeeded" proves only that
  *something* holds the name. Liveness of a specific protocol peer requires
  a protocol-level handshake — here a `ping`→`pong` frame pair carrying the
  instance identity (pid + monotonic uptime).

## What was done (in order)

1. **Verified interprocess 2.4.2's API** rather than adding a dependency:
   it already exposes `peer_creds()` (SO_PEERCRED; `euid()` on Linux) plus
   `set_recv_timeout`/`set_send_timeout`. Own euid is parsed out of
   `/proc/self/status` (field 2 of `Uid:`) — no libc needed.
   → `companion/crates/smartblocker-core/src/ipc.rs` (`own_euid`,
   `peer_euid`, `same_user_peer`, Linux-only, `#[cfg(target_os="linux")]`).
   The gate fails closed **only on a definitive mismatch**: if either uid
   is unavailable the connection is admitted and the pairing layer stays
   the trust boundary (documented in code).
2. **Per-connection bounded outbound queues** (`SyncSender<Arc<Vec<u8>>>`,
   cap 32) + a writer thread per connection. `broadcast`/`reply_to` only
   ever `try_send` under the registry lock; a full queue sets an `evict`
   `AtomicBool`, removes the conn, and logs `conn-evicted`. The reader
   thread polls the flag on a 1s recv-timeout tick. Bonus hardening in the
   same pass: registry cap (64, `conn-refused`), unauthenticated idle reap
   (60s, `conn-idle-reaped`; ping counts as activity; authed conns exempt).
   One frame is serialized once per redaction class (`encode_frame`,
   refactored out of `write_frame`) and shared as `Arc` between queues.
   → `daemon.rs`, `framing.rs`.
3. **Ping/pong liveness** (additive protocol frames, Rust-side only):
   daemon answers `ping{v}` with `pong{v,pid,mono_ms}`; probe-only
   connections don't log `relay-disconnect` (a `meaningful` flag tracks
   whether any non-ping frame arrived). `daemon::probe_ping(socket,
   leg_timeout)` bounds every leg (timeouts + a 4-leg total deadline) so
   the supervisor loop can never wedge; the watchdog (`smartblocker-daemon
   watchdog`) now respawns on probe failure instead of connect failure.
   → `protocol.rs`, `daemon.rs`, `smartblocker-daemon/src/main.rs`.
4. **Uninstall guard** now checks `derive_lock_status(...).settings_locked`
   (any armed reason: timer/password/frozen/schedule) instead of just
   `force_blocking`, message updated to "a lock is active".
   → `smartblocker-daemon/src/main.rs`.
5. **Dev-flag pair gating (#23)** was already implemented in the enforcer
   (the pair is tolerated only while a paired, heartbeating connection of
   that browser kind exists); this task pinned the behavior with unit tests
   and documented it — plus the Electron carve-out (`app.asar` on the
   command line / known Electron stems are never fingerprinted as
   browsers) — in the README.
   → `enforcer.rs` (tests), `companion/README.md`.
6. **License reconcile (#24)**: fail-closed gate with posture labels.
   `check_at(key, now_ms, dev_open) -> LicenseCheck { pro, posture }`:
   missing/invalid → `free-no-key`/`free-invalid`; `SBPRO_DEV_OPEN=1` →
   `dev-open` (covers only the keyless/invalid case — an expired key stays
   visibly expired); valid perpetual or unexpired → `pro`; expired but
   within `EXPIRED_GRACE_MS` (7d) → `pro-grace` (still Pro — renewal
   friction should not disarm a paying user's lock); then `free-expired`.
   Expiry is a payload tail `pro:<id>:<expiry_ms>` parsed with `rfind(':')`
   and a ≥10¹² floor so legacy `pro:<id>` keys — and ids ending in short
   numeric suffixes — stay perpetual. The daemon logs every posture
   transition as a `license` event and pins the key at lock start
   (`heal_license_key`): dropping or swapping it mid-lock is restored with
   the same `config-tamper-restored` event as the blocklist heal; a key
   first installed mid-lock (when none was pinned) is *learned*, mirroring
   strictening-only semantics. Extension-provided `is_pro` callers
   unchanged — `is_pro` is now a thin wrapper over `check`.
   → `license.rs`, `daemon.rs`, `store.rs` (doc), `README.md`.
7. **Armed-phase kills (#25)**: `enforcer::tick` now early-returns only on
   `Phase::Idle`; every armed phase runs the full pipeline (blocklist,
   incompatible browsers, decoys, watchdog). The daemon's loop likewise
   snapshots processes and ticks whenever *any* lock is armed, not only
   under `force_blocking`. → `enforcer.rs`, `daemon.rs`.

## The e2e debugging trail (why a "flaky probe" was a real bug)

The first e2e runs failed the PING/PONG probe with `frame timeout` even
though unit tests and a scratch-daemon repro passed. The decisive evidence
came from bisecting three probe variants against a scratch daemon:

1. An inline parser that attaches `'data'` once at setup: **works**.
2. The original `FrameStream` (attach/detach `'data'` per read): **fails
   every time** — zero bytes ever delivered.
3. Buffer inspection (`readableLength` / `sock.read()`): the daemon's
   352-byte greeting WAS sitting in the stream buffer, yet a `'data'`
   listener attached after it arrived never fired.

Root cause: a Node stream pitfall on unix sockets. The daemon pushes its
connect-greeting within microseconds — during the client's `connect`
handshake window. Bytes that land before the first `'data'` listener
attaches go into the paused stream's internal buffer, and (observed on
Node 24 in this WSL environment) attaching `'data'` later does not flush
them. The production daemons and relays never hit this because they attach
their readers once at connection setup; only my per-read attach/detach
harness helper did. Fix: the accumulator attaches at construction (before
`connect()` resolves) and `next()` merely polls the buffer with a deadline.

Two more harness bugs the same debugging session fixed: the squatter
server's accepted sockets needed an `error` swallow (a probe's RST to the
garbage reply would otherwise crash the harness via an unhandled
`ECONNRESET` — which is what left zombie supervision pairs and a locked
`.e2e-profile` after the first failed run), and the block-screen
observable now accepts the force-redirect generation
(`chrome-extension://…/blocked.html`) alongside the in-page overlay, since
the blockscreen gained a redirect path under a parallel task.

## Alternatives considered / tradeoffs

- **Fail-closed peer gate when credentials are unavailable**: rejected —
  on Linux SO_PEERCRED always answers for stream sockets, so an
  unavailable-credential path is theoretical; failing closed there would
  make the daemon unreachable from any future odd transport. Documented as
  admitted-with-pairing-boundary instead.
- **Blocking `send` with a writer-drain timeout** instead of eviction:
  rejected — it still bounds one conn's slowness into the broadcast path
  latency budget; eviction is cheaper and the e2e/relay reconnects anyway.
- **Cross-uid unit test**: not possible without setuid helpers; the gate
  has a unit test for the same-uid path and the e2e exercises admission
  implicitly (all connections are same-uid there). Flagged as a residual.
- **`settings_locked` includes "password armed with no timer"**: kept per
  the red-team finding's exact wording ("uninstall guard on
  settings_locked"); a user with only a settings password must remove the
  password (they have it) before uninstall.
- **Dev-open applying to expired keys**: rejected — posture logs stay
  truthful if an expired key always reads as expired; devs needing Pro
  perpetual can mint their own keys with `generate_license_key`.

## Verification

- `cd companion && cargo test --offline` — 118 tests green (unit + stdio
  integration; new: same-uid gate, slow-consumer eviction, reply_to
  eviction, conn-cap refusal, ping/pong wire shape, ping probe integration,
  meaningful-disconnect logging, license pin/restore/learn, license
  check_at truth table + expiry boundary, armed-phase kill suites, dev-flag
  pairing).
- `cargo clippy --offline --all-targets -- -D warnings` — clean.
- `cargo fmt --check` — clean.
- `cargo build --offline -p smartblocker-nm-host -p smartblocker-daemon` —
  clean.
- `node scripts/e2e-companion-test.mjs` — **ALL PASSED, exit 0** (final
  clean run; log `/tmp/opencode/e2e-final.log`). New checks: probe
  PING→PONG shape, no relay-disconnect growth, armed timer-only kill,
  uninstall refused (timer + password) / proceeds (expired), squatter
  holds ⇒ no daemon-start / squatter leaves ⇒ daemon re-binds. Two
  mid-development runs were contaminated by a concurrent agent sharing the
  machine (transient debug eprintlns + `.e2e-profile` contention); the
  final run was launched only after verifying the machine was quiet.
- `python3 /tmp/opencode/redteam-companion.py
  companion/target/debug/smartblocker-daemon` — **9/9 PASS** (TOFU hello,
  pre-auth redaction, password-strip, schedule pin, hello-reject,
  pair-while-locked refusal, unlock tombstone + setup arms).

## Residuals (honest)

- Cross-uid negative test needs a setuid helper — not built.
- The TS mirror (`src/shared/companion-protocol.ts`) intentionally declares
  no ping/pong types (companion-internal frames; commented accordingly),
  and its `pro` JSDoc still says "always true this milestone" — left for
  the extension-side team that owns that comment.
- The squatter e2e negative assertion is time-boxed (no `daemon-start`
  within ~5s of squatting): robust locally, but a slow/loaded CI machine
  could stretch probe cycles; the bound is generous, not infinite.
