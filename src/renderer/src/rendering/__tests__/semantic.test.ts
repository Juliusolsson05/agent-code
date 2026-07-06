import { describe, expect, it } from 'vitest'

import {
  collectSemanticCandidates,
  type SemanticTurnLike,
} from '@renderer/rendering/observations/semantic'

const T0 = 1_700_000_000_000

function turn(over: Partial<SemanticTurnLike> = {}): SemanticTurnLike {
  return {
    turnId: 'turn-1',
    source: 'proxy',
    startedAtMs: T0,
    endedAtMs: T0 + 100,
    blocks: [{ blockIndex: 0, kind: 'text', text: 'answer', finalized: true }],
    ...over,
  }
}

describe('semantic collector', () => {
  it('history orders by endedAt, current by startedAt (the D4 timestamp choice)', () => {
    const { candidates } = collectSemanticCandidates(
      turn({ turnId: 'cur', startedAtMs: T0 + 500, endedAtMs: null }),
      [turn({ turnId: 'old', startedAtMs: T0, endedAtMs: T0 + 100 })],
      'codex',
      's1',
    )
    expect(candidates.find(c => c.turnId === 'old')?.timestampMs).toBe(T0 + 100)
    expect(candidates.find(c => c.turnId === 'cur')?.timestampMs).toBe(T0 + 500)
    expect(candidates.find(c => c.turnId === 'cur')?.owner).toBe('semantic-current')
  })

  it('#345: compaction synthesis yields ZERO candidates — every block rejected with reason', () => {
    const { candidates, decisions } = collectSemanticCandidates(
      turn({ isCompactionSynthesis: true, blocks: [
        { blockIndex: 0, kind: 'text', text: '<analysis>…internal…</analysis>' },
        { blockIndex: 1, kind: 'text', text: '<summary>…</summary>' },
      ] }),
      [],
      'claude',
      's1',
    )
    expect(candidates).toHaveLength(0)
    expect(decisions.every(d => d.reason === 'compaction-synthesis')).toBe(true)
  })

  it('dump invariant 14: a history turn with the current turn id is dropped with reason', () => {
    const { candidates, decisions } = collectSemanticCandidates(
      turn({ turnId: 'same' }),
      [turn({ turnId: 'same' })],
      'codex',
      's1',
    )
    // Only the current turn's block survives.
    expect(candidates).toHaveLength(1)
    expect(candidates[0].owner).toBe('semantic-current')
    expect(decisions.filter(d => d.reason === 'duplicate-turn-in-history')).toHaveLength(1)
  })

  it('empty thinking is not a renderable unit; substantive thinking is', () => {
    const { candidates, decisions } = collectSemanticCandidates(
      turn({ blocks: [
        { blockIndex: 0, kind: 'thinking', text: '   ' },
        { blockIndex: 1, kind: 'reasoning', text: 'real reasoning' },
      ] }),
      [],
      'opencode',
      's1',
    )
    expect(candidates.map(c => c.blockIndex)).toEqual([1])
    expect(decisions.find(d => d.candidateId === 'sem:turn-1:0')?.reason).toBe('empty-thinking')
  })

  it('empty write_stdin is Codex poll noise; non-empty renders (dump invariants 12/13)', () => {
    const { candidates } = collectSemanticCandidates(
      turn({ blocks: [
        { blockIndex: 0, kind: 'custom_tool_call', toolName: 'write_stdin', text: '' },
        { blockIndex: 1, kind: 'custom_tool_call', toolName: 'write_stdin', text: 'y\n' },
      ] }),
      [],
      'codex',
      's1',
    )
    expect(candidates.map(c => c.blockIndex)).toEqual([1])
  })

  it('text keys only on FINALIZED text — streaming text must not be suppressible mid-growth', () => {
    const { candidates } = collectSemanticCandidates(
      turn({ blocks: [
        { blockIndex: 0, kind: 'text', text: 'still growing', finalized: false },
        { blockIndex: 1, kind: 'text', text: 'done text', finalized: true },
      ] }),
      [],
      'codex',
      's1',
    )
    expect(candidates.find(c => c.blockIndex === 0)?.textKey).toBeUndefined()
    expect(candidates.find(c => c.blockIndex === 1)?.textKey).toBe('done text')
  })

  it('tool identity keys (toolUseId/callId/itemId) ride the candidate for ownership matching', () => {
    const { candidates } = collectSemanticCandidates(
      turn({ blocks: [
        { blockIndex: 0, kind: 'function_call', callId: 'call_1', itemId: 'item_1' },
        { blockIndex: 1, kind: 'tool_use', toolUseId: 'tu_1' },
      ] }),
      [],
      'codex',
      's1',
    )
    expect(candidates[0]).toMatchObject({ contentKind: 'tool-use', callId: 'call_1', itemId: 'item_1' })
    expect(candidates[1]).toMatchObject({ contentKind: 'tool-use', toolUseId: 'tu_1' })
  })
})
