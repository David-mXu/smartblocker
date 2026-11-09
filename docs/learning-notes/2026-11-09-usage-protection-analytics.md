# Usage analytics: protection, lock, and block-reason accounting

## Problem and goal

The existing Usage page could answer “how much active time and how many blocks
did I have?” but not the more useful questions:

- Was protection actually on during that active time?
- How much of it happened under a lock or a classifier break?
- Why were pages blocked: classifier, deterministic rule, channel rule, adult
  rule, or fail-closed classifier?
- How often did I override a block, and which sites/categories dominated the
  selected period?

The goal was to add those answers without turning usage stats into a browsing
log. The privacy constraint stayed the same: no URLs, paths, titles, scores, or
rule text in durable state; bounded maps and duplicate IDs; 35 local-day
retention; manual JSON export and clear.

A second, subtler goal was correctness at **event boundaries**. Protection and
lock state can change in the middle of an active interval. If the tracker reads
that state after an asynchronous queue has drained, an interval can be attributed
to the wrong context.

## The accounting model

Two invariants carry most of the design:

```text
protectedMs + unprotectedMs + unknownMs == activeMs
lockedMs <= activeMs
breakMs  <= activeMs
```

The first line says protection is a **partition** of active time, not extra
time. The second and third say lock and break are **annotations** (subsets) of
active time. This matters because a lock can overlap a break, and a break can
outlive its lock; adding those clocks together would double-count time.

For blocks, the reason counters are likewise a partition:

```text
classifier + deterministic + channel + adult + fail-closed + unknown
  == pagesSilenced
```

Keeping totals and breakdowns equal means the UI can never show a chart whose
bars disagree with the headline number. Corrupted or partially written storage
is repaired in `reconcileProtection()` and `reconcileBlocks()` in
[`src/shared/usage-stats.ts`](../../src/shared/usage-stats.ts), rather than
trusted blindly.

## Implementation steps

### 1. Version the storage and migrate old data honestly

**Evidence:** v1 recorded `activeMs`, `pagesSilenced`, and `overrides`, but not
protection context or block reasons. There is no way to reconstruct those facts
after the fact.

**Choice:** bump the key to `usageStats:v2` and perform a one-way in-memory
migration from `usageStats:v1`. Migrated active time becomes `unknownMs`, and
migrated blocks become `blocks.unknown`. The legacy key is removed only after a
successful v2 write.

**Why:** guessing “probably protected” would make the dashboard look better and
be wrong. Explicit unknowns are honest and let the UI label old time as
“before upgrade.”

The migration lives in `migrateUsageStatsV1()`; loading and legacy cleanup are
in [`src/background/usage-stats-tracker.ts`](../../src/background/usage-stats-tracker.ts).
The tests seed a v1 value, verify the migrated aggregates, ensure a stale v1
copy beside v2 does not overwrite newer data, and confirm expired days are
pruned.

### 2. Derive a single block reason from the existing verdict

**Evidence:** the blocker already stores a `TabStatus` for each tab. Its
`kind` and `label`/`rule` fields distinguish rule blocks, channel rules, adult
labels, and the locked classifier fallback.

**Choice:** map that existing verdict into one disjoint `UsageBlockReason` in
[`src/background/usage-stats.ts`](../../src/background/usage-stats.ts):

| Verdict evidence | Reason |
| --- | --- |
| label `adult` | `adult` |
| rule starts with `channel @` | `channel` |
| kind `blocked-rule` (other) | `deterministic` |
| label starts with `classifier unavailable` | `fail-closed` |
| anything else | `classifier` |

**Why:** this avoids changing the blocker’s decision path just to satisfy
analytics. It also preserves the privacy boundary because the mapper consumes
the verdict, never the page content.

`recordUsagePageSilenced()` increments exactly one counter per deduped decision.
The dedupe key is the existing bounded opaque decision ID, so a repaint or
repeated status event cannot inflate either the total or a reason bucket.

### 3. Treat settings/lock changes as exact context boundaries

**Evidence:** the tracker already checkpoints on tab, focus, idle, and alarm
events. A settings toggle or lock transition changes the meaning of the next
interval, but those writes were not previously observable as boundaries.

**Choice:** listen for `storage.onChanged` on the local area and checkpoint
when `settings` or `lockState` changes. The tracker resolves the current
protection context (`protected`, `locked`, `break`) and stores it on the
checkpoint. When the next checkpoint closes that interval, the prior context is
applied to the prior segment.

**Why:** without this, a toggle at 10:05 would only be reflected at the next
one-minute heartbeat, mislabeling up to a minute of time. Storage events give an
exact boundary with no new polling.

Automatic lock/break **expiry** is different: no storage write occurs when a
timer simply runs out. Expiry is therefore observed at the next heartbeat or
event boundary. That is a deliberate minute-resolution approximation, not an
exact instant.

