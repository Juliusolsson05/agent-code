# Lane History

**Status:** implemented on `feat/lane-history`. The owner asked for it on
2026-10-14: "see all agents that was focused in a lane and how long ago …
super simple UI, click on a history item and go to that agent".

## What it does

Run **Lane History** from the palette. A small dialog lists every agent that
has been in the **focused lane**:

- The current agent comes first, marked "Now".
- Past agents follow, newest first, each with how long ago it left ("5m ago").
- Clicking a row (or pressing Enter, with ↑/↓ to move) puts that agent back
  in this lane, focuses the lane and closes the dialog.
- Closed agents are not listed.

## Design

- **Data on the lane:** `DispatchLane.history?: { sessionId, at }[]`. Lane
  objects are spliced intact by every grid edit, so a lane's history moves
  with the lane through New Lane, Remove Lane and New Row.
- **One writer:** `withLaneSession` records the agent it replaces. Every
  selection path already goes through it: index click, strip, spawn focus,
  label navigation, control-plane show, extension views, new tab. Clear Lane
  records through `withLaneClearedByUser`. Session destruction (kill, close,
  prune) records nothing.
- **`at` is when the agent LEFT the lane.** That is the moment "how long ago
  was it here" refers to.
- **One row per agent:** an agent that returns moves to the top. The list is
  capped at 50 distinct agents because it rides autosave.
- **Durability:**
  - `remapTiledLanes` remaps history ids, because a reload or provider switch
    keeps the same agent under a new id.
  - `keepTiledLaneSessions` prunes dead ids, so an autosave never keeps a
    dead pointer.
  - The load projection in `workspaceShape.ts` copies history through
    `sanitizeLaneHistory`. A corrupt file costs only the bad rows and never
    blocks boot.
- **UI:** a palette command (`lane-history`) and a modal surface (the
  `uiShell.laneHistoryLane` index, captured when the command runs). There is
  no per-lane button: lanes have no header of their own, and a chip on every
  lane costs more than an occasional question is worth.

## Defaults (not confirmed by the owner)

1. "Go to that agent" means **put it back in this lane**. It does not jump to
   wherever else that agent might be showing.
2. The current agent is listed as "Now".
3. The dialog opens only from the palette, with no lane button and no default
   shortcut.
4. The list is capped at 50 distinct agents per lane.

## Review round (one Claude + one Codex reviewer)

All findings were valid and all are fixed. Each fix has a test, and the lane-shift test was checked by disabling the fix and watching it fail.

- **Both reviewers:**
  - **The dialog follows an index, not the lane itself.** It now closes, and refuses a pick, when a different lane slides into its slot.
  - **A file entry with `at: 1e20` crashed the dialog.** It passed `isFinite` but is outside the Date range. The sanitizer now limits `at` to ±8.64e15.
- **Codex:**
  - **Single Undo Close did not remap history.** It now remaps, the same as Undo Close Project. An autosave that runs between the close and the undo has already pruned the old id; that loss is accepted.
  - **A full list lost an unrelated entry when an agent came back.** The arriving agent is now removed before the cap is applied.
  - **Autofocus picked the older agent after Clear Lane.** Row 0 is now skipped only when it is "Now".
- **Claude:**
  - **The browser-pocket note was stale.** Updated it.
  - **An empty dialog had no focus.** It now keeps Radix's default, Close.
  - **Test gaps:**
    - Added a hook-level test that a selection records a departure.
    - The ⌘T test asserts the recorded departure again instead of comparing selections only.
    - There is still no single end-to-end autosave-then-load test. Prune and load are tested separately.

## Redesign: Lane Back + visible entry points (2026-10-14, later)

The owner found the palette-only dialog hidden and counter-intuitive. After
reading how the rest of the UI is built (lane anatomy, every picker, the
native menu path, the keyboard-first plan) the owner approved this redesign:

```
 A. ⌥B Lane Back                     B. pane header chip
 [A3] … → ⌥B → [A2] …                [A3] ~/dev/api          ↶ A2 ⌥B │FLAG│
 toast: "Back to A2 · ⌥B returns      click = back · right-click = native menu:
         to A3"                         Back to A2 … left 5m ago   ⌥B
                                        B1 … left 1h ago
 C. empty lane                          ─────────────
      Empty lane                        Lane History…
   RECENTLY HERE        ⌥B brings back the first
   A3 ⏺ fix the auth tests   left 2m ago
   A2 › build settings page  left 9m ago

 D. dialog (full list): "Lane History — Row 1 · Lane 2", house list model,
    rows = label · glyph · title · project · "left 5m ago", "Now: A3 …" line,
    footer ↑↓ move · Put Back ↩ · Close ⎋
```

- **One model** (`features/lane-history/laneHistoryModel.ts`): it decides
  "previous agent" for every surface, so the chip never advertises a key that
  does something else. `goBackInLane` reads the live store state, because a
  native menu is awaited and a captured Workspace would be stale.
- **⌥B is a toggle by construction.** `withLaneSession` records the agent
  being replaced, so the agent you just left is the next target. The binding
  is `Alt+B` in the `dispatch` context, and `check:keybindings` passes.
- **The chip is lane chrome inside the agent's header.** It is drawn through
  `LaneSlotContext`, which exists only inside a stage lane, so Spotlight and
  Sidekick headers show no chip, and none of the three leaf kinds had to
  learn about lanes. It appears only once the lane has a previous agent.
- **Native menu:** right-click uses `menu:popup`, the follow-up surface that
  plan #1185 named. A pick is re-checked against live state when it resolves.
- **Empty lane:** `DispatchEmpty` now takes children, so the list sits under
  "Empty lane" instead of below a full-height block. It shows up to 5 rows,
  and "N more — Lane History…" links to the dialog.
- **Dialog:** rebuilt on `useListNavigation`. The listbox holds focus,
  `aria-activedescendant` points at the highlighted row, rows use the accent
  rail, and the footer has a key legend and Put Back. The lane-shift guard
  from #1504 is kept.

### Review round for the redesign (#1511: one Claude + one Codex reviewer)

Neither reviewer found a blocker. Every should-fix item and every actionable nit is fixed, and each fix has a test. I proved the two guard fixes by disabling them and watching their tests fail.

- **Both reviewers:**
  - **The toast fired before a cold wake finished.** It expired early, and a failed wake still announced success. `goBackInLane` is now async: it toasts only once the lane really shows the target, and a per-lane in-flight guard stops a second ⌥B from starting a second wake.
  - **A native-menu pick could land in a lane that slid into the captured slot.** The pick is dropped unless the lane object is unchanged, and the "Lane History…" branch follows the same rule.
  - **The "Recently here" highlight slid when a row above it closed.** The list now passes the session ids as `keys`.
- **Codex:** the "N more" link could not be reached by keyboard. It is now a real tab stop.
- **Claude:**
  - **A short lane clipped its empty-lane content.** `DispatchEmpty` now scrolls, using `flex-1 min-h-0` plus inner `min-h-full` centring.
  - **The "N more" button sat inside the listbox.** It now sits outside it, because a listbox may only contain options.
  - **The keyboard-open check for the menu was dead code.** Chromium never reports coordinates of 0,0, so it never fired. The menu now always opens at the event's coordinates.
  - **Test gaps:**
    - A stale-Workspace test proves the model reads the live store.
    - The dialog branch of the menu now has a test.
    - The Enter test now checks that exactly one selection happens.
    - The real `TiledDispatchLayout` wiring is tested in `gridDispatchLayout.renderer.test.tsx`: lane slot provider and Recently here.
- **Accepted:** pressing ⌥B with no previous agent eats the keystroke, the same as ⌥H.
