# FlowGuard Privacy

**FlowGuard is local-first.** Page classification runs entirely on your device
(a small model via Transformers.js/ONNX WASM). Your browsing — URLs, titles,
history, whitelist, blocklist, settings — never leaves your machine.
FlowGuard has no analytics, no tracking, and phones home for exactly nothing,
with one explicit, off-by-default exception below.

## Corrections (feedback records)

When you correct FlowGuard — the block screen's *"This is actually productive —
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

The options page has a *"Share my corrections to improve FlowGuard"* toggle.
It is **off by default** and nothing is ever uploaded while it is off.

If you turn it on, the extension uploads your correction records (exactly the
fields listed above) once a day to a FlowGuard-operated endpoint
(`feedback-worker/` in this repo — you can read every line it runs). The batch
also includes:

- a **random install id** (a UUID minted on your device) used only to
  de-duplicate retried uploads — it is not derived from you, your browser, or
  your hardware, and clearing extension storage resets it
- the extension version

What is **never** collected, on or off: full URLs, browsing history, pages you
visited without correcting, your whitelist/blocklist, IP-based profiles, or
anything identifying. Shared records are used solely to build better
evaluation datasets and models for FlowGuard.

Prefer not to flip the toggle but still want to help? Use **Export as JSON**
and attach the file to a GitHub issue.
