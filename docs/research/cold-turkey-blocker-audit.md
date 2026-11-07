# Cold Turkey Blocker — Technical Architecture Audit
*(Public sources only, researched 2026-11-07. Documented facts vs. anecdote marked.)*

## 1. Website blocking mechanism

Cold Turkey does **no network-layer blocking**. There is no local proxy, no DNS filter, no hosts-file rewrite (anymore), no WFP/firewall filter, and **no TLS MITM** (no root cert — hence no cert warnings). Blocking happens **inside the browser, by a required companion extension**:

- Official troubleshooting Step 5 for "website not blocked": *"Make sure the extension is installed and enabled"* (chrome://extensions / about:addons) — the extension is the enforcement point. [U1]
- Tech Lockdown (third-party): *"Cold Turkey works at the browser level… DNS Filters work at the network level"* — CT must be paired with DNS to cover the network layer. [T1]
- Tooltivity read the shipped Chrome bundle v4.9.7 (unminified, ~2,100-line background script): the extension sends **page URL + title to the desktop app over Chrome Native Messaging**; the desktop app decides/enforces blocks, allowances, and statistics. [T2]
- Consequences confirming extension-level blocking: *"block list is based entirely on what is in your browser's address bar"* (embedded YouTube in other sites is not blocked unless "block embedded content" is on) [B1]; release notes *"Blocks now work when using a VPN"* (v3.1) [N1] — a VPN can't defeat it because nothing is intercepted.
- **Block page**: hosted remotely on getcoldturkey.com and loaded in a frame (privacy policy confirms block-page URL parameters; Tooltivity notes it carries the maker's analytics + Paddle payment script — mild privacy wart, since visiting a blocked site pings their server). [P1][T2]
- History: pre-3.x versions used hosts-file entries and text-file settings (SuperUser 2018); v3.1 made *"Browser Extensions … now required"* and dropped Edge/IE. [S1][N1]
- macOS vs Windows: same extension-based design on both. macOS additions: Safari extension supported (no block-page features); app needs **Full Disk Access** solely to verify the Safari extension's enabled state (no Apple API exists). [P1][P2]

## 2. Application blocking mechanism

Done by a **resident background service/daemon**, not by the extension:

- Windows: *"Blocker uses a background service to block applications"* — reinstall via `C:\Program Files\Cold Turkey\CTServiceInstaller.exe`. Windows build requires **.NET 4.8** (C# app); admin rights mandatory. [U1][SR1]
- Config methods (Pro): exe path, whole folders (also blocks browsing the folder on Windows), Microsoft Store apps (Windows), and **window-title matching** (Windows-only; matches browser tabs' titles too — then only the page is closed/blocked). Blocked exes are **locked at the filesystem level** so they can't be moved/renamed mid-block. macOS: .app bundles, folders, raw binaries (e.g., Java). [U1][F1]
- Mechanism is process-termination style ("you can test this by ending the process… if this doesn't close the app"). [U1]

## 3. Lock / anti-tamper system

Documented (user guide + features page) [U1][F1]:

- **Locked block automatically**: neuters the uninstaller (fails on "Next"), *requires* the extension enabled in every browser (desktop closes the browser otherwise; 60s default grace, re-checked every 10s), disables some Settings > Blocking options, blocks Brave Tor windows/guest browsing and blocks "unsupported browsers" outright.
- **Process resilience**: watchdog-style self-restart — killing CT processes, they reappear within ~2s (SuperUser 2018); macOS: launchd daemon relaunches processes and a plist is used for startup (r/MacOS + r/coldturkeyblocker reports — anecdotal). Blocking Task Manager/Activity Monitor is an optional setting (removes the "small delay" while it restarts). [S1][R2]
- **"Block browsers if extension crashes"**: closes the browser if the extension is killed via the browser's own task manager or its processes ended. [U1]
- **Clock protection**: optional block of time/date settings (Settings app on Windows, System Preferences on macOS); guide tells users to app-block cmd/PowerShell/regedit for other paths (community guides do exactly that). [U1][R1]
- **"Block the installer"** setting defeats a known rerun-installer bypass. [U1]
- Lock types: **Timer** (extendable), **Time range**, **Random text** (1–999 chars per guide/CLI; marketing says up to 5,000 — docs conflict), **Delay** (1 min–40 days), **Schedule**, **Restart-to-unlock**, **Password** (Pro). Separate settings password blocks viewing/editing settings and "can't be removed without a full reinstall". [U1]
- **Safe mode**: CT does *not* survive/prevent Safe Mode by itself (rename the install folder there — Reddit consensus; an official `Blocker_Removal_Tool-*.exe` exists for recovery). Community hardening: `reagentc /disable`, five `bcdedit` flags, blocking msconfig. Documented bypasses closed over time: hidden uninstaller page, hosts-file edits, clock changes, registry edits, reinstall trick; v4.7 "Added more anti-tampering mechanisms". Remaining anecdotes: renaming `ServiceHub.Power`/`ServiceHub.Helper` + `CTMsgHost{Chrome,Edge,Firefox}` exes (2022), editing `data-app.db` (see §5), Revo Uninstaller registry sweep. [S1][S2][R1][L1][N1]
- **Frozen Turkey** = device block: lock / log off / shut down the machine (macOS shows the login screen); timer or weekly schedule; combined with the above since settings can't change while active. [U1][N1]

## 4. Feature surface

Multiple named block lists (each with Websites, Exceptions, Applications tabs); wildcards (`*`), `*.*` = whole internet + exceptions = whitelist; category imports; text-file import/export; YouTube-channel block/allow; keyword-search blocking via URL wildcards; optional `file://` blocking. Breaks: **Pomodoro, Allowance** (rolling or per-block/day/week/month with refill, idle-aware), **Reward**, random-text/delay breaks, **Sessions**. Weekly repeating schedules; **Autostart** triggers (one-time, time-of-day, sign-in/wake, next scheduled). **Statistics**: per-site/app usage time, includes incognito, survives browser-history clears, JSON export, per-user. **Custom user selection** (per Windows/macOS account, Pro), settings password, CLI (`-add/-start/-stop/-toggle`, `-lock`, `-password`, `-random-text`) enabling third-party automation (e.g., Raycast). "Pause for a Cause" donate-WWF-for-10-minutes on the block page. Platforms: Windows 7 SP1–11 (.NET 4.8), macOS 10.14.5+ (Swift); ~30 supported browsers incl. Arc/Zen/Floorp/Mullvad/Safari; **no Linux/ChromeOS/mobile**. Pricing: Free (websites, exceptions, timed blocks, stats) + 7-day Pro trial; **Pro US$45 one-time**, lifetime updates, all personal machines, student −20%, 30-day refund (Paddle). Pro unlocks: app blocking, schedules, all locks, password, custom users, breaks/allowances. [F1][U1][PR1][SR1]

## 5. Data & privacy

Settings/statistics live at **`C:\ProgramData\Cold Turkey`** in SQLite files (e.g., `data-app.db` holding a JSON "settings" blob — lengrand.fr edited it to disable blocks; feasibility today unverified, likely hardened). Stats local-only, deletable, JSON-exportable. Phone-home is minimal: update check at launch; remotely hosted block page (params: version, pro status, pause-for-a-cause, top-frame flag) and donation-break key check hit their servers; security logs keep these ≤2 months; website/ block page runs self-hosted Matomo analytics. Policy: no collection of settings, web/search history, or what was blocked; Paddle (UK) for payments; Canadian company (Cold Turkey Software Inc., Ottawa; solo dev Felix Belzile). Install footprint: Windows service (`CTServiceInstaller.exe`), native-messaging host binaries (`CTMsgHost{Chrome,Edge,Firefox}`), watchdog exes, startup entries, admin required; macOS: /Applications bundle + launchd plist, Full Disk Access (Safari only). [L1][P1][S2]

## 6. Browser extension architecture

Chrome store listing v4.9.7 (Aug 2026), 200k users, 270 KiB, **Manifest V3** (per browsers.to + Tooltivity's package read — treat as high-confidence third-party). Permissions: `nativeMessaging`, `tabs`, `idle`, `storage`, `notifications`, `alarms`, host `*://getcoldturkey.com/*`; content script runs on all pages. The extension is a **thin sensor/actor**: reports URL+title over Native Messaging, redirects/blocks on the service's word; *"to be used only in conjunction with the desktop software"* — inert alone. Removal/disable during a locked block → desktop closes the browser (store warning). Requires incognito permission and "On all sites" access; per-profile install needed. URL matching: domain, path-prefix, `*` wildcards, regex-like keyword patterns (wildcards only, no true regex documented). AMO Firefox listing is gone — Firefox extension is now side-loaded from getcoldturkey.com. [C1][T2][B2][U1]

## Sources
- [U1] getcoldturkey.com/support/user-guide/ · [F1] /features/ · [PR1] /pricing/ · [P1] /privacy/ · [P2] /support/extensions/mac/safari/full-disk-access · [SR1] /support/system-requirements/ · [N1] /news/
- [C1] chromewebstore.google.com/detail/pganeibhckoanndahmnfggfoeofncnii
- [T1] techlockdown.com/articles/cold-turkey-blocker · [T2] tooltivity.com/extensions/cold-turkey-blocker · [B2] browsers.to/extensions/cold-turkey-blocker
- [S1] superuser.com/q/1366153 · [S2] superuser.com/q/1696158
- [L1] lengrand.fr/on-gaming-addiction-and-working-around-coldturkey/
- [R1] reddit.com/r/coldturkeyblocker/comments/1i7hbra (maximum-security guide) · [R2] r/MacOS + r/coldturkeyblocker removal threads (r/nosurf 1cqcy4b incl. removal-tool link) · [B1] brianmeeker.me blog
