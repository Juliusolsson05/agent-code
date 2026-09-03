import { describe, expect, it } from 'vitest'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

import { gcHiddenOrphanGhosts, gcSupersededGhosts } from '@renderer/session-runtime/ghosts'

// Every case here is a guard for #724: the sweep must evict exactly the
// orphans the render predicate (rule 4) has already hidden for good — those
// at-or-before the committed JSONL tail — and nothing else. Anything the
// fallback render might still need (orphans newer than the tail, ghosts not
// yet orphaned, everything when no JSONL has been observed) must survive.

const NOW = 1_700_000_100_000
const GC_MS = 5_000

function ghost(
  uuid: string,
  atp: { updatedAt: number; orphanedAt?: number; supersededBy?: string; turnId?: string },
): [string, GhostEntry] {
  return [uuid, { uuid, type: 'assistant', _atp: { turnId: 't-old', ...atp } } as unknown as GhostEntry]
}

describe('gcHiddenOrphanGhosts', () => {
  it('evicts orphans at or before the JSONL tail once the grace has elapsed', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-behind', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS - 1 }),
      ghost('g-at-tail', { updatedAt: tail, orphanedAt: NOW - GC_MS - 1 }),
    ])

    const next = gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)

    expect(next.size).toBe(0)
    expect(prev.size).toBe(2)
  })

  it('keeps orphans newer than the tail — the stuck-JSONL fallback they exist for', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-ahead', { updatedAt: tail + 1, orphanedAt: NOW - GC_MS - 1 }),
    ])

    expect(gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)).toBe(prev)
  })

  it('keeps ghosts that are not orphaned yet, whatever their timestamp', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-live', { updatedAt: tail - 1 }),
    ])

    expect(gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)).toBe(prev)
  })

  it('waits out the grace period after the orphan transition', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-fresh-orphan', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS }),
    ])

    // Same inclusive boundary as gcSupersededGhosts: at exactly gcMs it stays.
    expect(gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)).toBe(prev)
    expect(gcHiddenOrphanGhosts(prev, tail, null, NOW + 1, GC_MS).size).toBe(0)
  })

  it('keeps hidden orphans of the live current turn so the bridge cannot re-mint them', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-live-turn', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS - 1, turnId: 't-live' }),
      ghost('g-old-turn', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS - 1, turnId: 't-old' }),
    ])

    const next = gcHiddenOrphanGhosts(prev, tail, 't-live', NOW, GC_MS)

    expect([...next.keys()]).toEqual(['g-live-turn'])
    // Once the turn is no longer current it goes like any other hidden orphan.
    expect(gcHiddenOrphanGhosts(next, tail, 't-next', NOW, GC_MS).size).toBe(0)
  })

  it('leaves everything alone when no JSONL tail has been observed', () => {
    const prev = new Map<string, GhostEntry>([
      ghost('g-orphan', { updatedAt: NOW - 90_000, orphanedAt: NOW - 30_000 }),
    ])

    expect(gcHiddenOrphanGhosts(prev, null, null, NOW, GC_MS)).toBe(prev)
  })

  it('leaves superseded ghosts to gcSupersededGhosts', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-superseded', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS - 1, supersededBy: 'real' }),
    ])

    expect(gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)).toBe(prev)
    expect(gcSupersededGhosts(prev, NOW, GC_MS).size).toBe(0)
  })

  it('is reference-stable on no-op and copies only when it evicts', () => {
    const tail = NOW - 60_000
    const prev = new Map<string, GhostEntry>([
      ghost('g-ahead', { updatedAt: tail + 1, orphanedAt: NOW - GC_MS - 1 }),
      ghost('g-behind', { updatedAt: tail - 1, orphanedAt: NOW - GC_MS - 1 }),
    ])

    const next = gcHiddenOrphanGhosts(prev, tail, null, NOW, GC_MS)

    expect(next).not.toBe(prev)
    expect([...next.keys()]).toEqual(['g-ahead'])
    expect(gcHiddenOrphanGhosts(next, tail, null, NOW, GC_MS)).toBe(next)
  })
})
