# Watchdog: a PONG is only healthy from a daemon image

## Why

The watchdog supervisor revives the daemon whenever its liveness probe fails.
The probe already required a protocol PONG (not a bare connect), so an
accept-but-silent socket squatter was caught. But any process that *answers*
the probe — with an arbitrary reported pid — counted as "the daemon is alive",
so a same-user squatter bound to the socket name could suppress respawns and
silently stop hard enforcement while the real daemon stayed dead.

## What changed

- `procwatch::pid_exe(pid)` — best-effort executable path for one pid via a
  selective sysinfo refresh (`ProcessesToUpdate::Some`), plus a pure
  `exe_file_names_match` helper (case-insensitive for Windows).
- `smartblocker-daemon watchdog` now treats a PONG as healthy only when the
  reported pid's executable file name matches the watchdog's own binary
  (`smartblocker-daemon`). Unknown evidence — process exited between frames,
  unreadable image path — is treated as ours, so a transient race cannot cause
  respawn churn; only a positively different executable does.
- Tests: own-process exe identity, a known-different name, and a dead pid
  returning `None`. The existing probe-only/squatter connection tests and the
  full companion e2e still pass.

## Residual (documented)

A same-uid attacker who runs a *copy of the real daemon binary* on the socket
still passes the name check. That is inherent to a same-user soft model; the
check raises the bar from "any process" to "a daemon image", and the real
daemon cannot bind while the copy holds the name.
