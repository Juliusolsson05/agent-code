import { describe, expect, it } from 'vitest'

import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// FIXTURE: subagent sidechain leak (issue #477) — end to end through the
// adapter. Shape lifted from a real session recording of a subagent fan-out:
// the parent transcript interleaves the subagent's OWN turns (isSidechain:
// true) with the parent's. Only the parent's rows must paint; the subagent's
// activity renders inside the Task card (watcher channel), not the main feed.
// Proves the isSidechain field flows adapter → collector → ledger, not just
// that the collector honors it in isolation.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('fixture: subagent sidechain leak (#477, full pipeline)', () => {
  it('paints the parent turns and rejects the interleaved subagent turns', () => {
    const entries = [
      // Parent user prompt.
      {
        uuid: 'p-user',
        type: 'user',
        timestamp: iso(T),
        permissionMode: 'default',
        message: { role: 'user', content: 'spawn a subagent to explore' },
      },
      // Parent assistant turn that spawns the Agent.
      {
        uuid: 'p-asst',
        type: 'assistant',
        timestamp: iso(T + 100),
        message: {
          id: 'msg_parent',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }],
        },
      },
      // SUBAGENT's own interleaved turns (isSidechain:true) — the leak.
      {
        uuid: 'sc-1',
        type: 'assistant',
        isSidechain: true,
        timestamp: iso(T + 200),
        message: {
          id: 'msg_sc1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read the key files.' },
            { type: 'tool_use', id: 'toolu_child_read', name: 'Read', input: { file_path: '/a.ts' } },
          ],
        },
      },
      {
        uuid: 'sc-2',
        type: 'user',
        isSidechain: true,
        timestamp: iso(T + 300),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_child_read', content: '…' }] },
      },
    ]
    const slices: RuntimeLedgerSlices = {
      provider: 'claude',
      sessionId: 's1',
      entries,
      semanticCurrent: null,
      semanticHistory: [],
      ghosts: new Map(),
      streamPhase: 'idle',
      lastJsonlEntryAtMs: T + 300,
    }
    const bundle = createLedgerInputAdapter()(slices)
    const ledger = createSessionLedger()(bundle.input)
    const paintedIds = ledger.rows.map(r => r.candidate.id)

    // Only the parent's rows paint; neither sidechain turn does.
    expect(paintedIds).toEqual(['entry:p-user', 'entry:p-asst'])
    expect(paintedIds).not.toContain('entry:sc-1')
    expect(paintedIds).not.toContain('entry:sc-2')

    // The rejection is on the record with the right reason. Committed-collector
    // rejections ride the adapter's collectorDecisions (the ledger's own
    // `decisions` cover only what REACHED it) — both halves make the
    // ledger=paint=debug story whole.
    const scDecision = bundle.collectorDecisions.find(d => d.candidateId === 'entry:sc-1')
    expect(scDecision?.selected).toBe(false)
    expect(scDecision?.reason).toBe('sidechain-filtered')
  })
})
