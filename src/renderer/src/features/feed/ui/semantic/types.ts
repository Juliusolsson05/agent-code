import type { SemanticLiveTurn } from '../../../../workspace/workspaceState'

// Derived render-unit shape used by buildSemanticRenderUnits.
//
// A semantic turn's raw `turn.blocks` is a bag of everything the
// proxy saw: text, thinking, tool_use, tool_result, citations, etc.
// We run one derivation pass over that bag to produce a tighter
// render unit list, where runs of low-signal tool churn
// (search/read/list/bash) collapse into a single "collapsed_activity"
// group. See renderUnits.ts for the flush/group logic and Feed.tsx's
// "WHY add a derived render-unit pass" note for the design rationale.
export type SemanticRenderUnit =
  | {
      type: 'block'
      block: SemanticLiveTurn['blocks'][number]
      toolState: SemanticLiveTurn['lookups']['toolCallsById'][string] | null
    }
  | {
      type: 'collapsed_activity'
      count: number
      searchCount: number
      readCount: number
      listCount: number
      bashCount: number
      latestHint: string | null
      blockIndices: number[]
      isRunning: boolean
    }