### 4. Resolve context at the checkpoint timestamp, not after the queue

**Evidence:** checkpoints are serialized through a promise queue. By the time a
queued checkpoint runs, several milliseconds (or much longer under a slow
storage read) may have passed. Calling `getLockStatus()` with the wall clock at
that point could label the interval with a lock that expired in between.

**Choice:** pass the observed checkpoint timestamp into target resolution:

```ts
const resolution = await this.resolveTarget(at);
```

and derive lock state at that boundary:

```ts
const boundary = Number.isFinite(at) && at > 0 ? at : Date.now();
const [settings, lock] = await Promise.all([getSettings(), getLockStatus(boundary)]);
```

**Why:** the event timestamp is the actual boundary between the old and new
interval. Reading state at that timestamp keeps the annotation aligned with the
time being charged. The fallback protects against a malformed clock value.

This is the kind of bug that is easy to miss in a manual demo: the dashboard
looks plausible, but a lock-expiry test with a slow resolver exposes it. The
focused suite includes a “queued checkpoints retain their event timestamps
behind a slow resolution” case.

### 5. Build a dashboard around the new aggregates

**Choice:** rewrite [`src/options/pages/UsagePage.tsx`](../../src/options/pages/UsagePage.tsx)
with:

- 7-day and 35-day range presets;
- a stacked daily chart of block reasons;
- a Blocks tab with pages silenced, override rate, protection coverage,
  protected/unprotected time, lock time, and break time;
- a Sites and categories tab with Top-N tables and an explicit “other” toggle;
- Today/Yesterday/day presets and a day selector;
- aggregate-only JSON export and two-step clear.

**Why:** the page should answer “what changed?” before dumping tables. The
“other” rows are explicit because an aggregate bucket is not a real site or
category; hiding it silently would make the Top-N table look complete when it
is not.

The chart is plain stacked bars driven by the same day rows as the tables. No
charting dependency was added, which keeps the extension bundle and the test
surface small.

### 6. Defend invariants in storage, not just in the UI

**Choice:** `sanitizeUsageStatsState()` repairs every loaded day:

- protection buckets are clamped and any missing active time becomes
  `unknownMs`;
- reason counters are clamped and any missing count becomes `unknown`;
- host/category maps are bounded;
- duplicate IDs are capped at 2,000;
- old days are pruned at 35 local days.

**Why:** storage can be partially written, manually edited, or left over from an
older build. If the UI is the only place that reconciles totals, a corrupted
value can reappear after export or migration. Doing it at the state boundary
makes every consumer see the same invariant.

## Alternatives and tradeoffs

- **Add lock/break time to active time.** Rejected: overlapping locks and
  breaks would double-count. Subsets are harder to explain but correct.
- **Estimate protection for migrated v1 time.** Rejected: there is no evidence
  to support an estimate. `unknown` is visible in the UI and export.
- **Hook timer expiry directly.** Rejected for this change: it would require a
  new scheduling path in the lock subsystem. The heartbeat already provides a
  bounded one-minute approximation. If exact expiry boundaries matter later, the
  lock module could emit a change event on expiry.
- **Persist per-site block reasons.** Rejected for now: it multiplies the
  bounded maps and is not needed for the selected questions. Reason totals are
  per day; site/category tables show active time, blocks, and overrides.
- **Per-application stats.** Not promised. The data source is browser tabs, so
  the UI explicitly stays browser-only.

## Verification

Observed results on 2026-11-09:

```text
npm run typecheck
  PASS (tsc --noEmit, no output)

node scripts/usage-stats-test.mjs
  30 passed, 0 failed

npm run build:chrome
  PASS (background, offscreen, popup, options, blocked, asset copy)

node scripts/e2e-usage-ui.mjs
  USAGE E2E: ALL PASSED (31 checks)
```

The focused suite covers dedupe, local-midnight and DST splits, stale-gap
discard, restart recovery, v1→v2 migration, bounded maps, retention, exact
export shape, protection/lock/break overlap, reason partition, and the
slow-resolver boundary case. The browser e2e seeds v2 aggregates into a
disposable profile, exercises the real options page, and asserts the 7/35-day
chart, tabs, day presets, Top-N/“other” controls, export privacy, and clear.

Screenshots from the browser run:

- [`docs/audits/assets/2026-11-09-usage-dashboard.png`](../audits/assets/2026-11-09-usage-dashboard.png)
- [`docs/audits/assets/2026-11-09-usage-sites.png`](../audits/assets/2026-11-09-usage-sites.png)

These are observed results from the commands above, not estimates. The e2e uses
a disposable Chromium profile and seeded storage; it does not prove behavior
against a live user’s long-running profile.
