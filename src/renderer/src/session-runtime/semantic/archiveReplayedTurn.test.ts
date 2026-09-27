import { expect, it } from 'vitest'

import { archiveReplayedTurn, semanticHistoryRow } from './helpers'

// #1391 review a (rounds 1 and 2): a replay copy only displaces the archived
// turn when it renders at least as much, measured as content (turn text plus
// block text, thinking, tool input and result), not counts. Always one row per
// turnId.
type Block = { text?: string; thinking?: string; inputJson?: string; resultContent?: string }
const turn = (text: string, blocks: Block[], endedAt: number | null = 2) => ({
  turnId: 'T', source: 'rollout' as const, text,
  blocks: Object.fromEntries(blocks.map((block, index) => [index, { blockIndex: index, kind: 'text', ...block }])),
  blockOrder: blocks.map((_, index) => index),
  stopReason: null, usage: null,
  task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
  startedAt: 1, endedAt,
  lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
}) as never

it('keeps the archived turn when the replay copy has less turn text', () => {
  const history = [semanticHistoryRow(turn('answer', []))]
  expect(archiveReplayedTurn(history, turn('', []))).toBe(history)
})

it('keeps the archived turn when the replay copy has fewer or emptier blocks', () => {
  const history = [semanticHistoryRow(turn('', [{ text: 'first' }, { text: 'second' }]))]
  expect(archiveReplayedTurn(history, turn('', [{ text: 'first' }]))).toBe(history)
})

// Round 2: equal block COUNT, but the replay's block is still empty.
it('keeps the archived answer when the replay reopened the same block empty', () => {
  const history = [semanticHistoryRow(turn('', [{ text: 'answer' }]))]
  expect(archiveReplayedTurn(history, turn('', [{ text: '' }]))).toBe(history)
})

it('counts thinking as content', () => {
  const history = [semanticHistoryRow(turn('', [{ thinking: 'reasoning' }]))]
  expect(archiveReplayedTurn(history, turn('', [{ thinking: '' }]))).toBe(history)
})

it('counts tool input as content', () => {
  const history = [semanticHistoryRow(turn('', [{ inputJson: '{"a":1}' }]))]
  expect(archiveReplayedTurn(history, turn('', [{ inputJson: '' }]))).toBe(history)
})

it('counts a tool result as content', () => {
  const history = [semanticHistoryRow(turn('', [{ resultContent: 'exit 0' }]))]
  expect(archiveReplayedTurn(history, turn('', [{ resultContent: '' }]))).toBe(history)
})

it('lets an equal or richer replay copy replace the archived one, once', () => {
  const history = [semanticHistoryRow(turn('', [{ text: 'answer' }]))]
  const equal = archiveReplayedTurn(history, turn('', [{ text: 'ANSWER' }]))
  expect(equal.map(row => [row.turnId, (row.blocks as Record<number, Block>)[0]?.text])).toEqual([['T', 'ANSWER']])
  const richer = archiveReplayedTurn(history, turn('', [{ text: 'answer, continued' }]))
  expect(richer.map(row => [row.turnId, (row.blocks as Record<number, Block>)[0]?.text])).toEqual([['T', 'answer, continued']])
})

it('archives a turn that is not in history yet', () => {
  expect(archiveReplayedTurn([], turn('answer', [])).map(row => row.turnId)).toEqual(['T'])
})
