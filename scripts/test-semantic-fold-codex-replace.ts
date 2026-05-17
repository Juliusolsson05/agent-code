// TEMPORARY RENDERING REGRESSION SCRIPT.
//
// WHY this file is allowed to exist even though it is not the testing
// shape we want long-term:
// these focused scripts were added during the 2026-05 rendering rewrite
// because we needed executable guards immediately while the feed ownership
// bugs were still active. They are intentionally small and useful, but
// they are also messy compared with the proper unit/integration suite we
// want: no standard runner, no shared fixtures, and too much local test
// scaffolding per file. Keep them until #182 establishes the app-wide
// testing suite and #183 migrates/expands the rendering regression coverage
// into that structure.

import assert from 'node:assert/strict'

import { foldSemanticEvent } from '../src/renderer/src/workspace/semantic/foldEvent'
import { emptySemanticRuntime } from '../src/renderer/src/workspace/workspaceState'

function foldMany(
  events: Array<Record<string, unknown>>,
  state = emptySemanticRuntime(),
) {
  return events.reduce(
    (next, event) => foldSemanticEvent(next, event, 'codex'),
    state,
  )
}

function completedProxyMessageTurn() {
  return foldMany([
    {
      type: 'block_started',
      turnId: 'resp_old',
      blockIndex: 0,
      itemId: 'msg_old',
      kind: 'message',
      messagePhase: 'final_answer',
      status: 'in_progress',
      source: 'proxy',
    },
    {
      type: 'text_delta',
      turnId: 'resp_old',
      blockIndex: 0,
      itemId: 'msg_old',
      textDelta: 'old',
      textSoFar: 'old',
      source: 'proxy',
    },
    {
      type: 'block_completed',
      turnId: 'resp_old',
      blockIndex: 0,
      itemId: 'msg_old',
      kind: 'message',
      text: 'old',
      status: 'completed',
      source: 'proxy',
    },
  ])
}

{
  const state = completedProxyMessageTurn()
  assert.equal(state.currentTurn?.turnId, 'resp_old')
  assert.equal(state.currentTurn?.endedAt, null)
  assert.equal(state.currentTurn?.blocks[0]?.finalized, true)

  const next = foldSemanticEvent(
    state,
    {
      type: 'block_started',
      turnId: 'resp_new',
      blockIndex: 0,
      itemId: 'rs_new',
      kind: 'reasoning',
      source: 'proxy',
    },
    'codex',
  )

  assert.equal(next.currentTurn?.turnId, 'resp_new')
  assert.equal(next.currentTurn?.blocks[0]?.kind, 'reasoning')
  assert.equal(next.history.at(-1)?.turnId, 'resp_old')
}

{
  const live = foldMany([
    {
      type: 'block_started',
      turnId: 'resp_live',
      blockIndex: 0,
      itemId: 'msg_live',
      kind: 'message',
      status: 'in_progress',
      source: 'proxy',
    },
    {
      type: 'text_delta',
      turnId: 'resp_live',
      blockIndex: 0,
      itemId: 'msg_live',
      textDelta: 'still streaming',
      textSoFar: 'still streaming',
      source: 'proxy',
    },
  ])

  const next = foldSemanticEvent(
    live,
    {
      type: 'block_started',
      turnId: 'resp_stray',
      blockIndex: 0,
      itemId: 'rs_stray',
      kind: 'reasoning',
      source: 'proxy',
    },
    'codex',
  )

  assert.equal(next.currentTurn?.turnId, 'resp_live')
  assert.equal(next.history.length, 0)
}

{
  const completedToolWithoutTurnSeal = foldMany([
    {
      type: 'block_started',
      turnId: 'resp_tool',
      blockIndex: 0,
      itemId: 'fc_tool',
      kind: 'function_call',
      toolName: 'exec_command',
      callId: 'call_tool',
      status: 'in_progress',
      source: 'proxy',
    },
    {
      type: 'block_completed',
      turnId: 'resp_tool',
      blockIndex: 0,
      itemId: 'fc_tool',
      kind: 'function_call',
      toolName: 'exec_command',
      callId: 'call_tool',
      argumentsJson: '{}',
      status: 'completed',
      source: 'proxy',
    },
  ])

  const next = foldSemanticEvent(
    completedToolWithoutTurnSeal,
    {
      type: 'block_started',
      turnId: 'resp_followup',
      blockIndex: 0,
      itemId: 'rs_followup',
      kind: 'reasoning',
      source: 'proxy',
    },
    'codex',
  )

  // WHY a completed function_call without turn_completed must yield:
  // the 2026-05-16T19:08 debug bundle showed exactly this shape. The
  // old `resp_*` turn had completed message/function_call blocks but
  // no turn seal, so the strict Codex mismatch guard treated every
  // later response as a racing producer and dropped all live streaming.
  // A terminal proxy turn is safe to archive when the next proxy turn
  // starts; keeping it mounted is worse than losing a pending spinner.
  assert.equal(next.currentTurn?.turnId, 'resp_followup')
  assert.equal(next.history.at(-1)?.turnId, 'resp_tool')
}

{
  const liveTool = foldMany([
    {
      type: 'block_started',
      turnId: 'resp_live_tool',
      blockIndex: 0,
      itemId: 'fc_live_tool',
      kind: 'function_call',
      toolName: 'exec_command',
      callId: 'call_live_tool',
      status: 'in_progress',
      source: 'proxy',
    },
  ])

  const next = foldSemanticEvent(
    liveTool,
    {
      type: 'block_started',
      turnId: 'resp_stray_tool',
      blockIndex: 0,
      itemId: 'rs_stray_tool',
      kind: 'reasoning',
      source: 'proxy',
    },
    'codex',
  )

  assert.equal(next.currentTurn?.turnId, 'resp_live_tool')
  assert.equal(next.history.length, 0)
}

{
  const next = foldSemanticEvent(
    emptySemanticRuntime(),
    {
      type: 'block_started',
      turnId: 'resp_block_first',
      blockIndex: 0,
      itemId: 'msg_block_first',
      kind: 'message',
      status: 'in_progress',
      source: 'proxy',
    },
    'codex',
  )

  assert.equal(next.currentTurn?.turnId, 'resp_block_first')
  assert.equal(next.currentTurn?.blocks[0]?.kind, 'message')
}

{
  const next = foldSemanticEvent(
    emptySemanticRuntime(),
    {
      type: 'block_started',
      turnId: 'msg_late',
      blockIndex: 0,
      itemId: 'msg_late',
      kind: 'message',
      status: 'in_progress',
      source: 'proxy',
    },
    'claude',
  )

  assert.equal(next.currentTurn, null)
}

console.log('semantic fold Codex replacement tests passed')
