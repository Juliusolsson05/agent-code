# Terminal-view status header

Fixes #851.

## Problem

With Status Mode on (the default), a rendered agent pane's header strip fills
with the accent color while the agent works. An agent pane in Terminal view
never does, so a turn started from the raw TUI looks idle. Terminal view is the
recovery surface for a broken feed, so the pane that most needs watching is
the one that can't show it's busy.

## Root cause

`WorkspaceLeaf` (`src/renderer/src/workspace/tile-tree/TileTree.tsx`) gives
`showStatusMode` only to the rendered `TileLeaf`. `AgentTerminalLeaf` draws its
own copy of the header markup instead of rendering `PaneHeader`. The copy was
taken when the view-mode policy landed (eec24a90). It never picked up the
Status Mode fill, and it never picked up the color flag that `PaneHeader`
gained later (36846eb3).

The data is not the problem. `runtime.sessionStatus` comes from
`deriveSessionStatus`, which combines the semantic turn, `processActive` and
exit state. `processActive` is set by the headless packages' own spinner
detection and handled at workspace level in `useIpcSubscriptions`, so none of
these inputs depend on which leaf is mounted. That is why the tab bar and the
Dispatch list already show the terminal-view agent as running.

## Design

Have `AgentTerminalLeaf` render the shared `PaneHeader` instead of patching its
copy. Patching would fix this one symptom and leave in place the duplication
that caused it, and the missing color flag shows that duplication has already
drifted twice.

- `PaneHeader` gets two optional slots:
  - `badge`: surface identity text shown after the pane label (`raw claude`).
  - `trailing`: surface state pinned to the right of the padded group, left of
    the color flag (TAIL and `terminal view`).

  The label group becomes `flex-1` so `trailing` can sit at the right edge.
  Existing callers see no visual change because the group's content is
  left-aligned and the group has no background. The phone's `SessionView`
  passes neither slot and is unaffected.
- `PaneHeader` adds `data-status-lit` on the status row. It is a stable DOM
  hook for tests and debug tooling, following the `data-related-status`
  precedent, so assertions don't depend on Tailwind class names.
- `TileTree` passes `showStatusMode` to `AgentTerminalLeaf`.
- Terminal adornments switch color when the strip is lit. TAIL is
  `text-accent`, which disappears on a `bg-accent` row, so a lit row uses the
  inherited `accent-fg` for TAIL and `raw <provider>` instead.

### Consequences (deliberate)

- **Color flags** now appear on terminal-view headers. Same drift, same fix.
- **Header height:** in Status Mode, terminal-view headers use the compact
  status-row padding that rendered panes already use. Mixed grids get equal
  header heights where they used to differ by 8px.
- **Out of scope:**
  - No activity verb. The rendered header doesn't show one either; the feed's
    WorkIndicator does, and the raw TUI draws its own spinner.
  - Related-agent chips stay off the terminal header, as today.

## Tests

- New `AgentTerminalLeaf.statusHeader.renderer.test.tsx`:
  - Status Mode lights the terminal-view header while the session is running,
    and not while it is idle.
  - Status Mode off never lights it.
  - A flagged session paints its flag in terminal view.
- The three existing `AgentTerminalLeaf` harnesses mock a settings object with
  no `dispatchColorFlags`. The real store always has that key, and
  `PaneHeaderColorFlag` now reads it, so the mocks get `dispatchColorFlags: {}`.

## Verification

- Renderer tests for the touched files.
- `tsc -p tsconfig.node.json` and `tsc -p tsconfig.web.json`.
- `npm test` once at the end, on Node 24.
