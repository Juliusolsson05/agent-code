import { describe, expect, it } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import type { TransportGapRecord } from '@shared/types/session'
import { createLedgerInputAdapter, type RuntimeLedgerSlices } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { ledgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { transportGapSentence } from '@renderer/features/feed/lib/transportGapText'
import { emptyRuntime, mergeTransportGaps, type SessionRuntime } from '@renderer/session-runtime/state'
import { TRANSPORT_GAPS_PER_CONVERSATION } from '@shared/types/session'
import { chunk, messageStart, mountClaudePane, request, thinkingDelta, thinkingStart } from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'

// #1381, option B (OWNER-APPROVED, B6 proxy 2026-09-27): when the proxy events
// transport loses a span, the feed shows a DURABLE row saying so — placed where
// the loss began among the conversation's rows, kept after later turns, and
// back when the feed is rebuilt from its history chunk. "Data loss is never
// hidden."
//
// Drives the REAL Claude proxy adapter into the renderer's fold (the same
// drivers the #963 sleep tests use), and the REAL ledger input adapter,
// ownership ledger and view bridge Feed renders from. Frame content is
// synthetic in the recorded shape; entry shapes are the committed Claude ones
// the ledger tests use.

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const userEntry = (uuid: string, ms: number, text: string) =>
  ({ uuid, type: 'user', timestamp: iso(ms), permissionMode: 'default', message: { role: 'user', content: text } }) as unknown as Entry
const assistantEntry = (uuid: string, msgId: string, ms: number, text: string) =>
  ({ uuid, type: 'assistant', timestamp: iso(ms), message: { id: msgId, role: 'assistant', content: text } }) as unknown as Entry

const GAP: TransportGapRecord = { id: 'gap-1', since: T + 10_000, until: T + 40_000, lostGenerations: 2 }

function feedItems(runtime: SessionRuntime) {
  const slices: RuntimeLedgerSlices = {
    provider: 'claude',
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    transportGaps: runtime.transportGaps,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }
  const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
  return ledgerToFeedItems(ledger, ledgerFeedContextFromRuntime(runtime, 'claude')).items
}

const shape = (runtime: SessionRuntime): string[] => feedItems(runtime).map(item =>
  item.type === 'entry' ? `entry:${String(item.entry.uuid)}` : item.type)

describe('a lost proxy span in the Claude feed (#1381)', () => {
  it('seals the turn that was streaming across it, and the fold keeps why', () => {
    const pane = mountClaudePane()
    request(pane.adapter, 1)
    chunk(pane.adapter, 1, [messageStart('msg_cut'), thinkingStart(0), thinkingDelta(0)])
    pane.adapter.sealFlowsForTransportGap()
    // Post-gap frames of the same response are dropped, not stitched on.
    chunk(pane.adapter, 1, [thinkingDelta(0)])

    expect(pane.reducer.stops).toEqual([expect.objectContaining({ interruption: 'transport-gap' })])
    const turn = pane.reducer.pane.semantic.currentTurn ?? pane.reducer.pane.semantic.history.at(-1)
    expect(turn?.interruption).toBe('transport-gap')
    expect(pane.reducer.pane.phase.streamPhase).toBe('idle')
  })

  it('paints one durable row where the loss began, among the conversation', () => {
    const runtime: SessionRuntime = {
      ...emptyRuntime(),
      entries: [userEntry('u1', T, 'build it'), assistantEntry('a1', 'msg_a1', T + 60_000, 'done')],
      transportGaps: [GAP],
    }
    expect(shape(runtime)).toEqual(['entry:u1', 'transport-gap', 'entry:a1'])
    const row = feedItems(runtime).find(item => item.type === 'transport-gap')
    expect(row).toMatchObject({ gap: GAP })
  })

  it('stays after later turns complete', () => {
    const runtime: SessionRuntime = {
      ...emptyRuntime(),
      entries: [
        userEntry('u1', T, 'build it'),
        assistantEntry('a1', 'msg_a1', T + 60_000, 'done'),
        userEntry('u2', T + 120_000, 'now test it'),
        assistantEntry('a2', 'msg_a2', T + 180_000, 'tested'),
      ],
      transportGaps: [GAP],
    }
    expect(shape(runtime)).toEqual(['entry:u1', 'transport-gap', 'entry:a1', 'entry:u2', 'entry:a2'])
  })

  it('comes back when the feed is rebuilt from its history chunk, once', () => {
    // Live: the event delivered the record. Rebuild (a window reload): the runtime
    // starts empty and the initial history chunk carries what main held.
    const live = mergeTransportGaps(emptyRuntime().transportGaps, [GAP])
    const rebuilt = mergeTransportGaps(emptyRuntime().transportGaps, [GAP])
    expect(rebuilt).toEqual([GAP])
    // The same record arriving by both paths is one row, not two.
    expect(mergeTransportGaps(live, [GAP])).toBe(live)
    const both = mergeTransportGaps(live, [GAP, { ...GAP, id: 'gap-2', since: T + 90_000, until: T + 95_000 }])
    expect(both.map(gap => gap.id)).toEqual(['gap-1', 'gap-2'])
  })

  // #1442 review b: main keeps the newest 50 per conversation, so the live feed must too, or an
  // open pane and the same pane after a reload paint different rows.
  it('keeps the newest gaps up to the same cap as main, live and rebuilt alike', () => {
    let live = emptyRuntime().transportGaps
    for (let i = 1; i <= TRANSPORT_GAPS_PER_CONVERSATION + 3; i += 1) {
      live = mergeTransportGaps(live, [{ id: `gap-${i}`, since: T + i * 1_000, until: T + i * 1_000 + 500, lostGenerations: 1 }])
    }
    expect(live).toHaveLength(TRANSPORT_GAPS_PER_CONVERSATION)
    expect(live[0]!.id).toBe('gap-4')
    expect(live.at(-1)!.id).toBe(`gap-${TRANSPORT_GAPS_PER_CONVERSATION + 3}`)
  })

  // #1442 review c: the pane keeps ONE adapter across renders (useLedgerFeedItems), and its notice
  // cache is keyed on slice identities. A gap that arrives while nothing else changes (the sealed
  // turn was the conversation's last) must still paint at once, not at the next entry or reload.
  it('paints a gap that arrives alone on a pane whose adapter is reused', () => {
    const adapter = createLedgerInputAdapter()
    const ledger = createSessionLedger()
    const runtime: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'hi')] }
    const slicesOf = (r: SessionRuntime): RuntimeLedgerSlices => ({
      provider: 'claude', sessionId: 's1', entries: r.entries,
      semanticCurrent: r.semantic.currentTurn, semanticHistory: r.semantic.history,
      transportGaps: r.transportGaps, ghosts: r.ghosts, streamPhase: r.streamPhase, lastJsonlEntryAtMs: r.lastJsonlEntryAt,
    })
    const paint = (r: SessionRuntime) => ledgerToFeedItems(ledger(adapter(slicesOf(r)).input), ledgerFeedContextFromRuntime(r, 'claude')).items
    expect(paint(runtime).some(item => item.type === 'transport-gap')).toBe(false)
    // Only the gaps slice moves; entries and semantic state keep their identity.
    const withGap: SessionRuntime = { ...runtime, transportGaps: mergeTransportGaps(runtime.transportGaps, [GAP]) }
    expect(paint(withGap).some(item => item.type === 'transport-gap')).toBe(true)
  })

  it('a runtime with no gaps paints no row', () => {
    const runtime: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'hi')] }
    expect(shape(runtime)).toEqual(['entry:u1'])
  })
})

describe('transportGapSentence', () => {
  // Local-time Date parts, so the expectation holds in any time zone.
  const at = (h: number, m: number, s: number) => new Date(2026, 8, 27, h, m, s).getTime()

  it('says the window the lost output was written in', () => {
    expect(transportGapSentence({ since: at(14, 2, 11), until: at(14, 3, 40) }))
      .toBe('Part of this response was not captured (14:02:11–14:03:40)')
  })

  it('says only the end when the loss came before the first poll', () => {
    expect(transportGapSentence({ since: null, until: at(9, 5, 0) }))
      .toBe('Part of this response was not captured (before 09:05:00)')
  })
})
