# Keyboard focus containment + a motion pause control

## Why

Three small a11y gaps remained from the UI audit:

1. The block screen trapped Tab only when focus was on its last (or first)
   control. If focus escaped to the page behind the dialog — a page script or
   the page's own focus handling — forward Tab did nothing to bring it back, so
   keyboard users could end up tabbing through the hostile page under the
   curtain.
2. The popup's "Should've been blocked" flow closed itself when the tab's
   verdict changed mid-flow (tab switch, re-check, lock start) but dropped
   keyboard focus into `<body>` instead of returning it to the trigger.
3. The marketing site's infinite marquee had no pause mechanism (WCAG 2.2.2
   requires one for motion longer than five seconds). `prefers-reduced-motion`
   covered only users who set it.

## What changed

- `blockscreen.ts` dialog Tab handler now also pulls focus back on a forward
  Tab when `shadow.activeElement` is null (focus outside the dialog).
- `ThisPageCard` tracks whether the report flow was open when the view key
  changes and sets the return-focus flag before closing, so focus returns to
  the trigger instead of being lost.
- `site/SiteApp.tsx`: the marquee has a visible Pause/Resume button
  (`aria-pressed`) that sets `animationPlayState` inline; it stays available
  regardless of the OS motion preference.

## Verification

- typecheck; Chrome build; site build.
- `e2e-security-blockscreen` (dialog/tamper suite) and `e2e-test` re-run.
