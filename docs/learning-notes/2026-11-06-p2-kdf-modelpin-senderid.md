# P2 security batch: KDF upgrade, model revision pin, sender.id guards

Date: 2026-11-06 · Task: red-team P2 remediations #19 (unpinned HF model), #21 (unsalted
SHA-256 lock password KDF, min length 4), #34 (no sender validation on message
listeners). Findings doc: `docs/security/red-team-2026-11-05.md`.

## Problem

1. **#19** `pipeline(task, MODEL_ID, {...})` floated on Hugging Face's mutable `main`
   branch with no integrity check — a silent upstream weight swap would change every
   classification.
2. **#21** `src/shared/lock.ts` stored `sha256('smartblocker-lock:' + pw)` — a single
   unsalted, fast hash (trivially brute-forced once read; two installs with the same
   password share hashes) — and accepted 4-character passwords.
3. **#34** the two `runtime.onMessage` listeners (background SW, offscreen doc) never
   checked `sender.id`. Unreachable today (no `externally_connectable`), but zero
   defense-in-depth.

## The decisive constraint (why the design looks this way)

The obvious v2 format — a self-describing string like `pbkdf2$iter$salt$hash` or a
`v2:` prefix — is **impossible**: `sanitizeLockState` (`src/shared/lock-math.ts:297`)
accepts only `^[0-9a-f]{64}$` for `passwordHash`, the Rust daemon mirrors that regex,
and both merge implementations treat the hash as an **opaque string** whose semantics
(the `passwordTs` tombstone CRDT) must not change. Any non-hex marker would be
sanitized to `null` (lock silently dropped) or break the wire protocol.

So the scheme marker lives **outside** the hash, in a new storage key `lockKdf`:
`passwordHash` stays bare 64-hex, keyed by `lockKdf = { salt, iterations, v: 2 }`.
`lockKdf` is deliberately **outside the merged `lockState` CRDT** — the companion
bridge (`src/background/companion.ts:224-228`) only ever forwards the `lockState`
key, so the per-install salt can never leak into a `lockStateSync` frame or the
daemon's merge. This was verified against the actual forwarding code before choosing
the design.

## Changes

### `src/shared/config.ts`
- New exports `EMBED_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'`
  (`Xenova/bge-small-en-v1.5`) and `MODEL_REVISION = '2a4f614a701367a02d51389039afc998faeda637'`
  (`Xenova/nli-deberta-v3-xsmall`), each with the curl command used to bump them.
  Resolved via `curl -s https://huggingface.co/api/models/<id>` → `.sha`; a HEAD on
  `/resolve/<sha>/config.json` returns 307 (a bad SHA would 404). The comment warns
  that title/centroid caches are keyed by model *ID*, so a revision bump should also
  bump the `:mp1` version suffix in `classifier.ts`.

### `src/background/classifier.ts` + `src/background/offscreen/offscreen.ts` (all four pipeline load sites)
- Added `revision: <…>_REVISION` to every `pipeline()` option bag. The vendored
  `@huggingface/transformers` 3.8.1 supports it (`PretrainedModelOptions.revision`);
  the revision flows into every `/resolve/<revision>/…` fetch and into the
  CacheStorage keys, which is what the e2e asserts on.

### `src/shared/lock.ts` (#21)
- New pure helpers `pbkdf2HashHex` / `toHex` / `hexToBytes` / `randomSaltHex`, constants
  `MIN_PASSWORD_LENGTH = 8`, `PBKDF2_ITERATIONS = 210_000` (OWASP floor), 16-byte salt.
  The PBKDF2 input keeps the `'smartblocker-lock:'` domain separator; output is 256-bit
  hex → still matches the daemon's 64-hex sanitize regex.
- `hashPassword` retained unchanged as the **legacy v1** verifier (the companion PoCs
  mirror it; it must keep its exact vector).
- New `verifyPassword(password)`: v2 first (when `lockKdf` is present), legacy
  fallback — a legacy hash can still be armed on an upgraded install (never migrated,
  or re-adopted from an older peer through the opaque CRDT merge). A successful
  **legacy** verify runs `migrateToV2Hash`: fresh salt → `lockKdf`, re-arm the v2 hash
  with a fresh `passwordTs` so the upgrade wins the merge. One-way, silent; wrong
  passwords never write anything.
