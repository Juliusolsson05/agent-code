import { describe, expect, it } from 'vitest'

import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import { collectLifecycleCandidates } from '@renderer/rendering/observations/local'
import { collectSemanticCandidates } from '@renderer/rendering/observations/semantic'
import { decideGhostCandidate } from '@renderer/rendering/model/ghostPredicate'
import { createSessionLedger } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// FIXTURE: dead-committed-channel-159 — a permanently dead committed plane.
//
// What this protects: #159 (Codex rollout tailer pinned to a file Codex
// forked away from — jsonl_entries fired ONCE at bootstrap, then never
// again across 67 turns) and #290 (the Claude analog: proxy/semantic alive,
// zero committed entries, resume identity broken). The decisive #159
// investigation finding: the ghost system's correctness model ASSUMES
// "JSONL is the source of truth and eventually arrives" — but in this
// class, committed truth arrives NEVER. The ledger cannot inherit that
// assumption (plan item 5 of the archaeology report):
//
//   1. Semantic-history bridge content must stay visible INDEFINITELY —
//      reordered, never suppressed (D3: suppressing un-owned history is
//      data loss; here it is the ONLY copy that will ever exist).
//   2. Ghost fallback must render once orphaned (committed tail is stale,
//      live evidence is newer — the exact condition ghost exists for).
//   3. Nothing may silently "time out" content because committed rows
//      failed to arrive — the failure is the provider plane's, and it must
//      surface as diagnostics, not as vanishing rows.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('fixture: dead-committed-channel-159', () => {
  // The bootstrap snapshot: the ONLY committed rows the session will ever
  // see. Everything after streams live, commits never.
  const bootstrapEntries = [
    {
      uuid: 'boot-user',
      type: 'user',
      timestamp: iso(T),
      permissionMode: 'default',
      message: { role: 'user', content: 'do the thing' },
    },
    {
      uuid: 'boot-assist',
      type: 'assistant',
      timestamp: iso(T + 10),
      message: { id: 'msg_boot', role: 'assistant', content: 'starting' },
    },
  ]
  // Three completed live turns AFTER the channel died — none will ever
  // commit. In the legacy renderer this is where the feed "shrank" (#159:
  // history cap churned, currentTurn slot recycled, rows vanished).
  const orphanedHistory = [1, 2, 3].map(n => ({
    turnId: `turn-${n}`,
    source: 'proxy',
    startedAtMs: T + n * 1000,
    endedAtMs: T + n * 1000 + 500,
    blocks: [
      { blockIndex: 0, kind: 'text', text: `answer ${n} that will never commit`, finalized: true },
    ],
  }))

  function run() {
    const committed = collectCommittedCandidates(bootstrapEntries, 'codex', 's1')
    const semantic = collectSemanticCandidates(null, orphanedHistory, 'codex', 's1')
    const lifecycle = collectLifecycleCandidates({
      provider: 'codex',
      sessionId: 's1',
      streamPhaseIdle: true,
      hasContentCandidates: true,
    })
    return createSessionLedger()({
      provider: 'codex',
      committed: committed.candidates,
      live: semantic.candidates,
      statics: lifecycle,
      unknowns: [],
    })
  }

  it('every uncommitted turn stays visible in chronological order — the feed can never shrink', () => {
    const ledger = run()
    expect(ledger.rows.map(r => r.candidate.id)).toEqual([
      'entry:boot-user',
      'entry:boot-assist',
      'sem:turn-1:0',
      'sem:turn-2:0',
      'sem:turn-3:0',
    ])
    // All selected — nothing rejected: committed never owned any of it.
    expect(ledger.decisions.filter(d => !d.selected)).toHaveLength(0)
  })

  it('bootstrap text does not fuzzy-own later live turns (conservative keys: exact/normalized only)', () => {
    // 'starting' committed at bootstrap must not suppress 'answer N…' —
    // only identical text may own. Prefix/fuzzy matching is banned (plan
    // §7 rule 5); this asserts the ban holds end-to-end.
    const ledger = run()
    for (const n of [1, 2, 3]) {
      expect(ledger.rows.map(r => r.candidate.id)).toContain(`sem:turn-${n}:0`)
    }
  })

  it('ghost fallback renders for the crash-recovery variant: orphaned, newer than the dead tail, substantive', () => {
    // Same class after restart: semantic state is gone (in-memory), the
    // ghost log holds the lost partial turn, JSONL tail still ends at the
    // bootstrap snapshot. The predicate must admit it.
    const d = decideGhostCandidate(
      {
        id: 'g-lost',
        turnId: 'turn-lost',
        superseded: false,
        orphaned: true,
        updatedAtMs: T + 5_000,
        assistantSingleTextLength: 800,
        toolUse: false,
      },
      { lastJsonlEntryAtMs: T + 10, semanticOwnedTurnIds: new Set() },
    )
    expect(d.selected).toBe(true)
  })
})
