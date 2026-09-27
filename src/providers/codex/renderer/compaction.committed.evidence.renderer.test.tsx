import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import fixture from '../../../../testing/fixtures/rendering-shapes/codex/compaction/committed-compacted.json'

import { renderCodexDurableEntry } from '@providers/codex/renderer/entries/dispatch'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import { buildFingerprintIndex, classifySighting } from '@renderer/rendering/evidence/catalogCoverage'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import type { Entry } from '@shared/types/transcript'

// #1289: a Codex `compacted` rollout line has no payload.type, so the mapper's
// early return swallowed it and Codex compaction never rendered. The fixture is
// two real lines (see its `evidence`): a 0.157.0 one with an empty message and
// an encrypted `compaction` item, and an older one with a readable summary.
const [modern, legacy] = fixture.records as Array<Record<string, unknown> & { timestamp: string }>
const catalogIndex = buildFingerprintIndex([CODEX_RENDER_SHAPES])

const kinds = (entries: Entry[]) => entries.map(entry =>
  (entry as { subtype?: string }).subtype ?? ((entry as { isCompactSummary?: boolean }).isCompactSummary ? 'compact_summary' : entry.type))

describe('Codex committed compaction (#1289)', () => {
  it('keeps the curated carrier identical to what the mapper produces', () => {
    // The catalog coverage gate sweeps `cases`; pinning them to the mapper's
    // output means the gate and these tests read the same shapes.
    expect(fixture.cases).toEqual(fixture.records.flatMap(record =>
      mapCodexRolloutToFeedEntries(record as Record<string, unknown>).map(transcriptEntry => ({ transcriptEntry }))))
  })

  it('maps a 0.157 compaction to one timestamped boundary and nothing else', () => {
    const entries = mapCodexRolloutToFeedEntries(modern!)
    // No summary (the message is empty) and no replay of replacement_history,
    // which only restates context and prompts already in the feed.
    expect(kinds(entries)).toEqual(['compact_boundary'])
    // A timestamp-less row sorts to the bottom of the feed (order.ts).
    expect(entries[0]!.timestamp).toBe(modern!.timestamp)
  })

  it('carries none of the retained history on the boundary', () => {
    // The boundary used to embed the whole payload as compactMetadata:
    // retained prompts, instructions and a 13–23 KB encrypted summary.
    const [boundary] = mapCodexRolloutToFeedEntries(modern!)
    expect(boundary).not.toHaveProperty('compactMetadata')
    expect(JSON.stringify(boundary).length).toBeLessThan(300)
  })

  it('maps an older compaction with a readable message to boundary then summary', () => {
    const entries = mapCodexRolloutToFeedEntries(legacy!)
    expect(kinds(entries)).toEqual(['compact_boundary', 'compact_summary'])
    for (const entry of entries) expect(entry.timestamp).toBe(legacy!.timestamp)
  })

  it('renders both through shared.compaction, and the catalog claims them', () => {
    const entries = [...mapCodexRolloutToFeedEntries(modern!), ...mapCodexRolloutToFeedEntries(legacy!)]
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      const decision = renderCodexDurableEntry({ entry } as Parameters<typeof renderCodexDurableEntry>[0])
      if (decision?.action !== 'render') throw new Error('expected a rendered compaction entry')
      const eventType = entry.type === 'system' ? `system:${(entry as { subtype: string }).subtype}` : entry.type
      const fingerprint = fingerprintRenderShape({ provider: 'codex', plane: 'transcript-entry', eventType, payload: entry }).fingerprint
      const definition = catalogIndex.byFingerprint.get(fingerprint)
      expect({ eventType, claimed: definition?.id }).toEqual({ eventType, claimed: expect.stringMatching(/^codex\.entry\./) })
      expect(classifySighting({
        structuralFingerprint: fingerprint,
        lifecycle: 'durable',
        outcome: { kind: 'specialized', shapeId: definition!.id, rendererId: decision.receipt.rendererId, protocolId: decision.receipt.protocolId },
      } as Parameters<typeof classifySighting>[0], catalogIndex)).toEqual({ kind: 'known-claimed', shapeId: definition!.id })
      const view = render(decision.node)
      expect(view.container.textContent?.length).toBeGreaterThan(0)
      view.unmount()
    }
  })
})
