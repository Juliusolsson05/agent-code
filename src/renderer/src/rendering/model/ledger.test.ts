import { describe, expect, it } from 'vitest'

import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { LedgerInput } from '@renderer/rendering/model/ledger'
import type { RenderCandidate } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// The first ten load-bearing tests (plan §4). Each encodes a production
// incident — the test name carries the issue/bundle it guards. Times are
// explicit constants (never Date.now(): resume comparisons live in producer
// wall-clock space, and drifting clocks in tests hid ordering bugs before).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000

let seq = 0
function cand(partial: Partial<RenderCandidate> & Pick<RenderCandidate, 'id' | 'owner' | 'contentKind'>): RenderCandidate {
  return {
    provider: 'codex',
    sourcePlane: partial.owner === 'committed' ? 'committed' : 'semantic',
    sessionId: 's1',
    timestampMs: null,
    sequence: seq++,
    ...partial,
  }
}

function run(input: Partial<LedgerInput>): ReturnType<ReturnType<typeof createSessionLedger>> {
  const ledger = createSessionLedger()
  return ledger({
    provider: 'codex',
    committed: [],
    live: [],
    statics: [],
    unknowns: [],
    ...input,
  })
}

const rowIds = (l: { rows: readonly { candidate: { id: string } }[] }) =>
  l.rows.map(r => r.candidate.id)

describe('ledger: ordering law (D4)', () => {
  it('committed user + assistant produce two rows in timestamp order', () => {
    const l = run({
      committed: [
        cand({ id: 'a', owner: 'committed', contentKind: 'assistant-text', timestampMs: T0 + 10 }),
        cand({ id: 'u', owner: 'committed', contentKind: 'user-text', timestampMs: T0 }),
      ],
    })
    expect(rowIds(l)).toEqual(['u', 'a'])
  })

  it('#239: stale semantic history (ended BEFORE the prompt) sorts BEFORE the newer user prompt', () => {
    // The buried-prompt bundle shape: history turn ended at T0+100, user
    // prompt committed at T0+200. Legacy plane order painted history AFTER
    // the prompt; the law says chronology wins.
    const l = run({
      committed: [
        cand({ id: 'prompt', owner: 'committed', contentKind: 'user-text', timestampMs: T0 + 200 }),
      ],
      live: [
        cand({ id: 'hist', owner: 'semantic-history', contentKind: 'assistant-text', timestampMs: T0 + 100 }),
      ],
    })
    expect(rowIds(l)).toEqual(['hist', 'prompt'])
  })

  it('live semantic that STARTED after the prompt sorts after it; work is always last', () => {
    const l = run({
      committed: [
        cand({ id: 'prompt', owner: 'committed', contentKind: 'user-text', timestampMs: T0 }),
      ],
      live: [
        cand({ id: 'cur', owner: 'semantic-current', contentKind: 'assistant-text', timestampMs: T0 + 50 }),
      ],
      statics: [cand({ id: 'work', owner: 'work', contentKind: 'work' })],
    })
    expect(rowIds(l)).toEqual(['prompt', 'cur', 'work'])
  })

  it('null timestamps sort after timestamped content, stabilized by sequence — never as "now"', () => {
    const l = run({
      committed: [
        cand({ id: 'no-ts', owner: 'committed', contentKind: 'assistant-text', timestampMs: null }),
        cand({ id: 'ts', owner: 'committed', contentKind: 'user-text', timestampMs: T0 }),
      ],
    })
    expect(rowIds(l)).toEqual(['ts', 'no-ts'])
  })

  it('empty + work is a legal output (work is lifecycle, not text)', () => {
    const l = run({
      statics: [
        cand({ id: 'work', owner: 'work', contentKind: 'work' }),
        cand({ id: 'empty', owner: 'empty', contentKind: 'empty' }),
      ],
    })
    expect(rowIds(l)).toEqual(['empty', 'work'])
  })
})

