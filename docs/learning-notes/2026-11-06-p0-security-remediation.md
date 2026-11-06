# 2026-11-06 — P0 security remediation (red-team follow-up)

## The problem

The [2026-11-05 red-team audit](../security/red-team-2026-11-05.md) dynamically
confirmed that the product's two core promises were breakable with <20-line
PoCs:

1. **Any blocked page could unblock itself** — the block screen was page-owned
   DOM with a synthetically-clickable override button (#1, #4).
2. **The companion's "hard" enforcement trusted any local process** — the IPC
   socket had no authentication, disclosed the lock password hash pre-auth,
   let a script swap the password, wipe all schedules with a forged timestamp,
   and pacify the watchdog with a fake heartbeat (#2, #3, #5, #8).
3. A secondary medium: `REPORT_FN` wasn't lock-guarded and accepted arbitrary
   `correctedLabel` values → classifier poisoning while locked (#12).

All fixes were implemented and verified on 2026-11-06. This note covers the
design decisions and the verification story.

## Key concepts

### TOFU pairing for local IPC authentication (findings #2, #5)

A local unix socket can't rely on OS permissions (Linux abstract-namespace
sockets have no filesystem ACL — any uid can connect). The design chosen:

- The **extension** generates one UUID per browser profile
  (`storage.local.companionPairing`) and sends it in `hello.pairing`.
- The **daemon** persists known tokens in `config.json pairingTokens`
  (cap 32, oldest evicted).
- **New tokens are adopted only while UNLOCKED.** This is the crucial
  hardening: the pairing set is frozen mid-lock like every other setting, so
  an attacker who connects during a lock cannot self-pair.
- Unauthenticated connections (Tauri UI, scripts, attackers) get:
  - **redacted** status/broadcasts (`password_hash=None`, `password_ts=0` —
    the zero-ts keeps reflected frames merge-safe),
  - their password AND schedule fields **pinned to the daemon's own** inside
    the `lock_state` mutex — i.e. the strip is atomic with the merge, so a
    torn snapshot is impossible,
  - **no browser registration** — forged heartbeats can't pacify the watchdog.

Protocol bumped to v2 on both sides. The nm-host relay already replayed the
cached hello on daemon reconnect, so auth survives daemon bounces with no
relay change.

**Honest residual** (documented in both READMEs): a same-uid attacker who
reads BOTH token stores (browser profile leveldb + daemon config) can still
impersonate the browser. That's the achievable bar for consumer software.

### Tombstone CRDT for password unlock (finding #8)

The old merge kept an armed hash on conflict (`(None, other) => other`), which
made **legitimate unlock impossible while the companion ran** — the daemon
re-armed within a heartbeat. Introducing a monotonic "password epoch" fixes it
without any new message types:

- `LockState.passwordTs` stamps every arm/unlock with `Date.now()`.
- Merge: **greater stamp wins** (unlock tombstone beats an older arm; re-arm
  beats the tombstone); tie → armed wins; two armed → lexicographically
  smaller hash.
- Stamps **clamp to `now`** in both sanitize paths, so a forged future stamp
  can't win every future merge (finding #3's trick, applied to passwords).

The clamp is what makes the tombstone safe: without it, one forged
`passwordTs = now + 30d` would permanently dominate.

### Locked-side-wins for schedules (finding #3)

Schedule lists are ordered by `schedulesUpdatedAt` (LWW). Devtools could wipe
`storage.local` and the forged-future-ts attack could brick the feature. New
rule, mirrored on both sides:

> If exactly one side is settings-locked, the locked side's schedules win.
> Otherwise LWW (with `now`-clamped stamps).

The rule is symmetric → the merge stays commutative (verified case-by-case
during design; the shared fixtures assert commutativity + idempotence per
case in both languages). A side benefit: a devtools-wiped extension now heals
its schedules from the daemon push-back instead of propagating the wipe.

### Block-screen hardening (findings #1, #4)

Closed shadow-root overlay, `!important` styles, a MutationObserver that
re-mounts instantly, `isTrusted` checks on every page-facing button, and a
per-injection nonce the service worker validates on `OVERRIDE` (defeats
replay from arbitrary contexts). The media trap no longer treats overlay
removal as a all-clear.

## The debugging story: a test hang that was a real deadlock

After the last daemon edit, `cargo test` hung with **zero output** — not even
compile progress. Diagnosis, in order:

1. `pgrep`/`wchan` on the stuck cargo: `do_wait` → waiting on a child.
2. The child was a `smartblocker_core` test binary — so compilation was done
   and a *test* was hanging (confirmed by running the test binaries directly:
   the libtests hung, fixtures passed).
3. Running with `--test-threads=1 --nocapture` showed the last started test:
   `unauthenticated_merge_cannot_touch_the_password`.
4. Reading the test found the bug:

   ```rust
   *shared.lock_state.lock().unwrap() = LockState {
       schedules: vec![/* ... */],
       ..shared.lock_state.lock().unwrap().clone()   // ← deadlock
   };
   ```

   Rust evaluates an assignment's **place expression (LHS) before the value
   (RHS)**. The LHS guard lives until the end of the statement, so the RHS
   `lock()` blocks forever on the non-reentrant `Mutex` the same thread
   already holds.

   **Lesson:** in `*mutex.lock() = Struct { ..mutex.lock().clone() }`, the
   struct-update base is evaluated while the LHS guard is held. Clone into a
   local first. A subtler lesson: "cargo prints nothing" doesn't mean "cargo
   is stuck compiling" — pipe buffering (`| tail`) hides test progress, so
   isolate by running the test binaries directly.

## Verification (all green)

| Gate | Result |
|---|---|
| `node scripts/lock-math-test.mjs` (TS/Rust fixture parity) | 65/65 PASS |
| `cargo test` (workspace, no `--workspace`) | 83 + 4 + 2 PASS |
| `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` | clean |
| Red-team companion PoC re-run (`/tmp/opencode/redteam-companion.py`) | 9/9 defenses hold |
| `node scripts/e2e-test.mjs` (extension) | ALL PASSED |
| `node scripts/e2e-companion-test.mjs` (real Chromium + real daemon kills) | ALL PASSED |

The PoC is now written against the **post-fix contract** (PASS = attack
fails): pre-auth disclosure redacted; password arm/swap/clear from unpaired
connections stripped; forged-future-schedules wipe rejected; unpaired
hello/heartbeat rejected (`hello-rejected` in events.log); pair-while-locked
refused; and — as a regression guard — a paired unlock tombstone propagates
and persists.

## What remains (P1/P2, per the report)

Clock-drift cumulative anchor (#10), watchdog autostart + mutual respawn (#7),
PID-set kill-immunity (#6), oEmbed policy + privacy disclosures (#9, #17),
fail-closed classification during forceBlocking (#13), override
scoping/normalization (#14), sanitizer mask hardening (#16), timezone
anchoring (#26), then the P2 list.

## Files touched (P0-3/P0-4 core)

- `src/shared/lock-math.ts`, `src/shared/lock.ts`,
  `src/shared/companion-protocol.ts`, `src/background/companion.ts`
- `companion/crates/smartblocker-core/src/lock_math.rs`,
  `merge.rs`, `protocol.rs`, `store.rs`, `daemon.rs`
- `companion/crates/smartblocker-core/tests/fixtures/lock-cases.json`
  (rewritten: `passwordTs`, `now` on merge cases, new
  tombstone/locked-schedules/clamp cases)
- Status updates: `docs/security/red-team-2026-11-05.md`, `CLAUDE.md`,
  `companion/README.md`
