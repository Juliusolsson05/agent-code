import { describe, expect, it } from 'vitest'

import {
  semanticRenderUnitPaintsDom,
  semanticTurnHasRenderableContent,
} from '@renderer/features/feed/ui/semantic/renderUnits'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

// Build a turn containing a single collapsible Read tool block whose live
// status is controlled by `status`. A running Read collapses into a
// collapsed_activity run that paints nothing (CollapsedActivityRow returns null
// while running); a completed one paints a "worked: …" receipt.
function readToolTurn(status: 'in_progress' | 'completed'): SemanticLiveTurn {
  const toolUseId = 'tu-read-1'
  return {
    turnId: 't1',
    text: '',
    source: null,
    blocks: {
      0: {
        blockIndex: 0,
        kind: 'tool_use',
        toolName: 'Read',
        toolUseId,
        parsedInput: { file_path: '/x/y.ts' },
      },
    },
    blockOrder: [0],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    lookups: {
      toolCallsById: {
        [toolUseId]: {
          toolUseId,
          blockIndex: 0,
          kind: 'tool_use',
          toolName: 'Read',
          status,
          inputJson: '',
          resultContent: null,
        },
      },
      toolUseIdsInOrder: [toolUseId],
      resolvedToolUseIds: status === 'completed' ? [toolUseId] : [],
      erroredToolUseIds: [],
    },
    startedAt: 0,
    endedAt: null,
  }
}

describe('semanticTurnHasRenderableContent', () => {
  it('returns false for a turn whose only unit is a running collapsed activity', () => {
    // Regression for feed audit Finding 3: the unit exists but paints null while
    // running, so the render model must NOT claim the turn owns visible content.
    expect(semanticTurnHasRenderableContent(readToolTurn('in_progress'))).toBe(false)
  })

  it('returns true once the same activity is completed (paints a receipt)', () => {
    expect(semanticTurnHasRenderableContent(readToolTurn('completed'))).toBe(true)
  })

  it('returns true for a plain text turn', () => {
    const turn = readToolTurn('in_progress')
    turn.text = 'here is the answer'
    turn.blocks = {}
    turn.blockOrder = []
    expect(semanticTurnHasRenderableContent(turn)).toBe(true)
  })
})

describe('semanticRenderUnitPaintsDom', () => {
  it('treats a running collapsed_activity as non-painting', () => {
    expect(
      semanticRenderUnitPaintsDom({
        type: 'collapsed_activity',
        count: 1,
        searchCount: 0,
        readCount: 1,
        listCount: 0,
        bashCount: 0,
        latestHint: null,
        blockIndices: [0],
        isRunning: true,
      }),
    ).toBe(false)
  })

  it('treats a finished collapsed_activity as painting', () => {
    expect(
      semanticRenderUnitPaintsDom({
        type: 'collapsed_activity',
        count: 1,
        searchCount: 0,
        readCount: 1,
        listCount: 0,
        bashCount: 0,
        latestHint: null,
        blockIndices: [0],
        isRunning: false,
      }),
    ).toBe(true)
  })
})
