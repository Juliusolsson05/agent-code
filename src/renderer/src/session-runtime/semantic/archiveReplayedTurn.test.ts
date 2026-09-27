import { expect, it } from 'vitest'

import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { archiveReplayedTurn, semanticHistoryRow } from './helpers'

// #1391 (review a rounds 1-3, steering q93): at bootstrap-complete a replay
// copy of an archived turn is MERGED field-wise (longer string wins, objects
// merge key by key, id lists union), so nothing the archived row painted can
// vanish, and anything the replay added is kept. Asserted through the REAL
// ledger adapter: what matters is what the feed would paint.
//
// Limit (q93): no recorded bootstrap-overlap sequence exists in the fixture
// corpus, so the turn states are built deterministically from the event shapes
// the reviewer traced (foldEvent's turn_started/block_started with no deltas
// yet). No claim is made about how often they occur.
type Block = Record<string, unknown>
const turn = (text: string, blocks: Block[], endedAt: number | null = 2) => ({
  turnId: 'T', source: 'rollout' as const, text,
  blocks: Object.fromEntries(blocks.map((block, index) => [index, { blockIndex: index, kind: 'text', status: 'completed', finalized: true, ...block }])),
  blockOrder: blocks.map((_, index) => index),
  stopReason: null, usage: null,
  task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
  startedAt: 1, endedAt,
  lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
}) as never

/** What the feed would paint for this history: candidate id -> painted text. */
function painted(history: ReturnType<typeof archiveReplayedTurn>, provider: 'claude' | 'codex' = 'claude'): Record<string, string> {
  const bundle = createLedgerInputAdapter()({
    provider, sessionId: 's', entries: [], semanticCurrent: null, semanticHistory: history as never,
    ghosts: new Map(), streamPhase: 'idle', lastJsonlEntryAtMs: null,
  })
  return Object.fromEntries(bundle.input.live.map(candidate => [candidate.id, candidate.textKey ?? '']))
}

// Round 1: a repeated turn_started reopens T with empty turn text (blockless).
it('keeps a blockless archived answer when the replay reopened it empty', () => {
  const history = archiveReplayedTurn([semanticHistoryRow(turn('answer', []))], turn('', [], 3))
  expect(history.map(row => row.turnId)).toEqual(['T'])
  expect(Object.values(painted(history))).toContain('answer')
})

// Round 2: the replay re-emitted block_started for index 0, no text_delta yet.
it('keeps the archived block when the replay reopened the same block empty', () => {
  const history = archiveReplayedTurn([semanticHistoryRow(turn('', [{ text: 'answer' }]))], turn('', [{ text: '', status: 'in_progress', finalized: false }], 3))
  expect(painted(history)['sem:T:0']).toBe('answer')
})

// Round 3 (a): a Codex reasoning block painted from reasoningSummary.
it('keeps a provider-specific drawable field (Codex reasoningSummary)', () => {
  const archived = turn('', [{ kind: 'thinking', reasoningSummary: 'reasoned answer' }])
  const reopened = turn('', [{ kind: 'thinking', reasoningSummary: '' }], 3)
  const history = archiveReplayedTurn([semanticHistoryRow(archived)], reopened)
  expect((history[0]!.blocks[0] as Block).reasoningSummary).toBe('reasoned answer')
})

// Round 3 (b): the ledger ignores turn text when blocks exist, so longer turn
// text must not stand in for the missing answer block.
it('keeps the answer block even when the replay carries longer (unpainted) turn text', () => {
  const history = archiveReplayedTurn(
    [semanticHistoryRow(turn('', [{ text: 'answer' }]))],
    turn('answer with extra words', [{ text: '', status: 'in_progress', finalized: false }], 3),
  )
  expect(painted(history)['sem:T:0']).toBe('answer')
})

// q93: mixed progress. The archive has block 0; the replay has block 0 still
// empty but ALSO a block the archive never saw. Both must paint.
it('keeps archived content and the replay\'s new block together (mixed progress)', () => {
  const history = archiveReplayedTurn(
    [semanticHistoryRow(turn('', [{ text: 'first part' }]))],
    turn('', [{ text: '', status: 'in_progress', finalized: false }, { text: 'second part' }], 3),
  )
  expect(painted(history)).toMatchObject({ 'sem:T:0': 'first part', 'sem:T:1': 'second part' })
  expect(history).toHaveLength(1)
})

it('takes the replay copy where it is longer, and archives a turn not in history yet', () => {
  const history = archiveReplayedTurn([semanticHistoryRow(turn('', [{ text: 'answer' }]))], turn('', [{ text: 'answer, continued' }], 3))
  expect(painted(history)['sem:T:0']).toBe('answer, continued')
  expect(archiveReplayedTurn([], turn('answer', [])).map(row => row.turnId)).toEqual(['T'])
})

// The string rule is prefix-extension, not "longer wins": a reopened block's
// status 'in_progress' is LONGER than 'completed', and taking it would drop
// the block's text ownership key (textKey is set only for completed text).
// The archived block is completed WITHOUT finalized, the Codex shape
// semantic.ts documents (#492), so status is the only terminal evidence.
it('does not reopen a completed block through its longer status string', () => {
  const history = archiveReplayedTurn(
    [semanticHistoryRow(turn('', [{ text: 'answer', finalized: undefined }]))],
    turn('', [{ text: 'answer', status: 'in_progress', finalized: false }], 3),
  )
  expect(painted(history)['sem:T:0']).toBe('answer')
})

// A replay that reopened only block 0 must not drop the archived block 1:
// blockOrder is unioned, not replaced.
it('keeps an archived block the replay has not re-emitted yet', () => {
  const history = archiveReplayedTurn(
    [semanticHistoryRow(turn('', [{ text: 'first part' }, { text: 'second part' }]))],
    turn('', [{ text: 'first part' }], 3),
  )
  expect(painted(history)).toMatchObject({ 'sem:T:0': 'first part', 'sem:T:1': 'second part' })
})
