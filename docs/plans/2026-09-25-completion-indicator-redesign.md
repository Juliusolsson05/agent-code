# Completion indicator: the outlined bar

Status: **owner-approved 2026-09-25 (variant F, "Outlined")** · Branch: `fix/completion-indicator-redesign` · Issue: #1200
History: #1172 / PR #1176 (45% diagonal stripes) → #1191 / PR #1192 (full-accent vertical bars + surface plates) → this plan.

## Outcome

When an agent finishes a turn you haven't seen, its pane header shows **the working bar, hollow**:
- the normal surface background;
- a 2px full-accent ring around the header row;
- the label chip, path and trailing state (TAIL) in the accent colour.

The Status Mode "working" bar stays solid accent. Filled means busy, outlined means done and unseen.

```
working   [█ B6  …/agent-code                 TAIL █]   solid accent, accent-fg text
finished  [┃ B6  …/agent-code                 TAIL ┃]   surface fill, 2px accent ring, accent text
seen      [  B6  …/agent-code                 TAIL  ]   plain header
```

## How this was chosen

- **Stripes, in any form, lost.** The owner rejected #1192's plates (the path's plate covered the row and the bars read as a broken barcode). Then, in a live preview page built with the real theme and accent tokens, they rejected five stripe variants that put the text directly on a patterned bar:
  - A: 8px full accent / 4px darker;
  - B: 7px / 7px;
  - C: pinstripe;
  - D: a polarity-aware second tone;
  - E: horizontal pinstripes.

  Small text over any pattern looked busy.
- **Round 2 put no pattern behind the text.** The options were:
  - F: outlined;
  - G: a stripe cap after the text;
  - H: a tick rail along the bottom;
  - I: a DONE pill;
  - J: tint plus a left edge;
  - K: a lit chip plus a ring.

  The owner picked **F**: "Outlined is by far the best one."
- A Codex planning agent's full stripe plan (two-tone bands, slot render contract, contrast matrix) is superseded. Two of its findings still stand; see Follow-ups.

## Why outlined works where stripes didn't

- **The text sits on the plain surface, as on every other header.** Nothing crosses a band, so no plate or recolouring tricks are needed, and a long path cannot hide the signal. The ring runs around the whole row, whatever the text does.
- **It is the same bar in the same colour, in a different "weight".** It reads as one family with the working fill, which was the owner's point: "together with the plate, like the main activity status".
- **The geometry is identical.** An inset `box-shadow` takes no layout space, so the row's height and the text's position don't change when it appears or clears. That also means no PTY resize for terminal panes.

## Design details

- **Row paint.** `.pane-header-completion-outline` sets `background-color: var(--color-surface)`, `color: var(--color-accent)` and `box-shadow: inset 0 0 0 2px var(--color-accent)`.
  - It replaces `.pane-header-completion-stripes` and `.pane-header-completion-plate`, which are both deleted.
  - Everything inside inherits the accent colour: the label chip text and its `border-current/30` border, and the path.
- **The plates from #1192 are removed.** The markup goes back to exactly the pre-#1192 flat structure: label, badge and path sit directly in the padded group, with no wrapper. The trailing slot renders directly in its wrapper again.
- **Trailing slots in the terminal leaves need no change.**
  - They colour TAIL `text-accent` whenever the header is not *lit*. An outlined header isn't lit, so TAIL is already accent.
  - The raw-provider badge stays `text-ink`. That's a surface-coloured label on a surface background, which is what it is on any unlit header.
  - No new slot contract is needed. That was the stripe plan's biggest code change, and it existed only because the stripes put the text on accent.
- **Colour flag.** The flag chunk is a child that paints over the row's inset ring on the right quarter. So the ring outlines the other three quarters, and the flag keeps its solid slice, as on the working bar.
- **Names.** The DOM hook becomes `data-completion-outlined` and the class `.pane-header-completion-outline`. The setting `showAgentCompletionIndicator` and its label ("Agent Completion Indicator") are unchanged; they never said "stripes".
- **When it shows is unchanged:** `showAgentCompletionIndicator && completionUnseen && !isSessionLive`. A running agent keeps the solid working fill with Status Mode on, and a plain header with it off. Seen and dwell logic is untouched.

## Contrast (changed in the #1209 review)

- **The ring** is the full `--color-accent`. It is a UI edge, which needs 3:1. The worst of 8 accents × 8 theme variants (including high contrast) is 3.21:1, Frost on Soft Light.
- **The text** is `color-mix(in srgb, var(--color-accent) 70%, var(--color-ink))`, not the pure accent.
  - Both reviewers found that pure accent text on the light surface drops the pane's label and path to 3.21–3.50:1 for Frost. That is below the 4.5:1 that 9–10px text needs, and worse than the 4.62:1 the same path has in `text-muted`.
  - Leaning 30% toward the theme's own ink darkens the text on light themes and lightens it on dark ones. The worst case across the same 64 combinations becomes 4.84:1.
- **The terminal views' TAIL keeps plain `text-accent`,** as it does on any unlit header. That weaker pairing already existed; it is not widened here.

## Visual seams to check in the app (review notes, accepted)

- **Status Mode label chip.** In Status Mode the row is exactly the label chip's height (16px). The 2px ring overlaps the chip's faint top and bottom border, so the chip reads as two short vertical ticks joined to the ring. No text is clipped.
- **Colour flag.** A flagged pane's flag covers the ring's right quarter, so the outline ends in an open bracket at the flag's 1px seam. This is intentional: the flag always owns its slice.

## Follow-ups (not in this PR)

- **Frost on light themes fails `accent-fg` contrast on the solid working fill** (3.83:1, needs 4.5:1; found by the Codex plan). This already existed and is independent of this change. It deserves its own issue: the proposed fix `#507097` shifts the hue everywhere on light themes.
- **Several comments call the Status Mode row "~5px".** It is `min-h-[5px]`; the label chip makes it at least 16px. This is comment-only.

## Tasks

1. `styles.css`: replace the stripes and plate rules with `.pane-header-completion-outline`, with a WHY comment covering the rejected stripe designs.
2. `PaneHeader.tsx`: apply the outline class and `data-completion-outlined`, remove both plates, and update the header comment.
3. Tests:
   - Rename `PaneHeader.completionStripes.renderer.test.tsx` to `PaneHeader.completionIndicator.renderer.test.tsx`.
   - Keep every state and setting case.
   - Replace the plate test with a long-path case: no surface-coloured wrapper around the label or path, and the outline class sits on the header row itself.
4. Point the older plans' lines about stripes to this plan.
5. `npx tsc -b` and the header, tile-tree and colour-flag suites. Then open the PR with `Fixes #1200`, run one review round, wait for green CI, and merge on approval.
