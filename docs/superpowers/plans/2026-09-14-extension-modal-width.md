# Extension modal width

Fixes #969.

## Problem
Modal extension views are capped at half the window width:
- `AppHostSurface` renders every view inside the shared `DialogContent`, which is centered with `position: fixed; left: 50%` and a translate.
- `AppHostSurface` overrides the dialog's width to `auto`. For a fixed box with `left` set, that resolves to shrink-to-fit within 50vw.
- #682 changed the dialog's grid track to `minmax(0,1fr)`. That removed the one thing that used to hold the modal open: the iframe wrapper's explicit width.
- Wider views are clipped by `overflow-hidden`. Mini Games' launcher and Blackjack are cut off; Snake and Blockfall fit, so every screen looks "stuck" at Blockfall's size.

The frame's size report (`frameDocument.ts`) and the host scale (`viewBridge.tsx`) are correct. A browser reproduction of that logic sizes every screen exactly.

## Change
1. `AppHostSurface`: `width: max-content` instead of `auto`.
   - The dialog then takes the iframe wrapper's explicit, viewport-scaled width.
   - The existing `maxWidth: min(1160px, 94vw)` still bounds it.
   - The shared primitive's `minmax(0,1fr)` containment stays unchanged for every other dialog.
2. `viewBridge`: cap the failure message at the primitive's normal dialog width. Under `max-content`, a long error would otherwise stretch the modal to the cap on one line.

## Verification
- Chrome, with the exact dialog CSS at 1440×900 and 1300×820: with `auto`, the launcher shows 63–70% and Blackjack 77–80%. With `max-content`, every Mini Games screen is 100%.
- `npx tsc -b` and the renderer tests for the extension host.
- No happy-dom regression test: it has no layout engine, so a test could only restate the style string. The browser measurement above is the real evidence.
