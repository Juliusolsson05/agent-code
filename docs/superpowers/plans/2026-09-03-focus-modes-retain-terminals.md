# Workspace: keep terminals alive across Reader, Spotlight and Settings

Fixes #752. Refs #745, #749, #103, #390.

## Problem

`MainSurface` renders Settings, `ReaderView` and `SpotlightView` *instead of*
the `GlobalEditorShell → TileTree` subtree. Entering any of them unmounts
every pane; with `agentViewMode = 'terminal'` that disposes every xterm and
detaches every PTY, and leaving re-mounts the tree from scratch: N ×
(attach + up to 512 KiB replay + parse + fit/resize handshake) on the
renderer thread, a multi-second freeze, lost scrollback, and a burst of
`agent-pty-attach` / `resize` / `session:screen` IPC. The app already
solves this for Global Editor fullscreen by RETAINING the workspace under
`display:none` and telling the terminal ownership boundary that "mounted"
no longer means "visible" (`GlobalEditorWorkspaceSlot`,
`AgentTerminalOwnerVisibilityProvider`).

## Design

- `RetainedWorkspaceSurface` (app/shell) wraps the shell subtree: when a
  takeover surface is active it sets `display:none` on a layout-neutral
  wrapper (`display:contents` otherwise), provides
  `AgentTerminalOwnerVisibilityProvider visible={false}` so hidden panes
  neither claim dimension ownership nor measure, and provides a new
  `WorkspaceSurfaceHiddenContext` for anything that must know the subtree
  is retained-but-hidden.
- `MainSurface` always renders the retained workspace and renders the
  takeover surface (Settings / Reader / Spotlight) alongside it. The
  takeover surfaces keep bypassing `GlobalEditorShell` for the layout
  reasons documented there; only the shell's mount lifetime changes.
- `TileLeaf` folds `WorkspaceSurfaceHiddenContext` into its Tail-All
  visibility mask next to the editor-fullscreen term, so un-hiding is a
  genuine false→true transition that re-pins (same reasoning as the
  existing mask comment).
- `GlobalEditorShell`'s fullscreen Escape listener ignores keys while the
  surface is hidden, so Escape in Reader Mode exits Reader (owned by
  `useKeybinds`) instead of also collapsing a fullscreen editor underneath.

Spotlight mounts its own leaf for the focused session; the hidden tile-
tree leaf keeps its PTY attachment (refcounted in main) and its xterm
keeps parsing while hidden. That parse cost is far below a replay and is
exactly what editor fullscreen already accepts. Hidden feeds keep
rendering; freezing them is a separate structural item.

Not in scope: hoisting xterm instances out of React (the structural fix
tracked in #752's second half and the architecture audit).

## Verification

- `TerminalDimensionOwnership.renderer.test.tsx`: Settings/Reader/
  Spotlight keep the pane terminal MOUNTED (mount count stays 1 across
  enter/exit) and hidden; dimension ownership still hands to the inline
  debug terminal while hidden and returns afterwards.
- Existing Spotlight target-guard test adapted to the retained tree.
- `npx tsc -b`; renderer suites for app/shell, tile-tree, global-editor.
