# Tiled Dispatch New Lane Implementation Plan

## Outcome

Add a **New Lane** command to Tiled Dispatch. It inserts one lane immediately
to the right of the focused lane without spawning, cloning, closing, or moving
any session.

## Behavioral contract

- The focused lane remains focused and keeps its selected session.
- Existing lanes retain their relative order and selections.
- The inserted lane receives the first visible Dispatch session not already
  selected by another lane; it remains empty when every visible session is
  already represented.
- Insertion is available below the ten-lane ceiling and is inert at the
  ceiling or for a stale lane index.
- The full-index sidebar fraction and existing lane-width proportions survive
  insertion. A stored layout gives the new lane one average lane weight; an
  unstored layout continues to use the renderer's even distribution.
- After a successful command invocation, the originating live session shows
  the existing pane toast `New lane created`. Empty or stale originating lanes
  receive no toast because pane feedback is session-scoped.
- The command has no default keybinding.

## Implementation

1. Add a pure insertion helper next to the existing Tiled Dispatch removal
   helper. Reuse the canonical visible-row auto-fill path and keep all
   splice/focus/ratio invariants testable outside React.
2. Expose an `insertTiledLaneRight(laneIndex)` workspace action that safely
   applies the helper and otherwise leaves state untouched.
3. Add the `new-tiled-lane` Dispatch command before the two removal commands.
   Re-check tiled state and the lane ceiling in `run`, then report success via
   the originating session's pane toast.
4. Update the governed command-catalog baseline.
5. Add behavioral tests for insertion position, focus, auto-fill, limits,
   ratios, immutability, command admission, and toast routing.

## Verification

- Run the focused insertion and command tests.
- Run command-catalog governance tests.
- Run `npm run typecheck` and `npm run check:keybindings`.
- Run the full test suite before opening the PR.

