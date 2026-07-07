import { describe, expect, it } from 'vitest'

import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import { collectSemanticCandidates } from '@renderer/rendering/observations/semantic'
import { createSessionLedger } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// FIXTURE: opencode-interleave-87f0eeef — concurrent assistant messages on
// one SSE stream.
//
// What this protects: the 2026-07-06 bundle 87f0eeef ("another glitch when
// writing… agent output seems to break stuff?"): OpenCode streamed multiple
// assistant messages CONCURRENTLY — turn ids alternating A,B,A,B… 30
// turn_starteds across 4 messageIDs — and the legacy live-slot replacement
// churned a 27↔29 visible-row render spasm. The remedy stack: strict live
// ownership (only one current turn; the concurrent message's content
// arrives via the committed ASSEMBLED message instead) + exact-text
// suppression so the bridge copy and the committed copy never both paint.
//
// The invariant this fixture pins: interleaved content renders EXACTLY
// ONCE, in chronological order, with every suppression explained. No
// duplicate, no spasm-shaped add/remove churn, no silent loss of the
// message that never commits.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('fixture: opencode-interleave-87f0eeef', () => {
  // Message B completed AND committed (assembled {info, parts} → a real
  // committed row with message id + text). Its semantic bridge copy is
  // still in history — the exact double-paint hazard.
  const committedEntries = [
    {
      uuid: 'msg_B',
      type: 'assistant',
      timestamp: iso(T + 300),
      message: { id: 'msg_B', role: 'assistant', content: 'answer from message B' },
    },
  ]
  // History: B's bridge copy (finalized, same text) and A — the concurrent
  // message that completed but NEVER commits (its committed row is lost to
  // the interleave). A must survive as the only copy.
  const history = [
    {
      turnId: 'msg_B',
      source: 'opencode-sse',
      startedAtMs: T + 100,
      endedAtMs: T + 300,
      blocks: [{ blockIndex: 0, kind: 'text', text: 'answer from message B', finalized: true }],
    },
    {
      turnId: 'msg_A',
      source: 'opencode-sse',
      startedAtMs: T + 50,
      endedAtMs: T + 400,
      blocks: [
        { blockIndex: 0, kind: 'reasoning', text: 'thinking about it', finalized: true },
        { blockIndex: 1, kind: 'text', text: 'answer from message A', finalized: true },
      ],
    },
  ]

  function run() {
    const committed = collectCommittedCandidates(committedEntries, 'opencode', 's1')
    const semantic = collectSemanticCandidates(null, history, 'opencode', 's1')
    return createSessionLedger()({
      provider: 'opencode',
      committed: committed.candidates,
      live: semantic.candidates,
      statics: [],
      unknowns: [],
    })
  }

  it('interleaved content renders exactly once — committed B wins its slot, bridge B suppressed with reason', () => {
    const ledger = run()
    const ids = ledger.rows.map(r => r.candidate.id)
    // B appears once (the committed row), its bridge copy is out.
    expect(ids).toContain('entry:msg_B')
    expect(ids).not.toContain('sem:msg_B:0')
    const bridgeB = ledger.decisions.find(d => d.candidateId === 'sem:msg_B:0')
    expect(bridgeB).toMatchObject({ selected: false, reason: 'committed-text-owned' })
  })

  it('the never-committed concurrent message A stays fully visible — reasoning and text', () => {
    const ledger = run()
    const ids = ledger.rows.map(r => r.candidate.id)
    expect(ids).toContain('sem:msg_A:0')
    expect(ids).toContain('sem:msg_A:1')
  })

  it('opencode policy is unit-level: B committing must NOT whole-turn-suppress anything of A', () => {
    // The drift-report hazard: opencode committed rows DO carry message.id,
    // so an id-presence heuristic would enable claude-style whole-turn
    // suppression and eat A's content. The policy bit says no.
    const ledger = run()
    expect(
      ledger.decisions
        .filter(d => d.candidateId.startsWith('sem:msg_A'))
        .every(d => d.selected),
    ).toBe(true)
  })

  it('order is chronological by turn end, not arrival: A (ended t+400) paints after committed B (t+300)', () => {
    const ledger = run()
    const ids = ledger.rows.map(r => r.candidate.id)
    expect(ids.indexOf('entry:msg_B')).toBeLessThan(ids.indexOf('sem:msg_A:0'))
  })
})
