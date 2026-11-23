# UI error states + the last two audit test gaps

## Why

The UI audit found two failure paths that could look like a hang forever, and
the tests audit named the two remaining untested background paths: the opt-in
feedback uploader (the only code that sends data off-device) and the on-demand
history scan.

## What changed

### UI

- `OptionsApp` no longer lets a malformed hash blank the page:
  `decodeURIComponent` is guarded and falls back to the default route (or the
  raw hash). Previously `#%` threw during render.
- Initial-load failures now have an error state with a Retry action instead of
  an eternal `aria-busy` skeleton (options) or a permanent "Checking this
  page…" (popup). The popup banner is `#popup-load-error` (`role=alert`); the
  options panel is `#options-load-error`.

### Harnesses

- `scripts/feedback-uploader-test.mjs` (6 checks): daily alarm registration,
  off-by-default no-op, POST shape (URL, extVersion, records with local
  `uploaded`/`skipped` stripped), one stable install id, failed-POST leaves
  records for the next alarm, out-of-contract records skipped once and never
  retried, and the 100-record batch cap with the rest following later. `fetch`
  is mocked, so nothing leaves the machine.
- `scripts/history-ingester-test.mjs` (7 checks): filters to classifiable,
  non-whitelisted, de-duplicated titles; blocklist hits counted without an
  inference; `HISTORY_CAP`; classifier failure → `error` + released running
  flag; stale `running` record healed with progress preserved; finished record
  untouched; a LIVE scan not disturbed by the healer.

## Verification

- typecheck; pure battery (45 suites incl. the two new ones); Chrome build.
- e2e-dashboard-test (options shell/route) and e2e-test re-run.

## Residual

The popup/options error states are exercised by code inspection and typecheck,
not by an e2e that forces storage failures; the harnesses cover the two
background paths end-to-end with mocked extension APIs.