- `armPasswordLock`: min length 8 (new arms only), salt written **before** the hash
  (an orphan salt is harmless; a v2 hash without its salt would be ununlockable).
- `attemptPasswordUnlock`: `verifyPassword` + tombstone clear, re-reading state after
  the possible migration write.

### `src/background/index.ts` + `src/background/offscreen/offscreen.ts` (#34)
- `if (sender.id !== api.runtime.id) return false;` as the first statement of each
  listener (the `_sender` parameter in offscreen.ts is now exercised).

### `src/options/OptionsApp.tsx` (hint only, 2 lines)
- Placeholder `min 4 chars` → `min 8 chars`; card title `SHA-256 Password Lock` →
  `PBKDF2 Password Lock` (the old label named a now-secondary algorithm). The file
  ownership grant named `options.ts`, but that file is only the React bootstrap — the
  hint lives in `OptionsApp.tsx` (untracked; part of the in-flight UI rewrite).

### `scripts/e2e-p2-kdf-modelpin.mjs` (new)
Modeled on `scripts/e2e-test.mjs` (persistent `.e2e-profile-p2`, SW-evaluate helpers).
Drives the **real options-page UI** for arm/unlock. Highlights:
- v2-marker assertion = `lockKdf` entry + 64-hex hash (format rationale in the header).
- Cross-checks stored hashes against an **independent** in-page `crypto.subtle` PBKDF2.
- Legacy migration observed through a `chrome.storage.onChanged` recorder: the
  migration's `lockKdf` write + v2 re-arm + fresh `passwordTs` are captured before the
  unlock tombstone — full state machine, no test hooks shipped in product code.
- Salt binding tested by swapping `lockKdf` to a foreign salt (cryptographically
  identical to a fresh profile) — cheaper than a second browser profile.
- Model pin: reads the expected SHAs from `config.ts` (self-syncing), asserts they are
  compiled into `dist/chrome` bundles, then — after a real `#test-pair` classification —
  asserts every CacheStorage `huggingface.co/resolve/<rev>/` URL uses the pinned
  revision. Cache keys *are* the fetched URLs, so this is deterministic warm and cold,
  unlike intercepting extension SW/offscreen fetches (Playwright routes those
  inconsistently across versions).

## Verification (all observed, nothing assumed)

- `npm run typecheck` — clean. (Needed `Uint8Array<ArrayBuffer>` on `hexToBytes`:
  TS 5.9's generic typed arrays make `ArrayBufferLike` unassignable to `BufferSource`.)
- `node scripts/lock-math-test.mjs` — **77/77** (untouched file; v2 hashes still pass
  the shared sanitize because they are 64-hex).
- Node type-stripping smoke of the REAL `lock.ts` (in `/tmp/opencode`, not committed;
  `module.register` resolve hook for extensionless TS imports + an in-memory
  `chrome.storage` stub) — **12/12**, including PBKDF2 vs `node:crypto.pbkdf2Sync`
  agreement, the full migration state machine, foreign-salt rejection, a legacy hash
  re-adopted via `mergeLockStates` still verifying + re-migrating (no lockout), and
  `sanitizeLockState` passing v2 hashes untouched.
- Smoke false-start worth remembering: a same-millisecond `passwordTs` tie makes the
  CRDT's equal-ts *lexicographic-min* tiebreak pick the local hash — ties are resolved
  by hash value, not recency. Tests must space timestamps by ≥1 ms, and so must any
  future reasoning about merges.
- The e2e script was `node --check`ed but **not executed** (integrator runs it after
  `npm run build`; team instructions).

## Residuals / honest notes

- A user who wipes `lockKdf` while a v2 lock is armed locks themselves out (treated as
  legacy from then on). Same accepted class as devtools storage surgery on a soft lock.
- `#34` guards are provably unreachable today (`return false` on foreign senders);
  value only if `externally_connectable`/WAR ever regresses.
- Migration fires on successful verify, including the verify inside an unlock — the
  salt stays in `lockKdf` after unlock and is re-minted on the next arm (inert).
- Revision bumps do not auto-invalidate centroid/title caches; the bump procedure is
  documented in `config.ts`.
