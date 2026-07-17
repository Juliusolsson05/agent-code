import { describe, expect, it } from 'vitest'

import type { RenderShapeSighting } from '@shared/types/renderShapes'
import { buildFingerprintIndex } from '@renderer/rendering/evidence/catalogCoverage'
import { defineRenderShape } from '@renderer/rendering/evidence/defineRenderShape'
import { buildUnknownShapeReport } from '@renderer/features/debug/devModules/RenderingShapes/unknownShapeReport'

const KNOWN_FP = 'fp2-000000aa'

const index = buildFingerprintIndex([
  {
    'claude.tool-use.bash.v1': defineRenderShape({
      id: 'claude.tool-use.bash.v1',
      provider: 'claude',
      fingerprints: [KNOWN_FP],
      eventTypes: ['tool_use'],
      planes: ['committed-tool-use'],
      lifecycles: ['durable'],
      observed: { providerVersions: [], models: [], firstSeen: '2026-07-16', lastSeen: '2026-07-16' },
      fixtures: { final: ['rendering-bundles/x.json'], prefixes: [] },
      disposition: { kind: 'planned', targetGrammar: 'command' },
      why: 'test',
    }),
  },
])

function sighting(over: Partial<RenderShapeSighting>): RenderShapeSighting {
  return {
    schemaVersion: 1,
    sessionId: 's',
    provider: 'claude',
    providerVersion: null,
    model: null,
    sourcePlane: 'committed-tool-use',
    lifecycle: 'durable',
    eventType: 'tool_use',
    structuralFingerprint: KNOWN_FP,
    shapePaths: ['name:string', 'type:string'],
    discriminatorValues: { name: 'Bash' },
    payloadHash: 'ab',
    sourceRecordingCursor: null,
    observedAt: 1_700_000_000_000,
    outcome: { kind: 'generic', rendererId: 'shared.generic-tool' },
    seenCount: 1,
    ...over,
  }
}

describe('unknown-shape report derivation (Phase 3)', () => {
  it('groups by provider+fingerprint, honors seenCount, splits inbox from clean rows', () => {
    const report = buildUnknownShapeReport(
      [
        sighting({}),
        sighting({ seenCount: 41, lifecycle: 'durable' }),
        sighting({ structuralFingerprint: 'fp2-ffffffff', eventType: 'mystery' }),
      ],
      index,
    )
    expect(report.rows).toHaveLength(2)
    // Writer-key MAX semantics (review finding: summing the first-sight
    // line (implied 1) and its final-flush copy (seenCount 41) double-
    // counted): the two same-key lines are ONE key at max(1, 41) = 41,
    // plus the unknown fingerprint's 1 → 42, never 43.
    expect(report.totalSightings).toBe(42)
    expect(report.inbox).toHaveLength(1)
    expect(report.inbox[0].status).toBe('unknown-structure')
    // Unknown rows sort ABOVE clean rows — worst first is the inbox contract.
    expect(report.rows[0].structuralFingerprint).toBe('fp2-ffffffff')
    const clean = report.rows[1]
    expect(clean.status).toBe('known-claimed')
    expect(clean.catalogShapeId).toBe('claude.tool-use.bash.v1')
  })

  it('an undeclared lifecycle milestone puts a KNOWN shape in the inbox', () => {
    const report = buildUnknownShapeReport([sighting({ lifecycle: 'prefix' })], index)
    expect(report.inbox).toHaveLength(1)
    expect(report.inbox[0].status).toBe('known-unsupported-lifecycle')
    expect(report.inbox[0].catalogShapeId).toBe('claude.tool-use.bash.v1')
  })

  it('keeps same-kind renderer routes separate in writer counts and report evidence', () => {
    const report = buildUnknownShapeReport([
      sighting({
        seenCount: 3,
        outcome: { kind: 'specialized', shapeId: 'a', rendererId: 'renderer.a' },
      }),
      sighting({
        seenCount: 5,
        outcome: { kind: 'specialized', shapeId: 'b', rendererId: 'renderer.b' },
      }),
    ], index)
    expect(report.totalSightings).toBe(8)
    expect(report.rows[0].routes).toEqual({
      'specialized:renderer.a': 3,
      'specialized:renderer.b': 5,
    })
  })

  it('malformed sidecar lines are counted, never thrown, never rows', () => {
    const report = buildUnknownShapeReport(
      [null, 42, { schemaVersion: 2 }, { schemaVersion: 1 }, sighting({})],
      index,
    )
    expect(report.invalidSightings).toBe(4)
    expect(report.rows).toHaveLength(1)
  })
})
