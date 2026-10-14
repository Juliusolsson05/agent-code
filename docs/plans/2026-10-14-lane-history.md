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
