import { describe, expect, it } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import { type FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import {
  emptyRuntime,
  type SemanticLiveTurn,
  type SessionRuntime,
} from '@renderer/workspace/workspaceState'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/rendering/view/ledgerFeedItems'

// ---------------------------------------------------------------------------
// View bridge: the ledger must drive Feed's EXISTING row components. These
// tests run full runtime scenarios through adapter→ledger→bridge and assert
// the resulting BLOCK-LEVEL item list (#491) structurally + payload identity.
//
// (Before the Stage 3 cutover these compared against the legacy
// deriveFeedRenderModel as an oracle; that renderer is deleted, so the
// expected lists are now spelled out explicitly. The exhaustive
// scenario/fixture coverage lives in bundleCorpus/recordingCorpus.)
//
// The payload identity assertions matter as much as the order ones: the
// bridge must hand Feed the SAME Entry / block object references the runtime
// holds, or every downstream memo (LazyEntry on entry identity, the block row
// on block identity) re-renders per tick —
// the exact churn class D11 exists to prevent.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const userEntry = (uuid: string, ms: number, text: string) =>
  ({
    uuid,
    type: 'user',
    timestamp: iso(ms),
    permissionMode: 'default',
    message: { role: 'user', content: text },
  }) as unknown as Entry

const assistantEntry = (uuid: string, msgId: string, ms: number, text: string) =>
  ({
    uuid,
    type: 'assistant',
    timestamp: iso(ms),
    message: { id: msgId, role: 'assistant', content: text },
  }) as unknown as Entry

const liveTurn = (turnId: string, startedAt: number, text: string): SemanticLiveTurn =>
  ({
    turnId,
    text,
    source: 'proxy',
    blocks: { 0: { blockIndex: 0, kind: 'text', text, finalized: false } },
    blockOrder: [0],
    stopReason: null,
    usage: null,
    task: {} as SemanticLiveTurn['task'],
    lookups: {} as SemanticLiveTurn['lookups'],
    startedAt,
    endedAt: null,
  }) as SemanticLiveTurn

function bridgeItems(runtime: SessionRuntime): ReturnType<typeof ledgerToFeedItems> {
  const slices: RuntimeLedgerSlices = {
    provider: 'claude',
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }
  const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
  return ledgerToFeedItems(ledger, ledgerFeedContextFromRuntime(runtime, 'claude'))
}

const shape = (i: FeedRenderItem): string => {
  switch (i.type) {
    case 'entry':
      return `entry:${typeof i.entry.uuid === 'string' ? i.entry.uuid : '?'}`
    case 'semantic-block':
      return `semantic-block:${i.turnId}#${i.block.blockIndex}`
    case 'semantic-collapsed-activity':
      return `semantic-collapsed:${i.turnId}[${i.unit.blockIndices.join(',')}]`
    case 'semantic-text':
      return `semantic-text:${i.turnId}`
    case 'work':
      return 'work'
    case 'empty':
      return 'empty'
  }
}

describe('view bridge: ledger rows drive block-level FeedRenderItems', () => {
  it('emits block-level items on the streaming scenario, with identical payload references', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt'), assistantEntry('a1', 'msg_1', T + 100, 'answer')]
    rt.lastJsonlEntryAt = T + 100
    rt.semantic.currentTurn = liveTurn('turn_live', T + 200, 'streaming…')
    rt.streamPhase = 'responding'

    const { items, dropped } = bridgeItems(rt)
    expect(dropped).toEqual([])
    // #491: the live turn's single text block emits as ONE semantic-block item
    // (not a collapsed turn item). owner tags it current.
    expect(items.map(shape)).toEqual([
      'entry:u1',
      'entry:a1',
      'semantic-block:turn_live#0',
      'work',
    ])

    // Payload identity: the bridge hands back the RUNTIME's own objects — the
    // entry, and the exact block instance (keyed downstream, so a fresh copy
    // per tick would bust every memo — the D11 churn class).
    const entryItem = items.find(i => i.type === 'entry')
    expect(entryItem?.type === 'entry' && entryItem.entry).toBe(rt.entries[0])
    const blockItem = items.find(i => i.type === 'semantic-block')
    expect(blockItem?.type === 'semantic-block' && blockItem.owner).toBe('semantic-current')
    expect(blockItem?.type === 'semantic-block' && blockItem.block).toBe(
      rt.semantic.currentTurn!.blocks[0],
    )
  })

  it('un-collapses a multi-block turn: text + a non-churn tool paint per block, churn folds into a collapsed-activity receipt (#491)', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt')]
    rt.lastJsonlEntryAt = T
    // A history turn: text block, then 3 churn tools (Read/Grep/Read → collapse),
    // then a non-churn Edit tool (paints its own block). All resolved so nothing
    // is hidden by the collapsed-running rule.
    const done = { status: 'completed' as const }
    rt.semantic.history = [
      {
        turnId: 'turn_h',
        text: '',
        source: 'proxy',
        blocks: {
          0: { blockIndex: 0, kind: 'text', text: 'thinking about it', finalized: true },
          1: { blockIndex: 1, kind: 'tool_use', toolName: 'Read', toolUseId: 'r1', resultAt: T + 1 },
          2: { blockIndex: 2, kind: 'tool_use', toolName: 'Grep', toolUseId: 'g1', resultAt: T + 2 },
          3: { blockIndex: 3, kind: 'tool_use', toolName: 'Read', toolUseId: 'r2', resultAt: T + 3 },
          4: { blockIndex: 4, kind: 'tool_use', toolName: 'Edit', toolUseId: 'e1', resultAt: T + 4 },
        },
        blockOrder: [0, 1, 2, 3, 4],
        stopReason: null,
        usage: null,
        task: {} as SemanticLiveTurn['task'],
        lookups: {
          toolCallsById: { r1: done, g1: done, r2: done, e1: done },
        } as unknown as SemanticLiveTurn['lookups'],
        startedAt: T + 10,
        endedAt: T + 20,
      } as SemanticLiveTurn,
    ]

    const { items, dropped } = bridgeItems(rt)
    expect(dropped).toEqual([])
    expect(items.map(shape)).toEqual([
      'entry:u1',
      'semantic-block:turn_h#0', // the text block
      'semantic-collapsed:turn_h[1,2,3]', // Read/Grep/Read folded
      'semantic-block:turn_h#4', // Edit paints its own block
    ])
    const collapsed = items.find(i => i.type === 'semantic-collapsed-activity')
    expect(collapsed?.type === 'semantic-collapsed-activity' && collapsed.unit.readCount).toBe(2)
    expect(collapsed?.type === 'semantic-collapsed-activity' && collapsed.unit.searchCount).toBe(1)
  })

  it('renders ghost fallback rows through the entry item path (legacy fold parity)', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt'), assistantEntry('a1', 'msg_1', T + 100, 'done')]
    rt.lastJsonlEntryAt = T + 100
    rt.ghosts = new Map([
      [
        'g-turn_g-0',
        {
          uuid: 'g-turn_g-0',
          type: 'assistant',
          timestamp: iso(T + 900),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
          },
          _atp: { turnId: 'turn_g', blockIndex: 0, orphanedAt: T + 950, updatedAt: T + 900 },
        } as never,
      ],
    ])
    const { items, dropped } = bridgeItems(rt)
    expect(dropped).toEqual([])
    expect(items.map(shape)).toEqual(['entry:u1', 'entry:a1', 'entry:g-turn_g-0'])
  })

  it('empty session yields the empty item; entryOrdinals are contiguous over entry items only', () => {
    const rt = emptyRuntime()
    const empty = bridgeItems(rt)
    expect(empty.items.map(shape)).toEqual(['empty'])

    const rt2 = emptyRuntime()
    rt2.entries = [
      userEntry('u1', T, 'a'),
      assistantEntry('a1', 'msg_1', T + 100, 'b'),
      userEntry('optimistic-codex-user:5', T + 200, 'c'),
    ]
    rt2.lastJsonlEntryAt = T + 100
    rt2.streamPhase = 'submitting'
    const { items } = bridgeItems(rt2)
    const ordinals = items.filter(i => i.type === 'entry').map(i => (i.type === 'entry' ? i.entryOrdinal : -1))
    expect(ordinals).toEqual([0, 1, 2])
  })

  it('surfaces unresolvable candidates in dropped instead of silently omitting them', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt')]
    rt.lastJsonlEntryAt = T
    const slices: RuntimeLedgerSlices = {
      provider: 'claude',
      sessionId: 's1',
      entries: rt.entries,
      semanticCurrent: rt.semantic.currentTurn,
      semanticHistory: rt.semantic.history,
      ghosts: rt.ghosts,
      streamPhase: rt.streamPhase,
      lastJsonlEntryAtMs: rt.lastJsonlEntryAt,
    }
    const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
    // Context missing the entry on purpose — simulates a lookup drifting
    // out of sync with the candidate planes.
    const { items, dropped } = ledgerToFeedItems(ledger, {
      provider: 'claude',
      entriesByUuid: new Map(),
      turnsById: new Map(),
      streamPhase: 'idle',
      streamPhasePendingToolName: null,
      streamPhasePendingToolUseId: null,
    })
    expect(items.filter(i => i.type === 'entry')).toEqual([])
    expect(dropped).toEqual(['entry:u1'])
  })
})
