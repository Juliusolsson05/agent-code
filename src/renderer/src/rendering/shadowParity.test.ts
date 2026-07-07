import { describe, expect, it } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import { deriveFeedRenderModel } from '@renderer/features/feed/model/renderModel'
import { selectMergedEntries } from '@renderer/workspace/mergedEntries'
import {
  emptyRuntime,
  emptySemanticRuntime,
  type SemanticLiveTurn,
  type SessionRuntime,
} from '@renderer/workspace/workspaceState'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  diffShadowUnits,
  ledgerUnits,
  legacyUnits,
  type LegacyItemLike,
  type ShadowDiffResult,
} from '@renderer/rendering/shadow/shadowDiff'

// ---------------------------------------------------------------------------
// Shadow PARITY suite — the Stage 2 diff run inside CI.
//
// This is the exact comparison useRenderShadow performs live, executed over
// constructed runtimes so divergence triage starts NOW, in a test, with a
// minimal repro attached — not later in a soak console with a live session
// attached. Each scenario is a runtime state the incident trail proved
// matters. The assertion is zero divergences; when the two renderers
// legitimately must disagree (the new pipeline FIXES a legacy bug), the
// scenario asserts the EXPECTED divergence explicitly with the issue
// reference, so an unexplained diff can never hide inside a blanket
// "known to differ" escape hatch.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

function runParity(runtime: SessionRuntime, provider: 'claude' | 'codex' | 'opencode'): ShadowDiffResult {
  // Legacy path — same calls as useRenderShadow.legacyItemsOf.
  const merged = selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null)
  const model = deriveFeedRenderModel({
    provider,
    entries: merged,
    semanticHistory: runtime.semantic.history,
    semanticTurn: runtime.semantic.currentTurn,
    streamPhase: runtime.streamPhase,
    streamPhasePendingToolName: runtime.streamPhasePendingToolName,
    streamPhasePendingToolUseId: runtime.streamPhasePendingToolUseId,
  })
  const legacy = model.items.map((item): LegacyItemLike => {
    switch (item.type) {
      case 'entry':
        return { type: 'entry', entryUuid: typeof item.entry.uuid === 'string' ? item.entry.uuid : null }
      case 'semantic-history':
      case 'semantic-current':
        return { type: item.type, turnId: item.turn.turnId }
      case 'work':
        return { type: 'work' }
      case 'empty':
        return { type: 'empty' }
    }
  })

  // New path — same slices as useRenderShadow.
  const slices: RuntimeLedgerSlices = {
    provider,
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }
  const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
  return diffShadowUnits(legacyUnits(legacy), ledgerUnits(ledger))
}

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

const liveTurn = (turnId: string, startedAt: number, text: string): SemanticLiveTurn => ({
  turnId,
  text,
  source: 'proxy',
  blocks: {
    0: { blockIndex: 0, kind: 'text', text, finalized: false },
  },
  blockOrder: [0],
  stopReason: null,
  usage: null,
  task: emptySemanticRuntime().currentTurn?.task ?? ({} as SemanticLiveTurn['task']),
  lookups: emptySemanticRuntime().currentTurn?.lookups ?? ({} as SemanticLiveTurn['lookups']),
  startedAt,
  endedAt: null,
})

describe('shadow parity: legacy renderer vs new pipeline (CI diff run)', () => {
  it('idle committed conversation', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'first'), assistantEntry('a1', 'msg_1', T + 100, 'answer')]
    rt.lastJsonlEntryAt = T + 100
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'row:a1'])
  })

  it('live streaming turn over committed rows, work indicator up', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt')]
    rt.lastJsonlEntryAt = T
    rt.semantic.currentTurn = liveTurn('turn_live', T + 200, 'streaming…')
    rt.streamPhase = 'responding'
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'turn:turn_live', 'work'])
  })

  it('claude whole-turn suppression: committed assistant row owns its archived live turn', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt'), assistantEntry('a1', 'turn_done', T + 100, 'final answer')]
    rt.lastJsonlEntryAt = T + 100
    // The archived live copy of the SAME turn (msg id == turnId for claude).
    rt.semantic.history = [{ ...liveTurn('turn_done', T + 50, 'final answer'), endedAt: T + 90 }]
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'row:a1'])
  })

  it('empty session shows the empty row on both sides', () => {
    const rt = emptyRuntime()
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['empty'])
  })

  it('orphaned stuck tool ghost paints on both sides', () => {
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
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'row:a1', 'row:g-turn_g-0'])
  })

  it('sidecar-shaped orphan ghost is hidden on both sides', () => {
    const rt = emptyRuntime()
    rt.entries = [userEntry('u1', T, 'prompt'), assistantEntry('a1', 'msg_1', T + 100, 'done')]
    rt.lastJsonlEntryAt = T + 100
    rt.ghosts = new Map([
      [
        'g-side-0',
        {
          uuid: 'g-side-0',
          type: 'assistant',
          timestamp: iso(T + 900),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Sounds good!' }] },
          _atp: { turnId: 'turn_side', blockIndex: 0, orphanedAt: T + 950, updatedAt: T + 900 },
        } as never,
      ],
    ])
    const result = runParity(rt, 'claude')
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'row:a1'])
  })

  it('KNOWN FIX (#239 class): buried optimistic prompt — legacy paints it above history, new pipeline orders chronologically', () => {
    const rt = emptyRuntime()
    rt.entries = [
      userEntry('u1', T, 'first prompt'),
      // Optimistic row embedded in entries by the submit path, AFTER a
      // stale semantic-history turn exists.
      userEntry('optimistic-codex-user:9', T + 300, 'second prompt'),
    ]
    rt.lastJsonlEntryAt = T
    rt.semantic.history = [{ ...liveTurn('turn_hist', T + 100, 'uncommitted answer'), endedAt: T + 150 }]
    rt.streamPhase = 'submitting'
    const result = runParity(rt, 'claude')
    // Both sides paint the same SET of things…
    expect(result.divergences.filter(d => d.class !== 'order-mismatch')).toEqual([])
    // …and the new pipeline's order is the D4 chronological merge:
    // history (ended T+150) BEFORE the T+300 prompt, work last. If legacy
    // agrees, the divergence list is empty and this fixture simply pins
    // parity; if it disagrees, the ONLY acceptable diff is order — the
    // exact #239 bug class the rewrite exists to fix.
    expect(result.next).toEqual(['row:u1', 'turn:turn_hist', 'row:optimistic-codex-user:9', 'work'])
  })
})
