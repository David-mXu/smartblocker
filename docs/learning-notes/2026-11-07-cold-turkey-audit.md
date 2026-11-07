# Learning note — Cold Turkey under the hood + SmartBlocker competitive audit

**Date:** 2026-11-07 · **Deliverable:** [`../audits/2026-11-07-cold-turkey-blocker-landscape-audit.md`](../audits/2026-11-07-cold-turkey-blocker-landscape-audit.md) (full report, evidence appendix included) · Supporting research: `../research/cold-turkey-blocker-audit.md`, `../research/2026-11-07-blocker-landscape-research.md`

## The problem

Understand how Cold Turkey Blocker (the market's "toughest" blocker) works internally, benchmark SmartBlocker against it and the wider blocker landscape, and turn the findings into a prioritized improvement plan. Constraint: Cold Turkey was **installed and active on the user's laptop** — zero writes, zero kills, zero private-data reads.

## The method (why it worked)

1. **Agent team split** — four parallel investigations: (a) CT internals via public sources, (b) the *Reverse Engineer Anything* repo (`morluto/rea`, MCP+CLI for agentic reverse engineering; verified via GitHub API) + open-source references (Focuser/Open Turkey/SelfControl/LeechBlock/Chomper), (c) SmartBlocker self-inventory from its own source, (d) the competitor landscape (Freedom/FocusMe/Plucky/SelfControl/LeechBlock/mobile friction apps/AI entrants).
2. **Read-only local forensics** on the user's live install via WSL→PowerShell interop: process listing, component inventory, registry (services + NativeMessagingHosts), firewall rules, the store-shipped Edge extension source, and the settings-UI bundle. Statistics databases listed by name/size **but never opened** (user's browsing data).
3. **Live browsing** (Edge, browser-use) of CT's site/docs/pricing/blocked-page for primary-source feature semantics.

## The decisive evidence

- **No network interception**: CT's 10 Windows Firewall rules are all *Allow* for its own exe; blocking is extension-side URL/title matching decided by the service over Native Messaging (`checkBlockUrl/Title/Adult/YouTube`).
- **Enforcement = one LocalSystem service with a randomized name** (`Power_a17007`), a 0-byte `locked` filesystem sentinel, and four per-component SQLite DBs.
- **The block page is remote-hosted** (getcoldturkey.com/blocked/4.9) with postMessage relays back into the extension — every block pings their analytics.
- CT hardening details read straight from the shipped extension: service-worker neutering at document_start, 500 ms mute/PiP/foreign-iframe watchdogs, Edge Split-View eviction, Google spell-link closure, YT channel retry loop, RTA meta adult detection.
- Landscape: FocusMe's protection ladder (ratchet-only edits, partner activation delays, commitment fees) is the best-documented commitment canon; PNAS 2023 (one sec) is the only RCT — easy-exit + delay beat guilt copy; nobody ships local ML classification + OS enforcement (SmartBlocker's open square).

## Tradeoffs / honest limits

- Several landscape pricing/claims are volatile or vendor-hosted (flagged inline in the report).
- CT macOS internals not directly inspected (no Mac available); Windows findings verified, macOS from docs/anecdata.
- `morluto/rea` star count (440k) verified from GitHub API — implausibly high for a 7-month-old repo; treat its methodology as useful, its popularity signal as unreliable.

## Verification

Every §8 appendix command output is quoted in the report; research agents' full reports saved under `docs/research/`; report file passes a placeholder-free check.

## Round 2 additions (UI/UX + news, same day)

- CT desktop UI dissected from the shipped `web\index.html` bundle (copied read-only; the *running* app was never opened — user settings/stats are private). Findings: VB.NET + unobfuscated binaries (`MyApplication.app`, readable `get_Block*` getters), 4-tab IA (Dashboard/Blocks/Statistics/Settings), verbatim settings schema incl. `blockUserChange` + tunable `extensionGracePeriod`, 10-knob notification system, per-browser install grid ×13.
- Release-notes timeline + product-family template (Micromanager = same .NET recipe).
- News roundup: earn-to-unlock cohort (Clearspace/Habit Doom/ScreenBreak), LockIn MCP (AI-native blocking), Brick hardware press, Freedom lifetime-price cut, FocusMe hike to $17.95/mo, Forest→subs, LeechBlock managed-storage, iOS 27 keeps the adult "Ignore Limit", Android 17 Accessibility clampdown, LA verdict/KIDS Act/Australia-ban.
- UI/UX teardown pack: 7 mental models; Opal = design leader (ADA 2025 finalist, escalating-resistance Waiting Room); one sec = science + worst-onboarding anti-pattern; ScreenZen escalating delays + self-written message; FocusMe/LeechBlock mocked-but-adored.
- New artifacts: `docs/audits/2026-11-07-blocker-ui-ux-and-news.md`, `docs/research/2026-11-07-competitor-ui-ux-teardown.md`, temp files cleaned up.
