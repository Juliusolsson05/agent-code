# Completion stripes: vertical, full accent, legible path

> **Superseded visually by #1200** (`docs/plans/2026-09-25-completion-indicator-redesign.md`): the indicator is now the working bar drawn hollow (surface fill, 2px accent ring, accent text). Stripes and plates were removed. The seen/dwell logic below still stands.

Status: user-requested 2026-09-25 · Branch: `fix/completion-stripes-solid` ·
Issue: #1191 · Follows #1172 / PR #1176 (`docs/plans/2026-09-24-agent-completion-indicator.md`)

## Outcome

The pane header's "finished, go look" stripes:

1. **Vertical bars**, not diagonal.
2. **The full activity colour** (`--color-accent`, exactly what the solid
   "working" fill uses), not the 45% `color-mix`.
3. **The label and path stay legible.** They must not look odd sitting on
   full-strength bands.

## Why (3) needs a design, not just a colour change

#1176 dimmed the stripes to 45% for one reason, recorded in `styles.css`: the
header text keeps the surface's muted/ink colour. Full-strength bands made the
label and path flicker between two contrasts as each glyph crossed a band.
Making the stripes full strength brings that problem back unless the text
stops sitting on the bands.

Options considered:

- **Switch the text to `accent-fg` while striped.** Rejected: `accent-fg` is
  chosen to contrast with the ACCENT, and half of every stripe is surface, so
  half the glyphs would be the wrong contrast. It is the same flicker in
  reverse.
- **Text shadow or outline in the surface colour.** Rejected: blurry at 10px,
  and it looks like a rendering glitch rather than a design.
- **Stripes only in the free space right of the text.** Rejected: the text
  group is `flex-1` on purpose (the trailing slot must reach the right edge),
  so there is no stable "free space" box. On a narrow pane the stripes would
  shrink to almost nothing.
- **Chosen: plates.** While striped, the identity group (pane label, badge,
  path) and the trailing slot each sit on a small `bg-surface` plate with
  chip rounding, and the stripes show around and between them. The text keeps
  exactly its normal colours, because it never overlaps a band. It reads as a
  label on hazard tape, which is intentional.

Layout rules for the plates:

- **Nothing moves when stripes appear or clear.** Each plate is always
  present. It gets `px-1.5` with a matching `-mx-1.5`, so text position is
  identical striped or not. Only the background toggles.
- Truncation is unchanged: the identity plate is a `min-w-0` flex child, so
  the path still clips from the start (`truncate-start`).

## Stripe geometry

Vertical bars, 7px accent and 7px gap. A 45° band pattern with a 10px period
repeats every ~14px horizontally, so a 14px vertical period keeps the same
visual rhythm across the header instead of turning into a dense barcode.

## Tasks

1. CSS: `.pane-header-completion-stripes` becomes vertical, full accent, 7/7.
   Rewrite its WHY comment.
2. `PaneHeader`: wrap the identity items in a plate span, and wrap trailing
   content in one. Both get `bg-surface` only while striped. Add
   `data-completion-plate` for tests.
3. Tests: extend `PaneHeader.completionStripes.renderer.test.tsx`. Plates are
   opaque only while striped, and the plate padding is offset by an equal
   negative margin so the text does not shift.
4. Update the #1176 plan's line on diagonal stripes.
5. `npx tsc -b`, targeted tests, PR with `Fixes #1191`.
