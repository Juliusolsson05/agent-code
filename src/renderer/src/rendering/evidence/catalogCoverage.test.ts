import { describe, expect, it } from 'vitest'

import type { RenderOutcome } from '@shared/types/renderShapes'
import {
  auditRenderShapeCatalog,
  buildFingerprintIndex,
  classifySighting,
  classifySightingStructure,
  outcomeSatisfiesDisposition,
} from '@renderer/rendering/evidence/catalogCoverage'
import {
  defineRenderShape,
  type RenderShapeDefinition,
} from '@renderer/rendering/evidence/defineRenderShape'

const FP = 'fp2-0000abcd'

function shape(over: Partial<RenderShapeDefinition<'claude'>> = {}): RenderShapeDefinition<'claude'> {
  return defineRenderShape({
    id: 'claude.edit.v1',
    provider: 'claude',
    fingerprints: [FP],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'],
    lifecycles: ['input-complete'],
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-16',
      lastSeen: '2026-07-16',
    },
    fixtures: { final: ['claude/edit-v1/final.json'], prefixes: [] },
    disposition: { kind: 'specialized', rendererId: 'claude.code-edit' },
    why: 'test',
    ...over,
  } as RenderShapeDefinition<'claude'>)
}

const specialized: RenderOutcome = { kind: 'specialized', shapeId: 'claude.edit.v1', rendererId: 'claude.code-edit' }

describe('classifySighting — the five plan §Step 4 states', () => {
  const index = buildFingerprintIndex([{ 'claude.edit.v1': shape() }])

  it('known-and-claimed when outcome matches the declared disposition', () => {
    const c = classifySighting(
      { structuralFingerprint: FP, lifecycle: 'input-complete', outcome: specialized },
      index,
    )
    expect(c).toEqual({ kind: 'known-claimed', shapeId: 'claude.edit.v1' })
  })

  it('known-but-misrouted when another renderer painted a catalogued shape', () => {
    const c = classifySighting(
      {
        structuralFingerprint: FP,
        lifecycle: 'input-complete',
        outcome: { kind: 'generic', rendererId: 'shared.generic-tool' },
      },
      index,
    )
    expect(c.kind).toBe('known-misrouted')
  })

  it('uses a lifecycle-specific route when a strict adapter declines prefixes', () => {
    const lifecycleIndex = buildFingerprintIndex([{ 'claude.edit.v1': shape({
      lifecycles: ['prefix', 'input-complete'],
      dispositionByLifecycle: {
        prefix: {
          kind: 'generic',
          rendererId: 'shared.generic-tool',
          reason: 'Incomplete input remains visible until required fields close.',
        },
      },
    }) }])
    expect(classifySighting({
      structuralFingerprint: FP,
      lifecycle: 'prefix',
      outcome: { kind: 'generic', rendererId: 'shared.generic-tool' },
    }, lifecycleIndex)).toEqual({ kind: 'known-claimed', shapeId: 'claude.edit.v1' })
    expect(classifySighting({
      structuralFingerprint: FP,
      lifecycle: 'input-complete',
      outcome: specialized,
    }, lifecycleIndex)).toEqual({ kind: 'known-claimed', shapeId: 'claude.edit.v1' })
  })

  it('known-but-unsupported-lifecycle for an undeclared prefix milestone', () => {
    const c = classifySighting(
      { structuralFingerprint: FP, lifecycle: 'prefix', outcome: specialized },
      index,
    )
    expect(c).toEqual({
      kind: 'known-unsupported-lifecycle',
      shapeId: 'claude.edit.v1',
      lifecycle: 'prefix',
    })
  })

  it('unknown-structure for an uncatalogued fingerprint', () => {
    const c = classifySighting(
      { structuralFingerprint: 'fp2-ffffffff', lifecycle: 'input-complete', outcome: specialized },
      index,
    )
    expect(c).toEqual({ kind: 'unknown-structure', structuralFingerprint: 'fp2-ffffffff' })
  })

  it('unknown-outcome when a catalogued shape fell to the unknown fallback', () => {
    const c = classifySighting(
      {
        structuralFingerprint: FP,
        lifecycle: 'input-complete',
        outcome: { kind: 'unknown', fallbackRenderId: 'shared.unknown-operation' },
      },
      index,
    )
    expect(c.kind).toBe('unknown-outcome')
  })
})

