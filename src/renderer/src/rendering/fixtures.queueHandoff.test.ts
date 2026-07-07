import { describe, expect, it } from 'vitest'

import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// FIXTURE: queue → optimistic → committed handoff race (#172 comment 6).
//
// D1: the queue is a COMPOSER lane, not feed rows — a queued message never
// reaches the adapter at all, so it cannot occupy a feed position it would
// later have to vacate (the legacy bug class: queued text painted as a
// pseudo-row, then jumped when dispatch re-minted it).
//
// The race this pins: dispatch mints the optimistic row and the committed
// twin lands one tick later. The invariant is POSITIONAL — the committed
// row must take exactly the slot the optimistic row held (chronological
// merge on submit wall-clock vs producer timestamp), never re-bury below
// stale history and never duplicate. Ticks simulate the real runtime
// sequence: reducers replace the arrays they touch, everything else keeps
// its reference.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const prompt1 = {
  uuid: 'u1',
  type: 'user',
  timestamp: iso(T),
  permissionMode: 'default',
  message: { role: 'user', content: 'first prompt' },
}
const answer1 = {
  uuid: 'a1',
  type: 'assistant',
  timestamp: iso(T + 100),
  message: { id: 'msg_1', role: 'assistant', content: 'first answer' },
}

const base: Omit<RuntimeLedgerSlices, 'entries' | 'streamPhase'> = {
  provider: 'claude',
  sessionId: 's1',
  semanticCurrent: null,
  semanticHistory: [],
  ghosts: new Map(),
  lastJsonlEntryAtMs: T + 100,
}

describe('fixture: queue-handoff race (queued → optimistic → committed)', () => {
  it('holds one position across the whole handoff, no re-bury, no duplicate', () => {
    const adapter = createLedgerInputAdapter()
    const ledger = createSessionLedger()

    // Tick 1 — turn done, a message SITS IN THE QUEUE. The queue is a
    // composer lane (D1): the adapter never sees it, so the feed shows
    // exactly the two committed rows. This absence IS the assertion.
    const tick1 = ledger(
      adapter({ ...base, entries: [prompt1, answer1], streamPhase: 'idle' }).input,
    )
    expect(tick1.rows.map(r => r.candidate.id)).toEqual(['entry:u1', 'entry:a1'])

    // Tick 2 — dispatch: the runtime appends the optimistic row to
    // entries (submit wall-clock T+500) and enters 'submitting'. The
    // optimistic row must paint AFTER all committed content — tail, not
    // buried — plus the work indicator.
    const optimisticRow = {
      uuid: 'optimistic-codex-user:777',
      type: 'user',
      timestamp: iso(T + 500),
      message: { role: 'user', content: 'queued follow-up' },
    }
    const tick2 = ledger(
      adapter({ ...base, entries: [prompt1, answer1, optimisticRow], streamPhase: 'submitting' })
        .input,
    )
    expect(tick2.rows.map(r => r.candidate.id)).toEqual([
      'entry:u1',
      'entry:a1',
      'optimistic:optimistic-codex-user:777',
      'work',
    ])
    const optimisticIndex = tick2.rows.findIndex(
      r => r.candidate.id === 'optimistic:optimistic-codex-user:777',
    )

    // Tick 3 — the committed twin lands (producer timestamp T+600) and
    // the runtime drops the optimistic row from entries. The committed
    // row must occupy EXACTLY the position its optimistic stand-in held.
    const committedTwin = {
      uuid: 'u2',
      type: 'user',
      timestamp: iso(T + 600),
      permissionMode: 'default',
      message: { role: 'user', content: 'queued follow-up' },
    }
    const tick3 = ledger(
      adapter({ ...base, entries: [prompt1, answer1, committedTwin], streamPhase: 'submitting' })
        .input,
    )
    const ids3 = tick3.rows.map(r => r.candidate.id)
    expect(ids3).toEqual(['entry:u1', 'entry:a1', 'entry:u2', 'work'])
    expect(ids3.indexOf('entry:u2')).toBe(optimisticIndex)
    // No duplicate: the optimistic id is gone, not coexisting.
    expect(ids3).not.toContain('optimistic:optimistic-codex-user:777')
  })

  it('handoff overlap tick (both rows present) suppresses the optimistic copy', () => {
    // The runtime's optimistic-removal and JSONL-append are separate
    // reducers — one tick can legitimately contain BOTH rows. The
    // ownership pass must pick the committed twin and reject the
    // optimistic copy by normalized text, not paint both.
    const adapter = createLedgerInputAdapter()
    const committedTwin = {
      uuid: 'u2',
      type: 'user',
      timestamp: iso(T + 600),
      permissionMode: 'default',
      message: { role: 'user', content: 'queued  follow-up ' }, // whitespace differs — normalized match
    }
    const optimisticRow = {
      uuid: 'optimistic-codex-user:777',
      type: 'user',
      timestamp: iso(T + 500),
      message: { role: 'user', content: 'queued follow-up' },
    }
    const { input } = adapter({
      ...base,
      entries: [prompt1, answer1, committedTwin, optimisticRow],
      streamPhase: 'submitting',
    })
    const ledger = createSessionLedger()(input)
    const ids = ledger.rows.map(r => r.candidate.id)
    expect(ids).toEqual(['entry:u1', 'entry:a1', 'entry:u2', 'work'])
    const rejected = ledger.decisions.find(
      d => d.candidateId === 'optimistic:optimistic-codex-user:777',
    )
    expect(rejected?.selected).toBe(false)
  })
})
