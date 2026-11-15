# Partner arm stamps, the IPC auth gate, and what "reference time" means in the drift detector

## 1. The problem

Three small security/robustness faults in SmartBlocker's lock machinery,
found in the 2026-11-15 audit fix round:

1. **Drift-detector asymmetry** (`src/background/lock-enforcer.ts`): the
   background service worker guards duration locks against OS-clock tampering
   with two detectors — a loud per-tick jump (> 60 s in one 5 s interval) and
   a cumulative-drift anchor that catches many small forward nudges. Both
   call `shiftActiveDeadlines(referenceWallMs, shiftMs)`, which only extends a
   deadline that is still in the future *relative to the reference*. Detector
   1 passed the **previous tick's** wall time; detector 2 passed **now**.
2. **Partner arm stamping** (`companion/.../daemon.rs`): "accountability
   partner" locks are LWW-merged across the extension and desktop daemon with
   a `partnerArmUpdatedAt` stamp. The release path stamped
   `max(now, prev + 1)` (strictly upward) but the arm path stamped raw `now`.
3. **Partner command authentication**: the four partner IPC commands
   (`addKey`, `arm`, `beginOperation`, `redeem`) were accepted from any
   same-uid connection, while every *outbound* frame already redacted partner
   fields for unauthenticated peers.

Why it matters: the whole product is a self-binding lock, so the interesting
attacks are not malware — they are *the user*, tomorrow, at 2 a.m., nudging
the clock or replaying stamps to shave minutes off their own lock.

## 2. Concepts

- **Reference time vs. current time**: "this deadline already expired" is a
  judgment against a chosen reference. If the clock has drifted forward, the
  *current* wall time lies; the last known-honest instant is a safer
  reference for deciding what is still alive.
- **LWW (last-writer-wins) merging**: peers merge by comparing update stamps;
  `merge.rs` resolves partner fields with "newer stamp wins, tie keeps the
  arm, then deterministic tiebreak". A write stamped *behind* your own
  stored stamp is silently discarded — so a stamp that lags can wedge a
  subsystem forever, not just briefly mis-order.
