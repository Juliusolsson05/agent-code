import { describe, expect, it } from 'vitest'

import {
  decideGhostCandidate,
  SIDECAR_GHOST_TEXT_MAX,
} from '@renderer/rendering/model/ghostPredicate'
import type {
  GhostPredicateContext,
  GhostPredicateInput,
} from '@renderer/rendering/model/ghostPredicate'

// The canonical 10-case matrix from the 2026-05-07 predicate plan, plus the
// four documented failed-fix regressions as named cases. Fixed wall-clock
// anchors, never Date.now() (resume comparisons live in producer time).
const T_TAIL = 1_700_000_000_000
const NEWER = T_TAIL + 5_000
const OLDER = T_TAIL - 5_000

function ghost(over: Partial<GhostPredicateInput> = {}): GhostPredicateInput {
  return {
    id: 'g-1',
    turnId: 'turn-1',
    superseded: false,
    orphaned: true,
    updatedAtMs: NEWER,
    assistantSingleTextLength: 500, // substantive by default
    toolUse: false,
    ...over,
  }
}

function ctx(over: Partial<GhostPredicateContext> = {}): GhostPredicateContext {
  return {
    lastJsonlEntryAtMs: T_TAIL,
    semanticOwnedTurnIds: new Set<string>(),
    ...over,
  }
}

describe('ghost five-rule predicate (2026-05-07 matrix)', () => {
  it('case: superseded ghost never renders (rule 1)', () => {
    const d = decideGhostCandidate(ghost({ superseded: true }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-superseded' })
  })

  it('case: unorphaned ghost never renders — the turn_completed→JSONL race guard (rule 2)', () => {
    const d = decideGhostCandidate(ghost({ orphaned: false }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-not-orphaned' })
  })

  it('case: semantic-owned turn hides the ghost (rule 3 — dies with SemanticStreamingTurn at cutover)', () => {
    const d = decideGhostCandidate(ghost(), ctx({ semanticOwnedTurnIds: new Set(['turn-1']) }))
    expect(d).toMatchObject({ selected: false, reason: 'ghost-semantic-owned' })
  })

  it('case: sidecar leak older than the tail hides (rule 4) — the 686b94e regression', () => {
    // 686b94e rendered ALL orphans: title-gen fragments from t-5000 parked
    // at the feed bottom forever. Rule 4 kills the stale class.
    const d = decideGhostCandidate(ghost({ updatedAtMs: OLDER, assistantSingleTextLength: 30 }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-older-than-jsonl' })
  })

  it('case: equal-to-tail is NOT newer — strictly-greater comparison', () => {
    const d = decideGhostCandidate(ghost({ updatedAtMs: T_TAIL }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-older-than-jsonl' })
  })

  it('case: THE fallback case — committed stalled past live, substantive orphan RENDERS', () => {
    const d = decideGhostCandidate(ghost(), ctx())
    expect(d.selected).toBe(true)
  })

  it('case: tail sidecar defeats rule 4 and dies on rule 5 — why the single-rule design was overturned', () => {
    // Real commit t=100, predict-next-prompt sidecar t=105, user walks
    // away: updatedAt > tail yet it is garbage. The dominant production
    // failure mode; rules 4 AND 5 stay together forever.
    const d = decideGhostCandidate(ghost({ assistantSingleTextLength: 41 }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-sidecar-shape' })
  })

  it('case: tool_use ghost renders even when short — structurally never sidecar-shaped', () => {
    const d = decideGhostCandidate(
      ghost({ toolUse: true, assistantSingleTextLength: null }),
      ctx(),
    )
    expect(d.selected).toBe(true)
  })

  it('case: fresh session (null tail) does not gate on rule 4 but still runs the shape rule', () => {
    const fresh = ctx({ lastJsonlEntryAtMs: null })
    expect(decideGhostCandidate(ghost(), fresh).selected).toBe(true)
    expect(decideGhostCandidate(ghost({ assistantSingleTextLength: 12 }), fresh)).toMatchObject({
      selected: false,
      reason: 'ghost-sidecar-shape',
    })
  })

  it('documented trade-off: a real crashed short "Done." turn is invisibly lost — accepted, forever explicit', () => {
    const d = decideGhostCandidate(ghost({ assistantSingleTextLength: 5 }), ctx())
    expect(d).toMatchObject({ selected: false, reason: 'ghost-sidecar-shape' })
  })

  it('boundary: exactly SIDECAR_GHOST_TEXT_MAX hides; one char over renders', () => {
    expect(decideGhostCandidate(ghost({ assistantSingleTextLength: SIDECAR_GHOST_TEXT_MAX }), ctx()).selected).toBe(false)
    expect(decideGhostCandidate(ghost({ assistantSingleTextLength: SIDECAR_GHOST_TEXT_MAX + 1 }), ctx()).selected).toBe(true)
  })

  it('every rejection carries evidence — the ledger explains itself (#344)', () => {
    const rejected = [
      decideGhostCandidate(ghost({ superseded: true }), ctx()),
      decideGhostCandidate(ghost({ updatedAtMs: OLDER }), ctx()),
      decideGhostCandidate(ghost({ assistantSingleTextLength: 10 }), ctx()),
    ]
    for (const d of rejected) expect(d.evidence.length).toBeGreaterThan(0)
  })
})
