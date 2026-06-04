# Tiled Dispatch — Design Spec

**Issue:** #248 (Tiled Dispatch)
**Date:** 2026-06-04
**Status:** Approved design, pre-implementation

## Summary

Add a `Tiled Dispatch` command that opens a multi-lane Dispatch layout. The
user picks a tile count (1–10). The leftmost lane keeps the full Dispatch
index (section titles, worktree grouping, provider/type labels, full agent
titles). Every additional lane gets a compact mini-list plus its own live
agent view, each independently switchable. This turns Dispatch from a
single-agent command center into a cockpit where several live agents are
visible and controllable at once — directly serving the project's
"run 5+ agents in parallel" thesis.

## Why this shape (and not the obvious alternative)

The obvious alternative is to model the tiled layout as a second `TileNode`
tree (reusing the grid's recursive split machinery). We are **not** doing
that. Two reasons:

1. **The spec is a flat horizontal sequence of lanes, never a recursive
   split.** There is no nesting in the issue's layout — it's
   `[full index][view 1][mini 2][view 2]…[mini N][view N]`. A binary
   split tree is the wrong data structure for a fixed linear strip.
2. **A second `TileNode` tree drags in coupling we don't need** — parallel
   tree-mutation actions, persistence/rehydrate remap paths, and a second
   focus-id authority. The exploration of the tile-tree subsystem confirmed
   this is the expensive path with no payoff for a linear layout.

Instead, Tiled Dispatch is a **lane array that lives inside the existing
`dispatchMode` state**. It reuses the session-rendering entry point
(`renderWorkspaceLeaf`), the resize primitives (`useResizableSplitter` +
`SplitHandle`), and the existing row selectors. It adds one component, one
small selector helper, a few reducer actions, and a command. The grid,
the tile-tree, and the session manager are untouched.

## The load-bearing invariant: no session-manager changes

Switching which agent a lane shows is **exactly** what today's
`DispatchLayout` already does with its single `activeRow`: it calls
`renderWorkspaceLeaf(sessionId, …)` (DispatchLayout.tsx:187), and changing
that `sessionId` does **not** kill the previously shown agent. Sessions are
killed only by the explicit `closeSession` action, never on unmount. Input,
output subscriptions, and runtime are all keyed by `sessionId` globally
(not per view). So "N lanes, each a different live agent, switchable, no
respawn, no kill on exit" is N invocations of an operation that already
works.

The **only** thing in the codebase that assumes 1:1 view↔session is the
*terminal* xterm attach (a `Set`, single attacher) and its replay buffer.
We sidestep this entirely with one rule:

> **A given session may occupy at most one lane at a time.** A mini-list
> greys out (and refuses to select) any session already shown in another
> lane.

This rule (a) avoids any session-manager/ref-counting refactor, (b) is
better UX (no reason to mirror one agent into two lanes), and (c) means
terminals — which can appear in a lane like any other session — never get
double-attached. The feature stays purely additive.

## State model

Extend `DispatchModeState` (workspace/types.ts) with an optional tiled block:

```ts
export type DispatchLane = {
  /**
   * The session this lane currently shows. Undefined = "empty lane"
   * (renders a lane-local picker prompt). On re-entry, a lane whose
   * session no longer exists is reset to undefined and falls back to the
   * next visible agent not already claimed by another lane.
   */
  selectedSessionId?: SessionId
}

export type TiledDispatchState = {
  /**
   * lanes[0] is the index lane (full DispatchAgentList). lanes[1..N-1] are
   * compact mini-list + agent-view lanes. length is the user's tile count,
   * clamped 1..10. We store lanes explicitly (not just a count) so each
   * lane's selected agent survives mode toggles and reloads.
   */
  lanes: DispatchLane[]
  /**
   * Which lane currently owns keyboard selection (arrows / cmd+N). Index
   * into `lanes`. Defaults to 0 (the index lane). Switching focus between
   * lanes must never steal another lane's selection.
   */
  focusedLane: number
  /**
   * Per-boundary split ratios for resizable lane widths. ratios[i] is the
   * fraction given to the left side of boundary i. Reuses the same
   * clamped-ratio approach as the grid SplitContainer. Absent => even.
   */
  ratios?: number[]
}

export type DispatchModeState = {
  scope: 'project' | 'global'
  focusedSessionId?: SessionId   // unchanged: classic single-view selection
  tiled?: TiledDispatchState     // present => render TiledDispatchLayout
}
```

`tiled` being optional is the render fork: absent → today's classic
single-agent `DispatchLayout` (unchanged); present → `TiledDispatchLayout`.
Because `dispatchMode` is already persisted to `workspace.json`, lanes,
focused lane, and ratios persist for free.

## Rendering

`DispatchLayout` gains a one-line fork at the top:

```tsx
if (workspace.state.dispatchMode?.tiled) {
  return <TiledDispatchLayout workspace={workspace} … />
}
// …existing classic layout unchanged…
```

`TiledDispatchLayout` (new component, `workspace/dispatch/TiledDispatchLayout.tsx`):

- **Lane 0 (index lane):** renders the existing `DispatchAgentList`
  (extracted/exported from DispatchLayout so both layouts share it) at a
  fixed/ratio width, pinned on the left. Clicking a row sets lane 0's
  selected agent. To its right, lane 0's agent view via
  `renderWorkspaceLeaf`.
- **Lanes 1..N-1:** each is `[compact mini-list][agent view]`. The mini-list
  is a new dense, header-less variant (no repeated section titles / worktree
  labels / provider chips — just enough to switch the lane). The agent view
  is another `renderWorkspaceLeaf` call.
- **Boundaries:** every lane boundary is a `SplitHandle` driven by
  `useResizableSplitter`, writing into `tiled.ratios`. Same epsilon/clamp
  discipline as the grid SplitContainer.
- **Overflow:** the index lane (lane 0) is pinned and fixed-width; the strip
  of lanes 1..N-1 to its right is what horizontally overflows/compresses at
  high tile counts, so the rich index stays readable.
- **Focus highlight:** lane 0's index always highlights lane 0's selected
  agent. Each mini-list highlights its own lane's selection. The focused
  lane gets a subtle border treatment (reusing the pane-focused style) so
  the user knows which lane keyboard selection targets.

### Selection per lane

Reuse `selectVisibleDispatchRow(rows, laneSelectedId, fallback)` once per
lane to resolve what each lane shows, with the existing stale-id fallback.
A new tiny helper computes the set of session ids already claimed by other
lanes so mini-lists can grey them out:

```ts
// workspace/dispatch/tiledDispatchSelectors.ts
export function claimedSessionIds(
  lanes: DispatchLane[],
  exceptLaneIndex: number,
): Set<SessionId>
```

The full visible row list comes from the existing
`buildVisibleDispatchRows(state)` — both the index lane and the mini-lists
derive from the same single source of truth for "row N" semantics, so
keyboard dispatch and rendering can't drift.

## Actions (workspace/hook/actions/dispatch.ts)

New reducers, all defensive on top of UI guards (same style as the existing
pin reducers):

- `enterTiledDispatch(count: number)` — clamp count to 1..10, build a lane
  array, auto-assign each lane the next visible agent **not already claimed**
  (so the user lands on a useful pre-filled layout), set `tiled` on
  `dispatchMode` (entering dispatch first if needed), clear `tileTabs`.
- `setTiledLaneSession(laneIndex, sessionId)` — assign a lane's agent;
  no-op if the session is already claimed by another lane (enforces the
  one-session-per-lane invariant at the reducer, not just the UI).
- `setTiledLaneCount(count)` — grow (append empty/auto-filled lanes) or
  shrink (drop from the right); never reshuffle or respawn surviving lanes.
- `setTiledFocusedLane(laneIndex)` — move keyboard focus between lanes.
- `setTiledRatios(ratios)` — persist resized boundaries.
- `exitTiledDispatch()` — clear `tiled` (returns to classic dispatch view;
  agents keep running). Exiting Dispatch entirely (`exitDispatchMode`) also
  naturally drops `tiled` with the rest of `dispatchMode`.

On re-entry/rehydrate, a sanitizer drops lane sessions that no longer exist
and re-fills from unclaimed visible agents — same defensive pattern as
`buildPinnedDispatchRows` dropping dead pins at render time.

## Command + prompt

The command palette already has an internal "mode" mechanism for input
prompts (prompt-template, AI-workspace create/open). Reuse it — no new
overlay:

- New command `tiled-dispatch` in `layoutCommands.ts`, `surface: 'app'`,
  title "Tiled Dispatch", `keepPaletteOpen: true`. Its `run` puts the palette
  into a new `tiled-dispatch-count` mode: a single numeric input,
  placeholder "How many dispatch tiles? 1–10", default 2 (or the previous
  tile count if a tiled layout existed before).
- On submit: clamp to 1..10 and call `ui.enterTiledDispatch(count)`; close
  palette. Invalid/empty input is clamped (≥1, ≤10), never errors.
- When already in tiled dispatch, the same command re-prompts and applies
  via `setTiledLaneCount` (preserving existing lane selections).

A complementary `exit-tiled-dispatch` is unnecessary: `Dispatch Mode`
(toggle) already exits, and re-running `Tiled Dispatch` with the palette is
the adjust path. We expose tiled exit-to-classic via the count prompt
accepting `1`? No — `1` is a valid single-lane tiled view. Returning to the
classic layout is done by toggling Dispatch off/on or via the existing
Dispatch Mode command. (Keeping the command surface minimal; no redundant
commands.)

## Keyboard (workspace/tile-tree/useKeybinds.ts)

The dispatch keybind block becomes lane-aware when `tiled` is present:

- Arrow Up/Down (and vim j/k): move selection **within the focused lane**.
- `cmd+N`: select the Nth visible row **into the focused lane** (reusing the
  existing `globalIndex` row labels and multi-digit logic, retargeted from
  the single dispatch focus to `tiled.lanes[focusedLane]`).
- A lane-switch keybind (e.g. arrow Left/Right, or `[`/`]`) moves
  `focusedLane`. Switching lanes must not change any lane's selection.

When `tiled` is absent, the existing single-selection keybinds are
unchanged.

## What's explicitly deferred (YAGNI for v1)

**Scroll-sync** — the issue's "scrolling a mini-list nudges the full index to
the same region while keeping lane 0's highlight" behavior. It's the
fiddliest part (two-way scroll coupling that must not move selection) and is
pure polish; the core value lands without it. Deferred to a follow-up. The
spec/code will leave a clear seam (a `scrollAnchorKey?` field reserved on
`DispatchLane`) so phase 2 can add it without reshaping state.

## Components / files touched

| File | Change |
|---|---|
| `workspace/types.ts` | Add `DispatchLane`, `TiledDispatchState`; extend `DispatchModeState` |
| `workspace/dispatch/DispatchLayout.tsx` | Top-level fork; extract & export `DispatchAgentList` for reuse |
| `workspace/dispatch/TiledDispatchLayout.tsx` | **New** — the multi-lane layout |
| `workspace/dispatch/DispatchMiniList.tsx` | **New** — compact lane selector |
| `workspace/dispatch/tiledDispatchSelectors.ts` | **New** — `claimedSessionIds`, lane resolution + sanitizer helpers |
| `workspace/hook/actions/dispatch.ts` | New reducers (enter/exit/setLane/setCount/setFocusedLane/setRatios) |
| `workspace/hook/index.ts` / context types | Expose new actions on the workspace hook |
| `features/workspace/commands/layoutCommands.ts` | `tiled-dispatch` command |
| `features/command-palette/ui/CommandPalette.tsx` | `tiled-dispatch-count` numeric prompt mode |
| `workspace/tile-tree/useKeybinds.ts` | Lane-aware dispatch keybinds |
| `app/App.tsx` | (only if the dispatch render branch needs the new props — likely none) |

## Testing / verification

Per project convention (no new test files in feature PRs), verification is:
`npm run typecheck`/`build` green, and a manual smoke test launching the app:
enter Tiled Dispatch with 3 tiles, assign different agents per lane, confirm
no respawn (process ids stable), switch lanes without stealing selection,
resize boundaries, toggle Dispatch off/on and confirm agents survive, reload
and confirm lanes persist.

## Out of scope

- Scroll-sync between mini-lists and the index lane (phase 2).
- Per-lane independent scope (project vs global) — the whole tiled view
  shares `dispatchMode.scope`.
- Reordering lanes by drag.
- Showing the same session in two lanes simultaneously (explicitly forbidden
  by the one-session-per-lane invariant).
