import { describe, expect, it } from 'vitest'

import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState } from '@renderer/session-runtime/state'

// #738: a pending AskUserQuestion is dismissed (resultAt stamped) only by an
// EXPLICIT terminal stop. The proxy synthesizes `turn_stopped` with
// `stopReason: null` on stream death, the stale-flow reap and API errors —
// none of which means the user stopped answering.

function pendingQuestionTurn(): SemanticRuntimeState {
  let state = emptySemanticRuntime()
  state = foldSemanticEvent(state, { type: 'turn_started', turnId: 'turn-1', source: 'proxy', ts: 1 }, 'claude')
  state = foldSemanticEvent(state, {
    type: 'block_started',
    turnId: 'turn-1',
    blockIndex: 0,
    kind: 'tool_use',
    toolName: 'AskUserQuestion',
    toolUseId: 'q-1',
    source: 'proxy',
    ts: 2,
  }, 'claude')
  return state
}

function questionBlock(state: SemanticRuntimeState) {
  const turn = state.currentTurn
  expect(turn).not.toBeNull()
  const block = Object.values(turn!.blocks).find(candidate => candidate.toolUseId === 'q-1')
  expect(block).toBeDefined()
  return block!
}

describe('foldSemanticEvent turn_stopped and a pending AskUserQuestion', () => {
  it('leaves the question pending on a synthesized stop with no reason', () => {
    const state = foldSemanticEvent(
      pendingQuestionTurn(),
      { type: 'turn_stopped', turnId: 'turn-1', stopReason: null, source: 'proxy', ts: 3 },
      'claude',
    )
    expect(questionBlock(state).resultAt).toBeUndefined()
  })

  it('leaves the question pending on the ordinary tool_use pause', () => {
    const state = foldSemanticEvent(
      pendingQuestionTurn(),
      { type: 'turn_stopped', turnId: 'turn-1', stopReason: 'tool_use', source: 'proxy', ts: 3 },
      'claude',
    )
    expect(questionBlock(state).resultAt).toBeUndefined()
  })

  it('dismisses the question on an explicit terminal stop', () => {
    const state = foldSemanticEvent(
      pendingQuestionTurn(),
      { type: 'turn_stopped', turnId: 'turn-1', stopReason: 'end_turn', source: 'proxy', ts: 3 },
      'claude',
    )
    expect(questionBlock(state).resultAt).toEqual(expect.any(Number))
  })
})
