# Kill-immunity by identity (recorded PID set) + watchdog mutual respawn

**Date:** 2026-11-06 · **Scope:** companion crate (`smartblocker-core`, `smartblocker-daemon`), `companion/README.md`, `scripts/e2e-companion-test.mjs`
**Red-team findings fixed:** #6 (decoy named `smartblocker-daemon` was kill-immune), #7 (watchdog never in autostart; nothing respawned it)

## 1. Problem

Two HIGH findings from `docs/security/red-team-2026-11-05.md`:

- **#6:** `enforcer::protected()` granted kill-immunity by *exact exe stem*
  (`PROTECTED_STEMS.contains(p.name)`). The README claimed a "recorded PID
  set", but no such set existed. Live PoC: copy `/bin/sleep` to a file called
  `smartblocker-daemon` → completely immune, *more* immune than a renamed
  browser (a renamed browser is still caught by engine fingerprinting).
- **#7:** the XDG autostart entry ran `... run` (bare daemon). The
  `watchdog` subcommand existed but was shipped nowhere, and nothing
  respawned the supervisor. One `pkill -f smartblocker` after login ended
  hard enforcement until the next login.

## 2. Root cause + concept

Trust was bound to **names**, which are free to forge on Linux (the exe
stem is just the filename of the binary you exec). Immunity must be bound to
something the attacker can't choose: **which executable file is actually
running** (the kernel-verified `/proc/<pid>/exe` link) combined with **which
PIDs we observed running *our own executables***.

The `#7` gap was architectural: the mutual-respawn design ("daemon ↔
watchdog") was documented but only half-implemented — the `run` mode never
learned whether it had a supervisor, so there was nothing to revive.

## 3. Investigation → implementation (in order)

1. **Constraint mapping.** The enforcer is deliberately *pure*
   (`tick(state, inputs)` — no IO), and `daemon.rs` (the only caller of
   `tick`, owned by another team in this pass) couldn't be edited. So the
   recorded PID set travels via a **process-global registry inside
   `enforcer.rs`**, and it is refreshed from
   `procwatch::SysinfoSource::snapshot()` — which the daemon's enforcement
   loop calls exactly once per enforcing tick, i.e. the set is rebuilt from
   *the same process list the tick is about to judge*. Snapshot-before-tick
   ordering guarantees consistency; no daemon.rs change was needed.
2. **Identity rule.** Added `ProcInfo.exe` (lowercased full exe path, from
   sysinfo's `exe()` — non-forgeable via renaming or `exec -a`, unlike
   argv[0]). `enforcer::rebuilt_protected_pids(procs, own_pid, own_dir)` is a
   *pure* function: `{own_pid}` ∪ every protected-stem process whose exe
   parent dir equals our own install dir (daemon, watchdog and nm-host all
   ship side by side). This is why the e2e PoC shape — real debug daemon +
   a `/bin/sleep` copy in a temp dir — is covered by construction.
3. **Decoy handling.** Any protected-stem process *not* in the recorded set
   is a hostile probe. In `tick()` it gets a dedicated section before the
   app blocklist: notify once per session (same latch mechanism as blocked
   apps), log `decoy-immune` on first sighting (the failed probe), kill
   immediately with the new `KillReason::DecoyImpersonation`, log
   `decoy-killed`. Kills only exist while enforcing, so decoys are only
   hunted during locks — matching the threat model (a lock is when immunity
   is worth stealing).
4. **Refresh vs. staleness (pid reuse).** The set is fully *replaced* on
   each refresh (`install_protected_pids`), never accumulated — a dead
   watchdog's pid can't linger and protect a future unrelated process that
   reuses it. The pure/rebuild split also keeps unit tests race-free: tests
   exercise the pure rebuild and *add* records; only production code
   replaces the set.
5. **Supervisor respawn (#7).** New `core/supervisor.rs`: the watchdog sets
   `SMARTBLOCKER_WATCHDOG_PID=<pid>` on the `run` child it spawns. A daemon
   started with that env (or with `--watchdog`) launches a background thread
   *before* `run_daemon` that every 2s checks `procwatch::pid_alive(superv)`
   and respawns the watchdog when dead, recording the new pid and writing a
   `supervisor-respawned` line to `events.log` in the daemon's own
   `{wall_ms} {kind} {detail}` format. Env var chosen over a parent-pid
   probe: the spawn is detached (null stdio, re-parented), so the parent
   chain is ambiguous, while the env var is an explicit handle carried with
   the process image.
6. **Autostart.** `registration.rs` now writes
   `Exec="<path>" watchdog` (the watchdog spawns + revives the daemon;
   `run_watchdog` no longer gates revival on an active block — the daemon
   must always exist), and the path is quoted (fixes the adjacent P2 #30 for
   paths with spaces, like this repo's own).
7. **Gating discipline.** Plain `run` (the e2e/PoC shape) keeps its old bare
   process tree: no supervisor thread, no watchdog child — supervision only
   activates via `--watchdog`, the env pid (autostart flow), and remains
   opt-out via `SMARTBLOCKER_NO_WATCHDOG`.

## 4. Alternatives / tradeoffs

- **Global registry vs. extending `TickInputs`:** adding a
  `protected_pids` field would be cleaner wrt. purity but requires editing
  `daemon.rs` (outside this pass's file ownership). The global is a
  documented, reviewable compromise; `rebuilt_protected_pids` keeps the
  decision logic itself pure and unit-testable.
- **Watching the watchdog from the watchdog (systemd `Restart=always`)**
  would be more robust where systemd-user exists, but the project targets
  XDG autostart + Windows Run-key too; an in-process solution covers all
  platforms with one mechanism.
- **Unreadable exe paths** (exe = `None`, e.g. permission kernels) are never
  adopted into the set — fail-strict. Risk accepted: our own processes are
  same-uid, where `/proc/<pid>/exe` is always readable.
- **Not done (P2):** `.desktop` quoting beyond the Exec path line; a quiet
  health-probe (the connect-probe a watchdog uses leaves a
  `relay-disconnect` line per tick in events.log); watchdog should exit if
  autostart registration is gone (post-uninstall revive within the same
  session); `CLAUDE.md:223` still describes the old stem-based claim (owned
  by the other team this pass).

## 5. Verification

- `cargo test --offline` → **93 passed** (new: decoy kill+log+latch tests,
  `rebuilt_protected_pids` install-dir rule incl. unreadable-exe rejection,
  `pid_alive`, supervisor events-log format, autostart Exec assertion).
- `cargo clippy --offline --all-targets -- -D warnings` → clean;
  `cargo fmt --check` → clean; `cargo build -p nm-host -p daemon` → clean.
- `node scripts/e2e-companion-test.mjs` → **ALL PASSED, 3 runs** (one run
  had a pre-existing 5s sync-poll flake; the lock arrived — the dependent
  kill tests still passed — and re-runs are green). New cases:
  `decoy wearing the daemon name closed during forced block`,
  `decoy kill logged`, `killing the daemon → watchdog respawns it`,
  `killing the watchdog → daemon respawns it`.
