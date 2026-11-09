# Building and running the desktop companion on Windows (2026-11-08)

## Goal

Run the real Tauri tray app (`companion/crates/smartblocker-companion`) on
Windows — WebView2, tray, notifications, embedded daemon — and pair it with
the extension in Edge, instead of the WSL headless preview from
[2026-11-07-desktop-companion-live-test-wsl.md](2026-11-07-desktop-companion-live-test-wsl.md).

## Environment inventory (verified before building)

- Windows already had: cargo 1.96.1 (`C:\Users\xudav\.cargo\bin`), tauri-cli
  2.11.4, Node 24.12.0, Rust target `x86_64-pc-windows-msvc`.
- Missing and installed during this task: WebView2 runtime and MSVC Build
  Tools (VS 2022, workload `Microsoft.VisualStudio.Workload.VCTools`,
  MSVC 14.44 shipped).
- The app UI is static (`ui/index.html + main.js`, `withGlobalTauri`), so no
  npm/bundler is needed. Plain `cargo build --release -p
  smartblocker-nm-host -p smartblocker-companion` produces BOTH exes
  side-by-side in `target\release\` — the requirement that
  `smartblocker-nm-host.exe` sit next to the app is satisfied without any
  copy step, and no WiX/NSIS bundling is needed just to run it.

## Steps

1. `winget install Microsoft.EdgeWebView2Runtime --silent` — worked first try.
2. VS Build Tools via winget reported "Successfully installed" in under a
   minute but installed NOTHING (no vswhere, no product dirs, no `dd_*`
   logs). Elevated launches from the WSL interop session are denied
   ("Access is denied"), so `start vs_BuildTools.exe` also failed. Fix: the
   USER double-clicked the downloaded
   `C:\Users\xudav\sb-setup\vs_BuildTools.exe`, accepted UAC, installed the
   "Desktop development with C++" workload. Verified afterwards.
3. Staged sources by robocopy (see `copy-sources.bat` below) to
   `C:\Users\xudav\SmartBlocker\` (`companion\` without `target\`, and
   `dist\` for Edge load-unpacked). Repo-side build recipes live in
   `C:\Users\xudav\sb-setup\build.bat` / `run-dev.bat`.

## WSL→Windows interop pitfalls (cost real time; don't re-learn)

- **CMD_OVER_INTEROP mangles quoted paths containing parentheses.** Checks
  like `cmd /c "dir \"C:\Program Files (x86)\...\""` silently error
  ("The filename, directory name, or volume label syntax is incorrect" /
  empty output), which masqueraded as "not installed". **Filesystem checks
  go through `/mnt/c/...` (9P mount), not through cmd.** `.bat` files parsed
  from disk handle quoted paths fine, so execution scripts are safe.
- `cmd.exe` launched from WSL starts on the `\\wsl.localhost\...` UNC cwd
  and warns "UNC paths are not supported. Defaulting to Windows directory."
  — cosmetic.
- `robocopy` exit codes 0–7 mean success (`/E /XD target /NFL /NDL /NJH`).
- winget "Successfully installed" is not proof: verify the payload on disk
  (`/mnt/c/Program Files (x86)/Microsoft Visual Studio/...`).

## Smart App Control blocks local Rust builds

First build died at `zerocopy`'s build script:
`An Application Control policy has blocked this file (os error 4551)`.
Not a toolchain problem — Windows itself refused to execute freshly
compiled, unsigned binaries.

Diagnosis (definitive, via
`powershell Get-WinEvent 'Microsoft-Windows-CodeIntegrity/Operational'`):
event **3077** — `cargo.exe` load of `build-script-build.exe`
"did not meet the Enterprise signing level requirements" — and
`Get-MpComputerStatus → SmartAppControlState : On`. Signed installers
(winget, VS, WebView2) all passed because they carry reputation; local
compilations have none.

Resolution: user turned SAC **Off** in Windows Security → App & browser
control → Smart App Control (explicit consent; permanent reversal caveat
explained — cannot be re-enabled without resetting Windows; verified
`SmartAppControlState : Off` afterwards, no reboot needed). No viable
workaround keeps SAC on: self-signing does not satisfy SAC, and ASR
exclusion paths don't apply to it. This is a standard dev-machine setting
when building unsigned code.

## Verification

- [ ] `cargo build --release` completes; `target\release\smartblocker-companion.exe`
      and `smartblocker-nm-host.exe` exist (build running at note time).
- [ ] App window + tray visible; events in `%APPDATA%\davidxu\smartblocker\data\events.log`.
- [ ] Install/Repair writes HKCU NativeMessagingHosts for Chrome/Edge/Firefox.
- [ ] Edge + unpacked `dist\chrome` shows "Connected — hardcore mode active".

## Teardown

Use the app's uninstall (lock-guarded) to remove NM registration and
autostart; delete `C:\Users\xudav\SmartBlocker` for the files.
