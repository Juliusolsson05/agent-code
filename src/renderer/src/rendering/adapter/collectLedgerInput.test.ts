import { describe, expect, it } from 'vitest'

import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import type {
  RuntimeLedgerSlices,
  RuntimeSemanticTurn,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { GhostLike } from '@renderer/rendering/observations/ghosts'

// ---------------------------------------------------------------------------
// The runtime → collector adapter (the shadow seam).
//
// These tests feed RUNTIME-shaped state — record-keyed semantic blocks,
// optimistic rows embedded in `entries`, ghost `_atp` metadata — and assert
// the adapter's two contracts:
//   1. translation: every runtime quirk is absorbed (partitioned optimistic
//      rows, blockOrder → ordered arrays, ghost facts extracted)
//   2. plane-level reference stability: a change in ONE runtime slice must
//      not rebuild any other plane's arrays, so the ledger's identity cache
//      composes end-to-end (D11).
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const semanticCurrent: RuntimeSemanticTurn = {
  turnId: 'turn_live',
  source: 'proxy',
  // blockOrder deliberately non-contiguous and out of record-insertion
  // order — deltas arrive interleaved; the adapter must emit blockOrder's
  // order, not Object.keys order.
  blocks: {
    2: { blockIndex: 2, kind: 'text', text: 'streaming answer', finalized: false },
    0: { blockIndex: 0, kind: 'thinking', text: 'hmm', finalized: true },
  },
  blockOrder: [0, 2],
  startedAt: T + 500,
  endedAt: null,
}

const stuckToolGhost: GhostLike = {
  uuid: 'g-turn_ghost-0',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_g', name: 'Bash', input: {} }],
  },
  _atp: { turnId: 'turn_ghost', blockIndex: 0, orphanedAt: T + 950, updatedAt: T + 900 },
}
const supersededGhost: GhostLike = {
  uuid: 'g-turn_done-0',
  message: { role: 'assistant', content: [{ type: 'text', text: 'already committed long ago,'.repeat(20) }] },
  _atp: { turnId: 'turn_done', blockIndex: 0, supersededBy: 'a1', updatedAt: T + 50 },
}

function baseSlices(): RuntimeLedgerSlices {
  return {
    provider: 'claude',
    sessionId: 's1',
    entries: [
      {
        uuid: 'u1',
        type: 'user',
        timestamp: iso(T),
        permissionMode: 'default',
        message: { role: 'user', content: 'do the thing' },
      },
      // Optimistic row exactly as the submit path embeds it in entries.
      {
        uuid: 'optimistic-codex-user:12345',
        type: 'user',
        timestamp: iso(T + 300),
        message: { role: 'user', content: 'follow-up prompt' },
      },
    ],
    semanticCurrent,
    semanticHistory: [],
    ghosts: new Map([
      ['g-turn_ghost-0', stuckToolGhost],
      ['g-turn_done-0', supersededGhost],
    ]),
    streamPhase: 'responding',
    lastJsonlEntryAtMs: T,
  }
}

describe('runtime → collector adapter', () => {
  it('translates runtime shapes end-to-end through the ledger', () => {
    const adapter = createLedgerInputAdapter()
    const { input, collectorDecisions } = adapter(baseSlices())
    const ledger = createSessionLedger()(input)
    const ids = ledger.rows.map(r => r.candidate.id)

    // Committed prompt first; live turn blocks in blockOrder order; the
    // optimistic follow-up between them chronologically (T+300 < T+500);
    // ghost stuck tool paints (orphaned, unsuperseded, newer than tail,
    // tool_use-exempt from shape rule); work indicator last.
    expect(ids).toEqual([
      'entry:u1',
      'optimistic:optimistic-codex-user:12345',
      'sem:turn_live:0',
      'sem:turn_live:2',
      'ghost:g-turn_ghost-0',
      'work',
    ])

    // The optimistic row must NOT have entered the committed plane.
    expect(input.committed.map(c => c.id)).toEqual(['entry:u1'])

    // Superseded ghost rejected by rule 1 — visible in the decision trail.
    const superseded = ledger.decisions.find(d => d.candidateId === 'ghost:g-turn_done-0')
    expect(superseded?.selected).toBe(false)
    expect(superseded?.reason).toBe('ghost-superseded')

    // Collector-time decisions ride along for the debug story.
    expect(Array.isArray(collectorDecisions)).toBe(true)
  })

  it('keeps untouched planes reference-stable when one slice changes', () => {
    const adapter = createLedgerInputAdapter()
    const first = adapter(baseSlices())

    // Same references in, same bundle OBJECT out.
    const slices = baseSlices()
    const a = adapter(slices)
    const b = adapter({ ...slices })
    expect(b).toBe(a)

    // Now only the semantic current turn advances (new object, as the
    // reducer would produce). Committed / ghost / statics arrays must
    // survive BY REFERENCE.
    const advanced: RuntimeLedgerSlices = {
      ...slices,
      semanticCurrent: {
        ...semanticCurrent,
        blocks: {
          ...semanticCurrent.blocks,
          2: { blockIndex: 2, kind: 'text', text: 'streaming answer grew', finalized: false },
        },
      },
    }
    const c = adapter(advanced)
    expect(c).not.toBe(a)
    expect(c.input.committed).toBe(a.input.committed)
    expect(c.input.ghosts).toBe(a.input.ghosts)
    expect(c.input.statics).toBe(a.input.statics)
    expect(c.input.live).not.toBe(a.input.live)
    void first
  })

  it('records unknown entry types and block kinds as sightings without affecting rows', () => {
    const adapter = createLedgerInputAdapter()
    const slices = baseSlices()
    const weird: RuntimeLedgerSlices = {
      ...slices,
      entries: [
        ...slices.entries,
        // A row type the collector does not know — rejected AND sighted.
        { uuid: 'x1', type: 'billing_notice', timestamp: iso(T + 800) } as never,
      ],
      semanticCurrent: {
        ...semanticCurrent,
        blocks: {
          ...semanticCurrent.blocks,
          // A block kind outside every known set — renders via the text
          // fallback but must surface as an unknown sighting.
          7: { blockIndex: 7, kind: 'hologram_call', text: 'beep', finalized: true },
        },
        blockOrder: [0, 2, 7],
      },
    }
    const { input } = adapter(weird)
    const types = input.unknowns.map(u => `${u.sourcePlane}:${u.eventType}`)
    expect(types).toContain('committed:billing_notice')
    expect(types).toContain('semantic:hologram_call')
    // Rows unaffected: the unknown entry stays hidden, the unknown block
    // still paints (fallback), and nothing crashes.
    expect(input.committed.some(c => c.id === 'entry:x1')).toBe(false)

    // Stability: same slices again — the unknowns ARRAY keeps identity
    // even though the registry re-sighted (seenCount bump is telemetry,
    // not paint).
    const again = adapter({ ...weird })
    expect(again.input.unknowns).toBe(input.unknowns)
  })

  it('gates opencode ghosts out of the render plane entirely', () => {
    const adapter = createLedgerInputAdapter()
    const slices = baseSlices()
    const oc: RuntimeLedgerSlices = { ...slices, provider: 'opencode' }
    const { input } = adapter(oc)
    expect(input.ghosts).toEqual([])
  })
})
