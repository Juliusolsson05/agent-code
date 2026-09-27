import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { TransportGapRecord } from '@shared/types/session'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerFeedContextFromRuntime, ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { transportGapSentence } from '@renderer/features/feed/lib/transportGapText'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { Feed } from '@renderer/features/feed/ui/Feed'

// #1442 review c: every other gap test stops at ledgerToFeedItems, one layer short of the component.
// Replacing Feed's `transport-gap` case with `return null` left them all green, so a broken row
// would ship with a passing suite. This renders the REAL Feed with the items the REAL ledger builds.

const T = Date.parse('2026-09-27T10:00:00.000Z')
const GAP: TransportGapRecord = { id: 'gap-1', since: T + 10_000, until: T + 40_000, lostGenerations: 2 }

function itemsFor(runtime: SessionRuntime) {
  const input = createLedgerInputAdapter()({
    provider: 'claude',
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    transportGaps: runtime.transportGaps,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }).input
  return ledgerToFeedItems(createSessionLedger()(input), ledgerFeedContextFromRuntime(runtime, 'claude')).items
}

describe('Feed transport-gap row', () => {
  it('paints the "not captured" sentence for a gap the ledger placed', () => {
    const runtime: SessionRuntime = { ...emptyRuntime(), transportGaps: [GAP] }
    const items = itemsFor(runtime)
    expect(items.some(item => item.type === 'transport-gap')).toBe(true)
    render(<Feed sessionId="s1" provider="claude" entries={[]} renderItemsOverride={items} />)
    expect(screen.getByText(transportGapSentence(GAP))).toBeTruthy()
  })
})
