# SmartBlocker Privacy

**SmartBlocker is local-first.** Page classification runs entirely on your device
(a small model via Transformers.js/ONNX WASM). Your browsing — URLs, titles,
history, whitelist, blocklist, settings — never leaves your machine.
SmartBlocker has no analytics, no tracking, and no telemetry. It makes network
requests in exactly three situations — a one-time model download, and two
off-by-default opt-ins — every one of them enumerated in "Network requests"
below. Nothing else ever leaves your machine.

## Network requests

The complete list of what SmartBlocker may ever request, and when:

1. **On-device model download (once).** The first time the classifier runs,
   it downloads the embedding model (~35 MB) from Hugging Face
   (`huggingface.co` and its CDN) and caches it locally via the Cache API.
   This carries no user data — it is a static file download — and afterwards
   runs 100% offline. All classification itself always happens on-device.

2. **YouTube oEmbed title lookups (opt-in, default OFF).** Some embedded
   YouTube players and search-result cards expose no title to the page DOM.
   Only if you turn on *"Resolve embed titles via YouTube oEmbed"* on the
   options page, SmartBlocker may ask `www.youtube.com/oembed` for the title
   — a request that tells YouTube **the video ID** (nothing else: no account,
   no cookies, no page you saw it on) of that particular embed or card. It
   fires strictly as a last resort after DOM/URL-extracted titles, and it
   **never** fires for `youtube-nocookie` embeds or privacy-facade players —
   those exist specifically to avoid contacting YouTube, and SmartBlocker
   respects that even when this toggle is on.

3. **Opt-in correction sharing (default OFF).** Covered in full below:
   uploaded once a day, only if you enable it, to the endpoint in
   `FEEDBACK_ENDPOINT` (a SmartBlocker-operated Cloudflare worker).

## Corrections (feedback records)

When you correct SmartBlocker — the block screen's *"This is actually productive —
let me through"* or the popup's *"Should've been blocked"* — it stores a
correction record **on your device** (`storage.local`, capped at 500):

- what kind of mistake it was (wrongly blocked / should have been blocked)
- the page **title** (plus channel/description snippet when available)
- the site **hostname only** (e.g. `youtube.com` — never the full URL)
- the model's verdict (category + confidence) and, for "should've been
  blocked", the category you chose
- the model id, extension version, and a timestamp

The classifier learns from these records locally (they refine its category
prototypes). You can view the count, **export them as JSON**, or **clear them**
at any time from the options page.

## Opt-in sharing (default: OFF)

The options page has a *"Share my corrections to improve SmartBlocker"* toggle.
It is **off by default** and nothing is ever uploaded while it is off.

If you turn it on, the extension uploads your correction records (exactly the
fields listed above) once a day to a SmartBlocker-operated endpoint
(`feedback-worker/` in this repo — you can read every line it runs). The batch
also includes:

- a **random install id** (a UUID minted on your device) used only to
  de-duplicate retried uploads — it is not derived from you, your browser, or
  your hardware, and clearing extension storage resets it
- the extension version

What is **never** collected, on or off: full URLs, browsing history, pages you
visited without correcting, your whitelist/blocklist, IP-based profiles, or
anything identifying. Shared records are used solely to build better
evaluation datasets and models for SmartBlocker.

### Data retention

Shared records **expire automatically 90 days after upload**. The server
stamps every row with that expiry when it is written, a scheduled job deletes
expired rows daily (and the write path deletes them lazily too), and expired
rows are excluded from exports — retention is enforced in three places, not
just promised. Prior to 90 days, our export/import pipeline may copy a
correction into the training datasets in this repo; those copies are the
dataset itself (page title + hostname + labels, no install id) and do not
expire.

**Deleting sooner.** You can erase everything your install has shared by
POSTing `{ "installId": "<your install id>" }` to `/v1/delete` on the feedback
endpoint. Your install id is the random UUID mentioned above; it lives in
extension storage (`storage.local`, key `installId`). The options page shows
it under "Your shared feedback data" (masked by default — Reveal + Copy),
together with a "Delete shared data" button that calls `/v1/delete` for you;
clearing the extension's storage or reinstalling also removes your local copy
and makes the already-shared rows unlinkable going
forward (see below). The delete route has an honest, documented limitation:
the extension is a public bundle, so the server holds no per-install secret
that could prove ownership of an id. Deletions are therefore rate-limited to
one per hour per install id and logged, rather than authenticated — anyone who
already knows your random install id could delete your (at most 90-day-old)
rows, but could not read them; bulk reads stay behind the export token.

**Pseudonymity, honestly.** The install id is a random UUID minted on your
device — it is not derived from you, your browser, or your hardware, but rows
that share an id *are* linkable to each other (that linkage is what
de-duplicates retried uploads). Rotating the id — clearing extension storage
or reinstalling — mints a fresh UUID, after which new uploads can no longer be
linked to the old ones. Records contain page titles and hostnames only, so
what a shared row says about you is limited to "some install corrected the
model on this page".

**Sharing is not live yet.** The feedback worker is not currently deployed
(`feedback-worker/wrangler.toml` still has a placeholder `database_id`) and
the extension ships with `FEEDBACK_ENDPOINT` empty, so nothing is uploaded
even with the toggle on. This section describes the behavior that will apply
the day those switches flip.

Prefer not to flip the toggle but still want to help? Use **Export as JSON**
and attach the file to a GitHub issue.

## Desktop companion (SmartBlocker Companion)

The optional desktop companion (`companion/`) has **zero network code**. It
talks only to your browsers over OS-local Native Messaging pipes and stores
only your lock state and its own settings (blocked app names) in a local
data folder. It observes running process names on your machine solely to
enforce blocks you configured; nothing it sees is transmitted anywhere.
