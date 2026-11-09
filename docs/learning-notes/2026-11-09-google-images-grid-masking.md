# Why one heading hid every image on Google Images

## The problem

Searching `pytorch autograd` on Google's Images tab showed a grey
"SmartBlocker masked" bar in place of the entire grid. The images were only
reachable by clicking through it. The search was plainly productive, so this was
a false positive.

## Root cause

[`src/content/sanitize-page.ts`](../../src/content/sanitize-page.ts) hides
distracting parts of a search page in place. Its "shelf" rule looks at candidate
containers and hides one when a heading inside it matches a known module name.
A *shelf* here means one self-contained module, such as a row of videos.

On the live Images tab that assumption does not hold. `#rso` has a single child,
and one `div.MjjYud` holds the whole grid plus interleaved "Related searches"
modules. The rule found the "Related searches" heading and hid its container,
which was all 212 images. The classifier was never asked.

The lesson is that a rule's scope comes from the markup it is pointed at.
"Hide the module that owns this heading" is only safe if the container really is
that module.

## How it was investigated

1. **Reading the sanitizer** showed no special handling for image results, which
   suggested that an image row would be treated as an ordinary result card.
2. **Probing the shipped model** with simulated inputs showed that a row titled
   only "Images" could be blocked depending on the first thumbnail's host. This
   was a real weakness, but the user then reported that the bug was on the Images
   tab grid, so it was not this bug.
3. **Inspecting the live page** in Edge showed the single `MjjYud` around 212
   images. The project notes recommend live inspection for search-page changes
   because Google's markup changes often and fixtures can't reveal that.
4. **Running the real compiled `sanitizePage`** on that page, in a throwaway tab,
   gave the exact result: one `serp-shelf` mask with the reason
   `Search rabbit-hole suggestions (Related searches)`, covering 212 images.
   Running the real code on the real DOM turned a hypothesis into a reproduction.

## The fix

The user chose to judge image results by the search terms, and said that hiding
"Related searches" was too strict.

- **"Related searches" and "People also search for" are no longer hidden.** This
  alone fixes the reported search.
- **The shelf, result-card and leftover-link passes skip Google's Images tab.**
  Without this, a different heading inside the grid, such as "Videos", would hide
  everything again.
- **The query is judged by the existing page-level classifier.** A first version
  added a second verdict for the grid. The e2e run showed `funny cat memes` was
  already blocked full-page, so the extra verdict repeated the same question and
  was removed.
- **All-tab image rows are also left to that verdict.** A row titled "Images" has
  no topic information, and its first link is just the first thumbnail's source.
- **The user's own block rules still apply per tile,** using each tile's
  `data-lpage` landing page and the image's alt text.

## Tradeoffs and limits

- A query verdict is coarse: a productive query can still return an off-topic
  image, and YouTube or Instagram tiles now stay visible on productive searches.
  The user chose this over judging each tile by site.
- Only Google's Images tab is changed, because that is the markup verified live.
  Other engines' image pages behave as before.
- `elden ring fan art` scored 0.29 to 0.32 in the model probes and stays visible.
  Queries that are artistic rather than explicitly about games are a soft spot.

## Verification

- `npm run typecheck` and `npm run build:chrome` passed.
- A probe of 16 queries through the shipped model allowed all 8 study queries. Of
  the 8 distraction queries, 7 were blocked and `elden ring fan art` was allowed.
- The fixed sanitizer on the live page masked nothing and left 212 images visible.
- A new `scripts/e2e-test.mjs` case covers a productive grid with an interleaved
  "Related searches" module and a YouTube tile, a meme query that blocks the full
  page, a per-tile block rule, and an All-tab image row.
