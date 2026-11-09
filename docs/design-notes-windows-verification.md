# Windows companion verification and hardening baseline

**Status (2026-11-08):** acceptance design only. Linux/WSL tests, headless
browser tests, desktop mock previews, and frontend builds are not evidence for
this item. No randomized Windows service, binary file-lock, or Task-Manager
protection claim is made until the corresponding real-Windows checks pass.

## Threat model

### Assets

- The daemon's active lock decisions and monotonic deadlines.
- The persisted ordinary-blocking value and lock state after a restart.
- Availability of the enforcer, native-messaging relay, and supervisor.
- Integrity of companion executables, updater/uninstaller, registration, and
  policy configuration while a lock is active.
- Browser pairing and the privacy of lock metadata exposed over local IPC.

### Primary adversary

A person at the logged-in desktop, or code running with that same standard
user's rights, tries to bypass an active self-imposed block. Examples include
Task Manager, `taskkill`, `Stop-Process`, `sc.exe stop`, deleting or replacing
an executable, launching an unprotected browser, disabling an extension, or
editing/wiping browser storage.

A different unprivileged Windows user must not control or read this user's
companion channel. Operating-system object ACLs and authenticated protocol
rules, not hidden process/service names, must provide that boundary.

### Explicit residual

An administrator, SYSTEM, kernel debugger/driver, offline disk editor, or a
person who can reset/reinstall the operating system can defeat consumer
self-control software. Hardening can raise the cost and preserve evidence but
must not claim proof against those actors. Full same-user access to both the
browser token store and daemon pairing configuration also remains the existing
impersonation residual.

Failure design must avoid an anti-tamper mechanism becoming an availability
attack against its owner. Standard tasks outside an active lock, supported
lock expiry, browser execution, and an eventually recoverable service/updater
must keep working.

## Required mechanisms and acceptance invariants

### 1. Windows service identity and authorization

Cold Turkey uses a randomized service name. SmartBlocker may adopt that tactic,
but a random name is **obscurity and decoy resistance, not authorization**.
A production design must specify:

- the service/host split between session-0 enforcement and the per-session
  tray/notification UI;
- how the locally authenticated desktop user is mapped to the service's IPC
  ACL, command schema, data directory, and browser profile;
- a cryptographically random, persisted service identity if randomization is
  implemented, with no collisions between installs/uninstalls;
- restrictive service control and executable-directory ACLs. A service cannot
  trust an allow/deny decision supplied only by a mutable client-side config;
- service recovery and updater behavior that cannot shorten or clear a lock.

The current per-user daemon + supervisor may be adequate for the primary threat
until a service exists, but it is not equivalent to a protected Windows service
and must not be described as one.

### 2. Executable file locks during active blocks

A file-lock implementation must define exactly which companion and blocked app
paths are opened, when handles are acquired/released, and which Windows sharing
flags allow required execution/read access while denying rename, deletion, and
replacement. The implementation must handle long paths, case-insensitive paths,
missing files, reboots, and blocked binaries on different volumes.

Lock expiry, shutdown after unlock, and a crash/restart must not leave stale
handles or permanently lock a browser or native-messaging executable. Installer
and updater behavior must follow the same active-lock guard; closing a handle
must not be an unauthenticated client-side operation.

### 3. Task-Manager / process-killer protection

This is an optional supporting control, not the foundation of enforcement.
The product decision must say whether task/process managers are closed,
selectively denied companion-process handles, or only monitored. A disposable
blocklist of `Taskmgr.exe` alone does not stop `taskkill`, WMI, PowerShell, or
alternate process tools and must not be presented as complete protection.

No implementation may kill its own protected service, supervisor, native host,
session UI, or unrelated process with a reused PID/name. Protection should end
when the lock ends and must not trap a standard user without access to recovery.

## Real-Windows acceptance matrix

Run against a clean, current Windows installation on **real hardware**, using a
standard-user desktop plus elevation only for the installer/service action.
Record Windows build, activation/reputation mode (including Smart App Control),
account type, binary signature status, and exact source revision for each run.
No WSL process view or Tauri mock preview substitutes for these observations.

| Area | Required observations |
| --- | --- |
| Service identity | Actual `sc.exe qc`, registry ACLs and service PID match the installed identity; randomized name (if present) persists across reboot; uninstall removes only that installation's identity. |
| Service authorization | Standard-user stop/delete/config writes fail through Task Manager, `sc stop`, `net stop`, `taskkill`, and `Stop-Process` as applicable; a different unprivileged user cannot access the IPC channel. |
| Recovery | Administrator-initiated kill of enforcer and supervisor causes the designed recovery without weakening the lock; repeated kills and PID reuse cannot kill innocent processes. |
| File locks | During a lock, tested companion and blocked binaries cannot be deleted, renamed, overwritten, or replaced by the standard user; required read/execute behavior still works. Handles are released after the supported lock end. |
| Browser health | Chrome, Edge, and Firefox actually pair through their real native-messaging registrations; the relay still starts while executable protections are active; Item 11 repair never claims to install or verify the extension itself. |
| Task-Manager protection | The selected behavior works for real Task Manager and configured alternate tools; ordinary recovery remains possible; closing/reopening after lock expiry works and no protected companion component is accidentally killed. |
| Clock and persistence | Clock rollback/admin-forward jumps, service restart, reboot, and storage wipe cannot shorten a lock; persisted ordinary-blocking and lock authority return consistently. |
| Install/uninstall | Clean install, repair, guarded uninstall during lock, supported uninstall after unlock, and upgrade preserve their documented invariants and read back actual registry/filesystem results. |

Any failure blocks the corresponding hardening claim and remains recorded with
platform/build evidence. A Linux unit test of Windows path or registry logic is
useful regression coverage, but only the real-Windows row closes that row.

## Relationship to other roadmap items

- Item 11 established registration detection/repair and storybook/test coverage;
  its Windows registry/App Paths execution remains subject to this matrix.
- Item 13's same-user socket commands must keep lock checks on the **daemon**
  side. An unprivileged command cannot shorten a lock even if a future service
  architecture changes transport.
- Native enforcement claims must name the boundary that actually passed:
  headless daemon, native-messaging host, service, real Tauri tray/UI, browser,
  file/registry result, or process observation. One does not imply the others.
