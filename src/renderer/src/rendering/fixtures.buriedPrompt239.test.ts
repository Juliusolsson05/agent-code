import { describe, expect, it } from 'vitest'

import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import {
  collectLifecycleCandidates,
  collectOptimisticCandidates,
} from '@renderer/rendering/observations/local'
import { collectSemanticCandidates } from '@renderer/rendering/observations/semantic'
import { createSessionLedger } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// FIXTURE: buried-prompt-239 — the first end-to-end pipeline run.
//
// What this protects: issue #239 / the "STILL NOT SHOWING FUCKING USER
// PROMPT" bundle. The legacy renderer painted fixed JSX planes (entries →
// semantic history → current → work), so a submitted prompt EXISTED in the
// DOM but sat above a stack of stale semantic-history rows — visually
// missing. #172 comment 5 reopened the umbrella issue over exactly this
// shape and rewrote the acceptance bar: one ordered list, tests assert
// FINAL ORDER, not row existence.
//
// Shape (times relative, producer clock):
//   t+000  committed user prompt #1
//   t+100  semantic history turn (assistant answer, ended t+150, committed
//          row never arrived — bridge content, must stay visible)
//   t+200  optimistic user prompt #2 (submitted, no committed row yet)
//   work   active (streamPhase non-idle)
//
// Expected order: prompt#1, history blocks, prompt#2 (optimistic), work.
// The old planes would have painted prompt#2 BEFORE the history rows.
// Then: the committed row for prompt#2 lands → optimistic candidate is
// rejected with 'optimistic-owned-by-committed' and the committed twin
// takes the exact same position (the queue/optimistic handoff invariant —
// no re-burying, #172 comment 6).
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('fixture: buried-prompt-239 (end-to-end collectors → ledger → rows)', () => {
  const committedEntries = [
    {
      uuid: 'p1',
      type: 'user',
      timestamp: iso(T),
      permissionMode: 'default',
      message: { role: 'user', content: 'first prompt' },
    },
  ]
  const history = [
    {
      turnId: 'resp_hist',
      source: 'proxy',
      startedAtMs: T + 100,
      endedAtMs: T + 150,
      blocks: [{ blockIndex: 0, kind: 'text', text: 'stale but uncommitted answer', finalized: true }],
    },
  ]
  const optimistic = [{ uuid: 'optimistic-codex-user:1', text: 'second prompt', submittedAtMs: T + 200 }]

  function runPipeline(entries: typeof committedEntries) {
    const committed = collectCommittedCandidates(entries, 'codex', 's1')
    const semantic = collectSemanticCandidates(null, history, 'codex', 's1')
    const opt = collectOptimisticCandidates(optimistic, 'codex', 's1')
    const lifecycle = collectLifecycleCandidates({
      provider: 'codex',
      sessionId: 's1',
      streamPhaseIdle: false,
      hasContentCandidates: true,
    })
    return createSessionLedger()({
      provider: 'codex',
      committed: committed.candidates,
      live: [...semantic.candidates, ...opt],
      statics: lifecycle,
      unknowns: [],
    })
  }

  it('the prompt is the visual tail of content — history sorts BEFORE it, work last', () => {
    const ledger = runPipeline(committedEntries)
    expect(ledger.rows.map(r => r.candidate.id)).toEqual([
      'entry:p1',
      'sem:resp_hist:0',
      'optimistic:optimistic-codex-user:1',
      'work',
    ])
  })

  it('uncommitted history is REORDERED, never suppressed — it may be the only copy (D3 discriminator)', () => {
    const ledger = runPipeline(committedEntries)
    const hist = ledger.decisions.find(d => d.candidateId === 'sem:resp_hist:0')
    expect(hist?.selected).toBe(true)
  })

  it('handoff: committed twin lands → optimistic rejected with reason, position preserved (no re-bury)', () => {
    const withCommittedTwin = [
      ...committedEntries,
      {
        uuid: 'p2',
        type: 'user',
        timestamp: iso(T + 200),
        permissionMode: 'default',
        message: { role: 'user', content: 'second  prompt' }, // CRLF/whitespace variance — normalized match
      },
    ]
    const ledger = runPipeline(withCommittedTwin)
    expect(ledger.rows.map(r => r.candidate.id)).toEqual([
      'entry:p1',
      'sem:resp_hist:0',
      'entry:p2',
      'work',
    ])
    const opt = ledger.decisions.find(d => d.candidateId === 'optimistic:optimistic-codex-user:1')
    expect(opt).toMatchObject({ selected: false, reason: 'optimistic-owned-by-committed' })
  })
})
