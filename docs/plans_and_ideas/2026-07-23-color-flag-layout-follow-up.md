# Dispatch color-flag visual corrections

Status: In progress
Date: 2026-07-23

## Context

PR #603 added persistent per-session color flags and rendered them in the
primary Dispatch index. The state model and picker behavior are sound, but the
first visual pass made three layout choices that do not match the intended
product:

1. The full-row strip is absolutely positioned over right padding. It looks
   like row decoration rather than a real part of the selector and does not
   establish a reusable layout contract for other Dispatch lists.
2. Tiled Dispatch lane 0 inherits the full index and therefore shows flags,
   while every later lane uses `DispatchMiniList`, which has no flag rendering
   at all.
3. The six modal swatches are left-aligned against an otherwise padded dialog,
   even though the picker is a single centered choice rather than a form field.

This follow-up keeps the already-merged persistence, command, palette, and
modal lifecycle. It only corrects presentation and adds focused regression
coverage for the three missed surfaces.

## Product contract

### A real trailing column

A Dispatch color flag owns a fixed **10px trailing column**. The column is
present even when a row is unflagged so labels, titles, and colored strips stay
aligned vertically while scanning. A flagged row fills the column; an
unflagged row leaves it transparent.

The strip must participate in flex layout. `absolute`, negative margins, and
painting over padding are not acceptable substitutes because they hide the
width relationship from the row and make compact selectors easy to forget.

### Every Dispatch selector

Both selector shapes must use the same flag-column component:

- `DispatchAgentList` — the rich index used by classic Dispatch and tiled lane
  0.
- `DispatchMiniList` — the chips-only selector used beside tiled lanes 1+.

The compact selector keeps its existing 36px label cell and becomes 46px wide:
36px for the centered session label plus the real 10px flag column. The flag
must not squeeze or off-center the label inside its established cell.

### Centered picker

The modal's swatch group is horizontally centered and receives the same 16px
horizontal inset as the dialog header and footer. Wrapping remains enabled for
narrow viewports.

## Implementation shape

1. Add a small `DispatchColorFlagStrip` component next to the Dispatch lists.
   It owns the per-session settings selector, the stable 10px flex geometry,
   the transparent unflagged state, and a test/debug data marker. Keeping the
   state lookup and geometry together prevents the rich and compact lists from
   drifting again.
2. Replace `DispatchAgentList`'s conditional absolute overlay and compensating
   right padding with the shared trailing flex child.
3. Render the same component from `DispatchMiniChip`. Split the mini button
   into a 36px label cell plus the 10px strip, and widen the containing selector
   in `TiledDispatchLayout` to 46px.
4. Add `justify-center` and dialog-consistent horizontal padding to the swatch
   group in `ColorFlagPickerModal`.

## Verification

Focused renderer coverage must prove behavior rather than merely snapshotting
the entire component tree:

- a valid persisted flag fills the shared strip with the palette color;
- an unflagged session still renders the transparent 10px layout column;
- the rich Dispatch row includes the layout-owned strip;
- tiled mini chips include the same strip without moving the label out of its
  36px cell, and the tiled selector wrapper reserves 46px;
- the picker swatch group carries centering and horizontal-inset classes.

Then run the repository's renderer tests, typecheck, full test suite, and build.
Manual review should cover classic Dispatch plus tiled Dispatch with at least
two lanes, including flagged and unflagged rows next to one another.

## Non-goals

- Changing the six-color palette or persisted ids.
- Adding custom colors, keybindings, or a row context menu.
- Pruning flags when sessions close.
- Changing which session the command palette targets.
