import { describe, expect, it } from 'vitest'

import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { RenderCandidate } from '@renderer/rendering/model/types'
import {
  diffShadowUnits,
  ledgerUnits,
  legacyUnits,
  type LegacyItemLike,
} from '@renderer/rendering/shadow/shadowDiff'

// ---------------------------------------------------------------------------
// Shadow diff: the normalization must collapse REPRESENTATION differences
// (block-level vs turn-level, plane prefixes vs folded uuids) while
// preserving REAL differences (a row missing, duplicated, mis-ordered).
// A false divergence here means Stage 2 drowns in noise; a missed one
// means the cutover ships a regression the shadow was built to catch.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000

const cand = (over: Partial<RenderCandidate> & Pick<RenderCandidate, 'id' | 'sourcePlane'>): RenderCandidate => ({
  owner: 'committed',
  provider: 'claude',
  sessionId: 's1',
  contentKind: 'user-text',
  timestampMs: T,
  sequence: 0,
  ...over,
})

describe('shadow diff — normalization', () => {
  it('equivalent representations produce zero divergences', () => {
    // Legacy: two entries, one whole semantic turn, work row.
    const legacy: LegacyItemLike[] = [
      { type: 'entry', entryUuid: 'u1' },
      { type: 'entry', entryUuid: 'a1' },
      { type: 'semantic-current', turnId: 'turn_live' },
      { type: 'work' },
    ]
    // New: same content but the semantic turn is TWO block candidates —
    // must collapse to one turn unit.
    const ledger = createSessionLedger()({
      provider: 'claude',
      committed: [
        cand({ id: 'entry:u1', sourcePlane: 'committed', timestampMs: T }),
        cand({ id: 'entry:a1', sourcePlane: 'committed', timestampMs: T + 100, sequence: 1 }),
      ],
      live: [
        cand({
          id: 'sem:turn_live:0',
          sourcePlane: 'semantic',
          owner: 'semantic-current',
          turnId: 'turn_live',
          contentKind: 'thinking',
          timestampMs: T + 200,
          sequence: 2,
        }),
        cand({
          id: 'sem:turn_live:1',
          sourcePlane: 'semantic',
          owner: 'semantic-current',
          turnId: 'turn_live',
          contentKind: 'assistant-text',
          timestampMs: T + 200,
          sequence: 3,
        }),
      ],
      statics: [
        cand({ id: 'work', sourcePlane: 'process', owner: 'work', contentKind: 'work', timestampMs: null, sequence: 4 }),
      ],
      unknowns: [],
    })
    const result = diffShadowUnits(legacyUnits(legacy), ledgerUnits(ledger))
    expect(result.divergences).toEqual([])
    expect(result.next).toEqual(['row:u1', 'row:a1', 'turn:turn_live', 'work'])
  })

  it('folded ghost/optimistic uuids and plane prefixes meet at the same unit key', () => {
    const legacy: LegacyItemLike[] = [
      { type: 'entry', entryUuid: 'optimistic-codex-user:9' },
      { type: 'entry', entryUuid: 'g-turn-0' },
    ]
    const ledger = createSessionLedger()({
      provider: 'claude',
      committed: [],
      live: [
        cand({
          id: 'optimistic:optimistic-codex-user:9',
          sourcePlane: 'local-submit',
          owner: 'optimistic-submit',
          timestampMs: T,
        }),
      ],
      statics: [
        cand({
          id: 'ghost:g-turn-0',
          sourcePlane: 'ghost',
          owner: 'ghost-fallback',
          contentKind: 'tool-use',
          timestampMs: T + 10,
          sequence: 1,
        }),
      ],
      unknowns: [],
    })
    const result = diffShadowUnits(legacyUnits(legacy), ledgerUnits(ledger))
    expect(result.divergences).toEqual([])
  })
})

describe('shadow diff — real divergences', () => {
  const L = (ids: string[]): ReturnType<typeof legacyUnits> =>
    legacyUnits(ids.map(id => ({ type: 'entry', entryUuid: id })))

  it('reports missing and extra rows by set difference', () => {
    const result = diffShadowUnits(L(['a', 'b']), L(['b', 'c']))
    expect(result.divergences).toEqual([
      { class: 'missing-in-next', unit: 'row:a' },
      { class: 'extra-in-next', unit: 'row:c' },
    ])
  })

  it('reports only the FIRST order mismatch when sets agree (no cascade)', () => {
    const result = diffShadowUnits(L(['a', 'b', 'c']), L(['c', 'a', 'b']))
    expect(result.divergences).toEqual([
      { class: 'order-mismatch', index: 0, legacy: 'row:a', next: 'row:c' },
    ])
  })

  it('reports duplicate-count drift as a tail mismatch', () => {
    const result = diffShadowUnits(L(['a', 'b']), L(['a', 'b', 'b']))
    expect(result.divergences).toEqual([
      { class: 'order-mismatch', index: 2, legacy: '<end>', next: 'row:b' },
    ])
  })
})