describe('classifySightingStructure — pre-receipt evidence stays honest', () => {
  const index = buildFingerprintIndex([{ 'claude.edit.v1': shape() }])

  it('proves catalog/lifecycle coverage without inventing a renderer outcome', () => {
    expect(
      classifySightingStructure(
        { structuralFingerprint: FP, lifecycle: 'input-complete' },
        index,
      ),
    ).toEqual({ kind: 'known-structure', shapeId: 'claude.edit.v1' })
  })

  it('still reports unknown fingerprints and unsupported prefixes', () => {
    expect(
      classifySightingStructure(
        { structuralFingerprint: 'fp2-ffffffff', lifecycle: 'input-complete' },
        index,
      ),
    ).toEqual({ kind: 'unknown-structure', structuralFingerprint: 'fp2-ffffffff' })
    expect(
      classifySightingStructure({ structuralFingerprint: FP, lifecycle: 'prefix' }, index),
    ).toEqual({
      kind: 'known-unsupported-lifecycle',
      shapeId: 'claude.edit.v1',
      lifecycle: 'prefix',
    })
  })
})

describe('outcomeSatisfiesDisposition — conservative matching', () => {
  it('absorbed requires the DECLARED owner, not any owner', () => {
    const disposition = {
      kind: 'absorbed',
      ownerRendererId: 'claude.command',
      reason: 'result echo',
    } as const
    expect(
      outcomeSatisfiesDisposition(disposition, {
        kind: 'absorbed',
        ownerRenderId: 'claude.command',
        reason: 'echo',
      }),
    ).toBe(true)
    expect(
      outcomeSatisfiesDisposition(disposition, {
        kind: 'absorbed',
        ownerRenderId: 'claude.spawn',
        reason: 'echo',
      }),
    ).toBe(false)
  })

  it('planned/unsupported accept every outcome — no promise, no misroute (pre-receipt seed contract)', () => {
    const planned = { kind: 'planned', targetGrammar: 'code-edit' } as const
    expect(
      outcomeSatisfiesDisposition(planned, { kind: 'generic', rendererId: 'shared.generic-tool' }),
    ).toBe(true)
    expect(
      outcomeSatisfiesDisposition(planned, { kind: 'unknown', fallbackRenderId: 'x' }),
    ).toBe(true)
    // Legacy content-dependent routes (git widget for git Bash, absorbed
    // result echoes) must not read as misrouted while the entry is planned.
    expect(outcomeSatisfiesDisposition(planned, specialized)).toBe(true)
    expect(
      outcomeSatisfiesDisposition(planned, {
        kind: 'absorbed',
        ownerRenderId: 'shared.git-widget',
        reason: 'x',
      }),
    ).toBe(true)
  })
})

describe('auditRenderShapeCatalog — invariants the type system cannot see', () => {
  it('flags specialized/absorbed entries without a final fixture', () => {
    const findings = auditRenderShapeCatalog([
      {
        'claude.edit.v1': shape({ fixtures: { final: [], prefixes: [] } }),
        'claude.echo.v1': shape({
          id: 'claude.echo.v1',
          fingerprints: ['fp2-00000002'],
          fixtures: { final: [], prefixes: [] },
          disposition: { kind: 'absorbed', ownerRendererId: 'claude.command', reason: 'echo' },
        }),
      },
    ])
    expect(findings).toContainEqual({ kind: 'specialized-without-fixture', shapeId: 'claude.edit.v1' })
    expect(findings).toContainEqual({ kind: 'absorbed-without-fixture', shapeId: 'claude.echo.v1' })
  })

  it('planned entries need no fixture (pre-extraction state is legal)', () => {
    const findings = auditRenderShapeCatalog([
      {
        'claude.new.v1': shape({
          id: 'claude.new.v1',
          fixtures: { final: [], prefixes: [] },
          disposition: { kind: 'planned', targetGrammar: 'command' },
        }),
      },
    ])
    expect(findings).toHaveLength(0)
  })

  it('flags empty and malformed fingerprints', () => {
    const findings = auditRenderShapeCatalog([
      {
        'claude.a.v1': shape({ id: 'claude.a.v1', fingerprints: [] }),
        'claude.b.v1': shape({ id: 'claude.b.v1', fingerprints: ['not-a-fingerprint'] }),
      },
    ])
    expect(findings).toContainEqual({ kind: 'empty-fingerprints', shapeId: 'claude.a.v1' })
    expect(findings).toContainEqual({
      kind: 'malformed-fingerprint',
      shapeId: 'claude.b.v1',
      fingerprint: 'not-a-fingerprint',
    })
  })

  it('flags one fingerprint claimed by two entries — across catalogs too', () => {
    const findings = auditRenderShapeCatalog([
      { 'claude.a.v1': shape({ id: 'claude.a.v1' }) },
      { 'claude.b.v1': shape({ id: 'claude.b.v1' }) },
    ])
    expect(findings).toContainEqual({
      kind: 'duplicate-fingerprint',
      fingerprint: FP,
      shapeIds: ['claude.a.v1', 'claude.b.v1'],
    })
  })
})