describe('ledger: committed ownership (D2/D3/D10)', () => {
  it('#170: codex live text suppressed by committed EXACT text across the resp_*/rollout id split', () => {
    // Different ids on purpose — id-based suppression can never match; the
    // conservative text key is the only ownership proof.
    const l = run({
      committed: [
        cand({ id: 'c', owner: 'committed', contentKind: 'assistant-text', turnId: 'rollout-1', textKey: 'same answer', timestampMs: T0 }),
      ],
      live: [
        cand({ id: 'live', owner: 'semantic-current', contentKind: 'assistant-text', turnId: 'resp_abc', textKey: 'same answer', timestampMs: T0 + 1 }),
      ],
    })
    expect(rowIds(l)).toEqual(['c'])
    const d = l.decisions.find(x => x.candidateId === 'live')
    expect(d?.selected).toBe(false)
    expect(d?.reason).toBe('committed-text-owned')
  })

  it('claude: committed message.id whole-turn-suppresses the archived history bridge — codex does NOT', () => {
    const committed = [
      cand({ id: 'c', owner: 'committed', contentKind: 'assistant-text', provider: 'claude', messageId: 'msg_1', textKey: 'x', timestampMs: T0 }),
    ]
    const history = [
      cand({ id: 'hist', owner: 'semantic-history', contentKind: 'assistant-text', provider: 'claude', turnId: 'msg_1', textKey: 'different text', timestampMs: T0 - 1 }),
    ]
    const claude = run({ provider: 'claude', committed, live: history })
    expect(rowIds(claude)).toEqual(['c'])
    expect(claude.decisions.find(x => x.candidateId === 'hist')?.reason).toBe('claude-whole-turn-suppressed')

    // Same shape under codex policy: broad turn ids are SHARED across
    // response items (#165/#191) — whole-turn suppression would hide valid
    // live content, so the history row must survive.
    const codex = run({ provider: 'codex', committed, live: history })
    expect(rowIds(codex)).toEqual(['hist', 'c'])
  })

  it('dump invariant 10: committed tool-USE does not hide live tool OUTPUT; committed tool-RESULT does', () => {
    const liveOutput = cand({ id: 'out', owner: 'semantic-current', contentKind: 'tool-result', toolUseId: 'tu_1', timestampMs: T0 + 5 })
    const useOnly = run({
      committed: [cand({ id: 'use', owner: 'committed', contentKind: 'tool-use', toolUseId: 'tu_1', timestampMs: T0 })],
      live: [liveOutput],
    })
    expect(rowIds(useOnly)).toContain('out')

    const withResult = run({
      committed: [
        cand({ id: 'use', owner: 'committed', contentKind: 'tool-use', toolUseId: 'tu_1', timestampMs: T0 }),
        cand({ id: 'res', owner: 'committed', contentKind: 'tool-result', toolUseId: 'tu_1', timestampMs: T0 + 10 }),
      ],
      live: [liveOutput],
    })
    expect(rowIds(withResult)).not.toContain('out')
    expect(withResult.decisions.find(x => x.candidateId === 'out')?.reason).toBe('committed-tool-result-owned')
  })

  it('every candidate has a decision; rejected candidates keep reason + evidence (D5, #344)', () => {
    const l = run({
      committed: [cand({ id: 'c', owner: 'committed', contentKind: 'assistant-text', textKey: 't', timestampMs: T0 })],
      live: [cand({ id: 'dup', owner: 'semantic-history', contentKind: 'assistant-text', textKey: 't', timestampMs: T0 })],
    })
    expect(l.decisions).toHaveLength(2)
    const rejected = l.decisions.find(d => !d.selected)
    expect(rejected?.reason).toBe('committed-text-owned')
    expect(rejected?.evidence.length).toBeGreaterThan(0)
  })
})

describe('ledger: identity stability (D11 — load-bearing, not an optimization)', () => {
  it('unchanged inputs return the previous ledger BY REFERENCE', () => {
    const ledger = createSessionLedger()
    const input: LedgerInput = {
      provider: 'codex',
      committed: [cand({ id: 'c', owner: 'committed', contentKind: 'user-text', timestampMs: T0 })],
      live: [],
      statics: [],
      unknowns: [],
    }
    const first = ledger(input)
    const second = ledger({ ...input })
    expect(second).toBe(first)

    // A changed array reference means a real change — new object expected.
    const third = ledger({ ...input, committed: [...input.committed] })
    expect(third).not.toBe(first)
  })
})
