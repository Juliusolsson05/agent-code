import type { SessionId, SessionKind } from '@renderer/workspace/types'

// What is left of the tile grid's "related agent" mini-tabs (#992).
//
// This module used to build, for a grid pane, the strip of its linked agents
// and orchestration workers (`buildGridRelatedAgentTabs`) and resolve which of
// them the pane was currently showing (`selectedGridRelatedSessionId`, backed
// by `WorkspaceState.gridRelatedSelections`). Both walked the tile tree and the
// detached bucket, and both are deleted with them — see the note in
// TileTree.tsx for why the stage does not need the feature.
//
// The TYPE survives because the strip's presentational half still does:
// PaneHeader, TileLeaf and AgentTerminalLeaf accept `relatedAgentTabs` as an
// optional prop (nothing passes it today) and have their own rendering tests.
// Stage 4 of the #992 plan decides between feeding that prop from the pool
// (children of the lane's occupant) and deleting the strip; this file goes
// away either way.

export type GridRelatedAgentRelation = 'parent' | 'linked' | 'orchestration'

export type GridRelatedAgentTab = {
  sessionId: SessionId
  relation: GridRelatedAgentRelation
  label: string
  title: string
  kind: SessionKind | undefined
  /** v2 owner of the session. Only ever produced by tests now. */
  placement: 'grid' | 'detached'
}
