import { expect, it } from 'vitest'

import { archiveReplayedTurn, semanticHistoryRow } from './helpers'

// #1391 review a: a replay copy only displaces the archived turn when it
// renders at least as much (text AND blocks); either way one row per turnId.
const turn = (text: string, blocks: string[], endedAt: number | null = 2) => ({
  turnId: 'T', source: 'rollout' as const, text,
  blocks: Object.fromEntries(blocks.map(id => [id, { id }])), blockOrder: blocks,
  stopReason: null, usage: null,
  task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
  startedAt: 1, endedAt,
  lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
}) as never

it('keeps the archived turn when the replay copy has fewer blocks', () => {
  const history = [semanticHistoryRow(turn('answer', ['b1', 'b2']))]
  expect(archiveReplayedTurn(history, turn('answer', []))).toBe(history)
})

it('keeps the archived turn when the replay copy has less text', () => {
  const history = [semanticHistoryRow(turn('answer', ['b1']))]
  expect(archiveReplayedTurn(history, turn('', ['b1']))).toBe(history)
})

it('lets an equal or richer replay copy replace the archived one, once', () => {
  const history = [semanticHistoryRow(turn('answer', ['b1']))]
  const next = archiveReplayedTurn(history, turn('answer, continued', ['b1', 'b2']))
  expect(next.map(row => [row.turnId, row.text])).toEqual([['T', 'answer, continued']])
})

it('archives a turn that is not in history yet', () => {
  expect(archiveReplayedTurn([], turn('answer', ['b1'])).map(row => row.turnId)).toEqual(['T'])
})
