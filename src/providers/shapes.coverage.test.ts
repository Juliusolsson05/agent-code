import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { sweepBundleShapes } from '@renderer/rendering/evidence/bundleShapeSweep'
import {
  auditRenderShapeCatalog,
  buildFingerprintIndex,
  classifySightingStructure,
} from '@renderer/rendering/evidence/catalogCoverage'
import { ALL_RENDER_SHAPE_CATALOGS } from '@providers/registry.renderShapes'

// THE Phase 4 exit gate as a permanent CI test (PR #555): "the checked-in
// evidence corpus has zero unclassified fingerprints." Every distinctive
// structure in the 48-bundle corpus must be claimed by a provider catalog.
//
// When this fails after adding/refreshing a bundle: run
//   npx tsx --tsconfig tsconfig.web.json scripts/audit-rendering-shapes.mts --seed
// and land the printed entries in the owning provider's shapes.ts (a
// reviewed change — decide grouping and target grammar, don't paste
// blindly). When it fails after touching shapeFingerprint.ts: STOP — the
// algorithm is pinned by the catalogs (see the fp1 stability contract in
// that file); re-pinning every catalog is part of any algorithm change.

const BUNDLE_DIR = join(process.cwd(), 'testing', 'fixtures', 'rendering-bundles')

describe('render-shape catalog coverage (Phase 4 gate)', () => {
  const index = buildFingerprintIndex(ALL_RENDER_SHAPE_CATALOGS)

  it('catalogs themselves are structurally sound', () => {
    expect(auditRenderShapeCatalog(ALL_RENDER_SHAPE_CATALOGS)).toEqual([])
  })

  it('every fingerprint observed in the bundle corpus is catalogued', () => {
    const unclassified = new Map<string, { plane: string; eventType: string; paths: string }>()
    let observations = 0
    for (const file of readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.json'))) {
      const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, file), 'utf-8'))
      for (const obs of sweepBundleShapes(bundle)) {
        observations += 1
        const classification = classifySightingStructure(
          {
            structuralFingerprint: obs.fingerprint.fingerprint,
            lifecycle: obs.lifecycle,
          },
          index,
        )
        if (classification.kind === 'unknown-structure') {
          unclassified.set(`${obs.provider} ${obs.fingerprint.fingerprint}`, {
            plane: obs.plane,
            eventType: obs.eventType,
            paths: obs.fingerprint.shapePaths.slice(0, 8).join(' '),
          })
        }
      }
    }
    expect(observations).toBeGreaterThan(3000) // corpus sanity — a broken sweep must not vacuously pass
    expect(
      [...unclassified.entries()].map(([k, v]) => `${k} (${v.plane} ${v.eventType}) ${v.paths}`),
      'uncatalogued fingerprints — run the --seed audit and land entries in shapes.ts',
    ).toEqual([])
  })

  it('every catalogued fingerprint is claimed by exactly one entry', () => {
    expect([...index.duplicateFingerprints.entries()]).toEqual([])
  })
})
