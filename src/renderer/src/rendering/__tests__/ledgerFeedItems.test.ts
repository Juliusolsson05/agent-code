import { describe, expect, it } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import { deriveFeedRenderModel, type FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { selectMergedEntries } from '@renderer/workspace/mergedEntries'
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
// View bridge: the ledger must be able to drive Feed's EXISTING row
// components. These tests run full runtime scenarios through BOTH paths —
// legacy deriveFeedRenderModel and adapter→ledger→bridge — and compare the
// resulting item lists structurally (type + identity + payload object).
//
// The payload identity assertions matter as much as the order ones: the
// bridge must hand Feed the SAME Entry / SemanticLiveTurn object references
// the runtime holds, or every downstream memo (LazyEntry keyed on entry
// identity, SemanticStreamingTurn on turn identity) re-renders per tick —
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

function legacyItems(runtime: SessionRuntime): FeedRenderItem[] {
  const merged = selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null)
  return deriveFeedRenderModel({
    provider: 'claude',
    entries: merged,
    semanticHistory: runtime.semantic.history,
    semanticTurn: runtime.semantic.currentTurn,
    streamPhase: runtime.streamPhase,
    streamPhasePendingToolName: runtime.streamPhasePendingToolName,
    streamPhasePendingToolUseId: runtime.streamPhasePendingToolUseId,
  }).items
}

const shape = (i: FeedRenderItem): string => {
  switch (i.type) {
    case 'entry':
      return `entry:${typeof i.entry.uuid === 'string' ? i.entry.uuid : '?'}`
    case 'semantic-history':
    case 'semantic-current':
      return `${i.type}:${i.turn.turnId}`
    case 'work':
      return 'work'
    case 'empty':
      return 'empty'
  }
}

describe('view bridge: ledger rows drive legacy FeedRenderItems', () => {
  it('matches the legacy item list on the streaming scenario, with identical payload references', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt'), assistantEntry('a1', 'msg_1', T + 100, 'answer')]
    rt.lastJsonlEntryAt = T + 100
    rt.semantic.currentTurn = liveTurn('turn_live', T + 200, 'streaming…')
    rt.streamPhase = 'responding'

    const { items, dropped } = bridgeItems(rt)
    expect(dropped).toEqual([])
    expect(items.map(shape)).toEqual(legacyItems(rt).map(shape))

    // Payload identity: the bridge hands back the RUNTIME's objects.
    const entryItem = items.find(i => i.type === 'entry')
    expect(entryItem?.type === 'entry' && entryItem.entry).toBe(rt.entries[0])
    const semItem = items.find(i => i.type === 'semantic-current')
    expect(semItem?.type === 'semantic-current' && semItem.turn).toBe(rt.semantic.currentTurn)
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
    expect(items.map(shape)).toEqual(legacyItems(rt).map(shape))
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