- **Strictly-upward stamping**: when any peer is allowed to reject
  non-increasing stamps (the extension's partner pin does), writers must
  guarantee `new_stamp > old_stamp` even across clock regressions. The
  standard idiom is `stamp = now.max(prev + 1)` — `max` gives normal behavior
  when the clock moves sanely, `prev + 1` guarantees strictness when it
  doesn't.
- **Two trust classes on one IPC socket**: the daemon knows "paired browser"
  (authenticated via a TOFU pairing token in its hello) vs. "everything
  else same-uid". The security principle applied here: sensitive *write*
  paths must be gated on the same trust that already protects their *read*
  paths, or the outbound redaction is theater.

## 3. Investigation and implementation

**Fix 1.** I read `checkClockSkew` and traced what `referenceWallMs` does in
`shiftActiveDeadlines` (only deadlines `> reference` get shifted). Detector 2's
band `(nowWall - unexplained, nowWall]` contains deadlines the tampered clock
*leapt over* — still genuinely in the future, but "expired" when judged
against the drifted `now`. That is exactly the class of loss detector 1 was
written to prevent, so I made detector 2 use `prevWallMs` too. Fail-safe
direction is preserved: deadlines that expired before the last honest check
(≤ prevWallMs) still get nothing, and backward drift still never compensates
(it only lengthens locks).

Evidence I could not dismiss: there is **no Node harness for this file** — it
imports browser APIs and lives only in the SW bundle. So the claim rests on
reading the function plus the unchanged pure-math neighbors
(`lock-math-test.mjs` 184 PASS, `lock-types-test.mjs` 26 PASS,
`grace-math-test.mjs` 24 PASS, `npm run typecheck` clean).

**Fix 2.** I read the redeem path first (per the task instruction) and found
`release_stamp = now_stamp.max(previous_stamp.saturating_add(1))`. Mirroring
it in `partner_arm_at` is safe by construction: when `prev < now` the `max`
picks `now_stamp` — bit-identical to the old code — and only the
previously-doomed `prev >= now` case changes behavior. The reachable
`prev > now` scenario: the redeem path itself can legitimately persist a
stamp ahead of the wall (`prev + 1`), and `partner-state.json` (which gates
command admission via its own `lastObservedAtMs` clock-rollback check) can
re-initialize independently of `lock-state.json`, so a later arm can pass the
partner-store check while the lock store still carries the forward stamp.

The decisive evidence for "the merge really would refuse forever":
`merge.rs` resolves partner fields with
`partner_arm_updated_at: Some(a_partner_ts.max(b_partner_ts))` — a candidate
armed below the stored stamp loses, reproducing daemon-side
"partner arm merge did not select the new generation".

**Proving the test bites:** I temporarily replaced the fixed line with the
pre-fix stamping and re-ran. The new Rust unit test failed with exactly the
predicted message; the new Python PoC likewise refused the re-arm. Then I
restored the fix and re-ran everything green. A regression test that has
never watched the bug fail is just a prayer — flipping the fix off for one
run is cheap insurance.

**Fix 3.** The instruction was to gate on `authed` "like the password/schedule
writes". Before writing it I searched for every sender of the four partner
messages to make sure the gate only bites attackers:

- Extension `companion.ts` hellos with a pairing token via the NM relay →
  authenticated, unaffected (this is the flow `e2e-partner-test.mjs` drives).
- Tauri UI crate: no partner senders at all (it is auth-less by design).
- **`crates/smartblocker-daemon/src/main.rs` `partner` subcommands**: these
  send over `send_command`, which never hellos — the gate now refuses them.
  That is a documented CLI feature (companion/README.md). I implemented the
  gate as directed and flagged the CLI consequence prominently in the report
  instead of silently widening scope into `main.rs` (where a naive fix —
  having the CLI hello as a "browser" — would corrupt the watchdog health
  check by registering a fake browser from an idle CLI connection).

The gate reuses the connection-loop's `authed` bool (set by the TOFU hello)
and replies with the same `CompanionMessage::Error` frame shape as
`update_browser_blocking`'s refusal — a new frame type would just give a
future attacker a fingerprinting oracle and a future maintainer one more
shape to keep in sync.

**Fix 4 (PoCs).** `security-companion-test.py` drives the real daemon binary
over its abstract socket. Case 10 sends all four partner commands on fresh
unauthenticated connections and asserts the error frame *and* that
`partner-state.json` still has zero keys (a refusal alone doesn't prove no
state was written). Case 11 needed a *second* scratch daemon: the main one is
password-locked by earlier cases, and partner arm is refused while any lock is
active — so I seeded a fresh data dir with (a) `lock-state.json` carrying a
60-seconds-ahead `partnerArmUpdatedAt` (the post-release, post-regression
state) and (b) an already-activated partner key using the exact seed shape
from `e2e-partner-test.mjs` (both the wall and monotonic activation
dimensions have to look past, or startup `rehydrate` imposes a fresh 24 h
wait). One subtlety found on the first run: `partner_arm_at` broadcasts the
new `lockStateSync` to every connection *including the sender* before the
`commandResult` ack, so the PoC drains frames until the ack instead of
reading exactly one frame.

## 4. Alternatives and tradeoffs

- Detector 2 could instead have shifted *all* deadlines up to the anchor
  origin — rejected: it would compensate genuinely expired locks, changing
  the fail-safe contract.
- For Fix 3, making the CLI authenticate (hello with a token read from
  `config.json`) would preserve the README flow — equivalent in power to the
  documented residual ("a same-uid attacker who reads both token stores can
  pair as the browser"), but it needs a non-browser identity on the Hello
  wire (so it cannot register into the watchdog's browser health check) and
  touches `main.rs`/`send_command` outside this round's file scope. Left as
  an explicit follow-up decision for the team lead.

## 5. Verification (all real runs, 2026-11-15)

- `cd companion && cargo test` (no `--workspace`): 317 passed / 0 failed
  (core), including the new
  `partner_rearm_after_a_forward_stamped_release_stamps_strictly_upward`;
  plus 4 merge-fixture tests, 2 nm-host stdio tests.
- Both new tests were **shown to fail against the pre-fix code** (Rust unit:
  "rearm behind a forward-stamped release must not be refused forever";
  Python case 11: rearm refused, disk stamp frozen at the previous high),
  then re-verified green after restoring the fix.
- `cargo clippy --all-targets -- -D warnings`: clean. `cargo fmt --check`:
  clean.
- `python3 scripts/security-companion-test.py`: **14 passed, 0 failed**
  (previously 9 checks; +5 from cases 10–11).
- `node scripts/lock-math-test.mjs` 184 PASS · `lock-types-test.mjs` 26 PASS ·
  `grace-math-test.mjs` 24 PASS · `npm run typecheck` clean.
- No direct test exists for `lock-enforcer.ts` itself (browser-bound) —
  stated as an honest limit, not smoothed over.
- Not run: `scripts/e2e-partner-test.mjs` / `scripts/e2e-companion-test.mjs`
  (outside this round's required list; the Python case 11 exercises the same
  authenticated-relay wire path the extension uses).

Report for the team lead:
`.audit-swarm/builders/builder-drift-lock-report.md`.
