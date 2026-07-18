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
        outcome: { kind: 'generic', shapeId: 'claude.edit.v1', rendererId: 'shared.generic-tool' },
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
      outcome: { kind: 'generic', shapeId: 'claude.edit.v1', rendererId: 'shared.generic-tool' },
    }, lifecycleIndex)).toEqual({ kind: 'known-claimed', shapeId: 'claude.edit.v1' })
    expect(classifySighting({
      structuralFingerprint: FP,
      lifecycle: 'input-complete',
      outcome: specialized,
    }, lifecycleIndex)).toEqual({ kind: 'known-claimed', shapeId: 'claude.edit.v1' })
  })

  it('adds lifecycle alternates without revoking global alternate routes', () => {
    const lifecycleIndex = buildFingerprintIndex([{ 'claude.edit.v1': shape({
      lifecycles: ['prefix', 'input-complete'],
      alternateDispositions: [
        { kind: 'specialized', rendererId: 'shared.command', protocolId: 'command.git' },
      ],
      alternateDispositionsByLifecycle: {
        prefix: [{ kind: 'generic', rendererId: 'shared.generic-tool', reason: 'partial input' }],
      },
    }) }])
    expect(classifySighting({
      structuralFingerprint: FP,
      lifecycle: 'prefix',
      outcome: {
        kind: 'specialized',
        shapeId: 'claude.edit.v1',
        rendererId: 'shared.command',
        protocolId: 'command.git',
      },
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
        shapeId: 'claude.edit.v1',
        ownerRenderId: 'claude.command',
        reason: 'echo',
      }),
    ).toBe(true)
    expect(
      outcomeSatisfiesDisposition(disposition, {
        kind: 'absorbed',
        shapeId: 'claude.edit.v1',
        ownerRenderId: 'claude.spawn',
        reason: 'echo',
      }),
    ).toBe(false)
  })

  it('planned is outstanding and unsupported permits only the visible generic fallback', () => {
    const planned = { kind: 'planned', targetGrammar: 'code-edit' } as const
    expect(
      outcomeSatisfiesDisposition(planned, { kind: 'generic', shapeId: 'claude.edit.v1', rendererId: 'shared.generic-tool' }),
    ).toBe(false)
    expect(
      outcomeSatisfiesDisposition(planned, { kind: 'unknown', fallbackRenderId: 'x' }),
    ).toBe(false)
    expect(outcomeSatisfiesDisposition(planned, specialized)).toBe(false)
    const unsupported = { kind: 'unsupported', reason: 'fallback only' } as const
    expect(
      outcomeSatisfiesDisposition(unsupported, {
        kind: 'generic',
        shapeId: 'claude.edit.v1',
        rendererId: 'shared.generic-tool',
      }),
    ).toBe(true)
    expect(outcomeSatisfiesDisposition(unsupported, specialized)).toBe(false)
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

  it('flags planned entries as unfinished shipping promises', () => {
    const findings = auditRenderShapeCatalog([
      {
        'claude.new.v1': shape({
          id: 'claude.new.v1',
          fixtures: { final: [], prefixes: [] },
          disposition: { kind: 'planned', targetGrammar: 'command' },
        }),
      },
    ])
    expect(findings).toContainEqual({ kind: 'planned-shape', shapeId: 'claude.new.v1' })
  })

  it('audits lifecycle and alternate routes instead of only the primary route', () => {
    const findings = auditRenderShapeCatalog([
      {
        'claude.new.v1': shape({
          id: 'claude.new.v1',
          fixtures: { final: [], prefixes: [] },
          disposition: { kind: 'generic', rendererId: 'shared.generic-tool', reason: 'base' },
          dispositionByLifecycle: { prefix: { kind: 'planned', targetGrammar: 'command' } },
          alternateDispositions: [
            { kind: 'absorbed', ownerRendererId: 'claude.command', reason: 'paired' },
          ],
        }),
      },
    ])
    expect(findings).toContainEqual({ kind: 'planned-shape', shapeId: 'claude.new.v1' })
    expect(findings).toContainEqual({ kind: 'absorbed-without-fixture', shapeId: 'claude.new.v1' })
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

  it('flags duplicate shape ids and lifecycle routes that can never be reached', () => {
    const findings = auditRenderShapeCatalog([
      { first: shape({
        dispositionByLifecycle: {
          prefix: { kind: 'generic', rendererId: 'shared.generic-tool', reason: 'dead route' },
        },
      }) },
      { second: shape({ fingerprints: ['fp2-00000002'] }) },
    ])
    expect(findings).toContainEqual({ kind: 'duplicate-shape-id', shapeId: 'claude.edit.v1' })
    expect(findings).toContainEqual({
      kind: 'undeclared-lifecycle-route',
      shapeId: 'claude.edit.v1',
      lifecycle: 'prefix',
    })
  })
})
