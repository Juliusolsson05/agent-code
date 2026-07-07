import { describe, expect, it } from 'vitest'

import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import {
  createSessionLedger,
  type GhostLedgerCandidate,
  type LedgerInput,
} from '@renderer/rendering/model/ledger'
import type { GhostPredicateContext } from '@renderer/rendering/model/ghostPredicate'
import type { RenderCandidate } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// FIXTURE: sidecar-tail ghost — the dominant production ghost failure mode,
// now exercised END-TO-END through the ledger (the unit suite covers the
// predicate in isolation; this proves the ledger consults it and that a
// selected ghost actually competes in ordering).
//
// The scenario (from bundle 2026-05-07T08-26-35-212, retold in
// ghostPredicate.ts): a turn completes and commits at t+100; ~half a second
// later the provider's predict-next-prompt sidecar streams a short
// assistant blurb that never commits. The user walks away. The sidecar
// ghost is orphaned (TTL elapsed), unsuperseded, and STRICTLY NEWER than
// the committed tail — rules 1–4 all pass. Rule 5 (shape backstop) is the
// only thing standing between the user and a phantom "Understood!" row
// pinned to the bottom of the feed forever. This is exactly why the
// single-rule timestamp-only design was overturned.
//
// Beside it, a genuinely stuck tool_use ghost (JSONL stalled mid-turn) must
// STILL paint — hiding it was the 10e4fc5 regression (hide-all → lost the
// crash-recovery fallback entirely).
//
// NOTE: ghost candidates are hand-built here because the ghost collector
// lives in the runtime→collector adapter (the shadow seam, next slice) —
// the ledger contract for ghosts is what this fixture pins down.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const committedEntries = [
  {
    uuid: 'u1',
    type: 'user',
    timestamp: iso(T),
    permissionMode: 'default',
    message: { role: 'user', content: 'run the migration' },
  },
  {
    uuid: 'a1',
    type: 'assistant',
    timestamp: iso(T + 100),
    message: { id: 'msg_done', role: 'assistant', content: 'Migration finished, 3 tables touched.' },
  },
]

const ghostRow = (
  id: string,
  turnId: string,
  updatedAtMs: number,
  kind: 'tool-use' | 'assistant-text',
): RenderCandidate => ({
  id,
  owner: 'ghost-fallback',
  provider: 'claude',
  sourcePlane: 'ghost',
  sessionId: 's1',
  turnId,
  contentKind: kind,
  timestampMs: updatedAtMs,
  sequence: 0,
})

// The 41-char sidecar blurb — the exact max length observed in the source
// bundle, comfortably under SIDECAR_GHOST_TEXT_MAX.
const sidecarGhost: GhostLedgerCandidate = {
  candidate: ghostRow('ghost:sidecar', 'turn_sidecar', T + 600, 'assistant-text'),
  predicate: {
    id: 'ghost:sidecar',
    turnId: 'turn_sidecar',
    superseded: false,
    orphaned: true,
    updatedAtMs: T + 600,
    assistantSingleTextLength: 41,
    toolUse: false,
  },
}

// The legitimate recovery case: a tool_use turn whose JSONL write stalled.
// Structurally exempt from the shape backstop.
const stuckToolGhost: GhostLedgerCandidate = {
  candidate: ghostRow('ghost:stuck-tool', 'turn_stuck', T + 700, 'tool-use'),
  predicate: {
    id: 'ghost:stuck-tool',
    turnId: 'turn_stuck',
    superseded: false,
    orphaned: true,
    updatedAtMs: T + 700,
    assistantSingleTextLength: null,
    toolUse: true,
  },
}

function baseInput(): LedgerInput {
  const { candidates: committed } = collectCommittedCandidates(committedEntries, 'claude', 's1')
  return {
    provider: 'claude',
    committed,
    live: [],
    statics: [],
    unknowns: [],
    ghosts: [sidecarGhost, stuckToolGhost],
    ghostContext: {
      // Committed tail = the assistant row's producer timestamp. Both ghosts
      // are strictly newer, so rule 4 passes for BOTH — shape is the only
      // discriminator left, exactly the production trap.
      lastJsonlEntryAtMs: T + 100,
      semanticOwnedTurnIds: new Set<string>(),
    },
  }
}

describe('fixture: sidecar-tail ghost (end-to-end ledger with ghost plane)', () => {
  it('rejects the sidecar by shape while painting the stuck tool_use ghost after committed rows', () => {
    const ledger = createSessionLedger()(baseInput())

    expect(ledger.rows.map(r => r.candidate.id)).toEqual(['entry:u1', 'entry:a1', 'ghost:stuck-tool'])

    const sidecarDecision = ledger.decisions.find(d => d.candidateId === 'ghost:sidecar')
    expect(sidecarDecision?.selected).toBe(false)
    expect(sidecarDecision?.reason).toBe('ghost-sidecar-shape')

    const stuckDecision = ledger.decisions.find(d => d.candidateId === 'ghost:stuck-tool')
    expect(stuckDecision?.selected).toBe(true)
  })

  it('kills the recovery ghost the moment committed truth catches up past it', () => {
    const input = baseInput()
    // JSONL tail advances past the ghost's update — the stall resolved.
    // Rule 4 must now reject; the ghost's job is done and the committed
    // rows it stood in for own the feed again.
    const caughtUp: LedgerInput = {
      ...input,
      ghostContext: { lastJsonlEntryAtMs: T + 900, semanticOwnedTurnIds: new Set<string>() },
    }
    const ledger = createSessionLedger()(caughtUp)

    expect(ledger.rows.map(r => r.candidate.id)).toEqual(['entry:u1', 'entry:a1'])
    const stuckDecision = ledger.decisions.find(d => d.candidateId === 'ghost:stuck-tool')
    expect(stuckDecision?.selected).toBe(false)
    expect(stuckDecision?.reason).toBe('ghost-older-than-jsonl')
  })

  it('keeps ledger identity when ghost inputs are unchanged, even with a fresh context object', () => {
    const ledger = createSessionLedger()
    const input = baseInput()
    const first = ledger(input)

    // A new ghostContext OBJECT with field-equal contents must not bust the
    // cache — the adapter derives the context fresh each tick and the
    // identity-stability contract (D11) is judged on the fields, not the
    // wrapper. The set reference IS part of the fields.
    const ctx: GhostPredicateContext = {
      lastJsonlEntryAtMs: input.ghostContext!.lastJsonlEntryAtMs,
      semanticOwnedTurnIds: input.ghostContext!.semanticOwnedTurnIds,
    }
    const second = ledger({ ...input, ghostContext: ctx })
    expect(second).toBe(first)

    // But a REAL change — the tail moving — must recompute.
    const third = ledger({
      ...input,
      ghostContext: { lastJsonlEntryAtMs: T + 900, semanticOwnedTurnIds: ctx.semanticOwnedTurnIds },
    })
    expect(third).not.toBe(first)
    expect(third.rows.map(r => r.candidate.id)).toEqual(['entry:u1', 'entry:a1'])
  })
})
