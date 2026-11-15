# Nightly E2E lane + the allowance DOM-id contract: verify scraped findings against source

## The task

Two things went in together:

1. **Contract docs**: `docs/design-notes.md` §7 (the DOM-id contract the e2e
   suites depend on) had no `#allowance` section at all, and no explicit
   `#preferences` ids, even though the "Breaks & allowance" page is a
   first-class route. A vision audit (`.audit-swarm/vision-options/findings.md`)
   supplied a scraped id list to write in.
2. **A nightly GitHub Actions lane** (`.github/workflows/nightly-e2e.yml`) that
   runs the Playwright e2e chain CI deliberately avoids (see security.yml's
   "flake farm" comment) — so those suites still get a scheduled, human-reviewed
   gate.

## The core lesson: a scraped DOM list is a hypothesis, not a contract

The audit's findings listed 24 ids for `#allowance`. I grepped every one
against the actual sources (`src/options/pages/AllowancePage.tsx`,
`src/options/pages/FocusCycleSection.tsx`, and all of `src/`). Seven did not
exist anywhere:

- `#reward-badge` — the real id is `#reward-status-badge` (`AllowancePage.tsx:254`).
- `#relief-claim-btn`, `#relief-status` — the relief action buttons
  (`AllowancePage.tsx:304-322`, "Use allowance" / "Open a session" /
  "Pomodoro break" / "End allowance" / "Close opening") carry no ids at all;
  their *button text* is the contract.
- `#focus-cycle-work`, `#focus-cycle-break`, `#focus-cycle-save` — the real ids
  are `#focus-work-minutes`, `#focus-break-minutes`, `#focus-cycle-start`
  (`FocusCycleSection.tsx:84-97`).
- `#partner-enforcement` — the partner UI is a different component
  (`PartnerSection.tsx`, section title "Accountability partner") that renders
  on the `#locks` page (`LocksPage.tsx:712`), not inside `#allowance`.

The list also missed live ids (`#allowance-msg`, `#focus-mode`,
`#focus-cycle-count`, `#focus-cycle-cancel`, `#focus-cycle-msg`,
`#reward-progress-bar`, plus the whole focus-cycle set).

Why this matters concretely: §7 is the acceptance baseline e2e suites are
written against. Writing an invented id into it would send a future test
author straight into a broken selector. "Wrong ids are worse than absent ids" —
so the rule applied was: every id written into §7 must be greppable in the
source component, and where possible confirmed as already load-bearing in an
existing suite (`scripts/e2e-allowance-test.mjs` and its daemon/reward siblings
already assert most of them — a second, independent confirmation that the ids
are real and stable).

An extra corroboration path used: the audit also got the *file attribution*
wrong in places (its "§7:451" prose citation was actually §5's page list;
`#preferences` had no §7 entry at all — so Task 1 became "create the entry",
not "append to an existing line"). Scraped summary and real file can drift in
*where* a thing lives as well as *what* it is; always locate by grep, never by
the report's line number.

## Building the nightly lane — decisions from reading the failures first

The lane design came from checking what each suite actually does at startup
(not what docs claim):

- **Rust toolchain goes BEFORE the chain, not just for the last suite.** The
  brief assumed only `e2e-companion-test` needs cargo. In fact
  `e2e-allowance-daemon-test.mjs:65` `cargo build`s nm-host + daemon itself,
  and it runs 3rd in the ordered chain. Reading the third suite's imports
  before writing the yml moved the `dtolnay/rust-toolchain@stable` step up top.
- **`mkdir -p /tmp/opencode`.** Several suites `mkdtempSync('/tmp/opencode/…')`,
  which throws if the parent dir is missing — that dir only exists because the
  dev machine has it. A CI lane written from docs alone would fail on the
  very first such suite with an unhelpful ENOENT.
- **Exit-code capture without pipes.** Requirement: each suite logs itself and
  keeps its own exit code (`node x.mjs > log 2>&1; echo $? > exitcodes/x.exit`),
  the chain step itself does not exit non-zero, and a *summary job* fails the
  workflow. Two implementation gotchas: GitHub's default bash runs with `-e`,
  so the step must `set +e` or the first failing suite would abort the rest;
  and step outputs are passed to the summary job via `needs.<job>.outputs`, not
  re-derived, with `if: always()` so a build-stage failure still trips the
  verdict.
- **Model cache keyed on a pinned constant.** The ~35MB embedding model
  downloads into each Playwright profile's `CacheStorage`, keyed on
  `EMBED_MODEL_REVISION` in `src/shared/config.ts`
  (`ea104dacec62c0de699686887e3f920caeb4f3e3`). The cache path list is the
  suites' *persistent* profile dirs (`.e2e-profile`, `-p1`, `-p2`,
  `-schedule-ux`, `-security`, notifications, usage); `.dev-profile-protection`
  is recreated per run so caching it is pointless; the `/tmp/opencode`
  throwaway profiles (allowance, allowance-daemon, backup) re-download per run
  by design — accepted and documented rather than "solved" with fragile
  profile copying.
- **Suite self-builds**: `e2e-backup.mjs` honors `SB_SKIP_BUILD=1`;
  `e2e-allowance-test` and `e2e-allowance-daemon-test` rebuild both targets
  unconditionally. Rather than patch the suites (out of scope), the lane sets
  `SB_SKIP_BUILD=1` where honored and eats the extra minutes where not.

## Alternatives / tradeoffs

- One matrix job per suite would give per-suite status symbols and parallelism,
  but each would cold-start its own profile and lose the "warm the shared
  `.e2e-profile` in e2e-test, then later suites reuse it" ordering the local
  workflow relies on; sequential stays closer to the documented local gate.
- Including the five newest suites (`e2e-dashboard-test`, `e2e-profiles`,
  `e2e-partner-test`, `e2e-reward-test`, `e2e-schedule-prefs`) was declined —
  they weren't in the agreed chain, and adding them while other builders are
  mid-swarm risks a red lane nobody sanctioned. They are named in the yml
  header for a deliberate follow-up.
- `--with-deps chromium` uses sudo/apt on the runner; standard on
  `ubuntu-latest`, but it is the one untested link (see below).

## Verification

- Every referenced script path asserted to exist on disk (all pass).
- YAML parse-checked with Python `yaml.safe_load`; jobs/steps/outputs/
  suite list asserted programmatically. js-yaml was not installed and deps were
  not added, per the task's validation budget.
- All §7 ids grepped back out of the edited file; each traced to a
  file:line in the source components (details in
  `.audit-swarm/builders/builder-docs-ci-report.md`).
- NOT verified (first real run happens on GitHub): the workflow's end-to-end
  behavior, Playwright `--with-deps` on the current runner image, actual cache
  size, and whether the 180-minute timeout is comfortable (60–100 min
  estimated cold). Those are the first-run watch items.
