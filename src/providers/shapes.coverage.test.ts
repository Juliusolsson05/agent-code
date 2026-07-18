import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  sweepBundleShapes,
  sweepCuratedShapeFixture,
} from '@renderer/rendering/evidence/bundleShapeSweep'
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
// algorithm is pinned by the catalogs (see the fp2 stability contract in
// that file); re-pinning every catalog is part of any algorithm change.

const BUNDLE_DIR = join(process.cwd(), 'testing', 'fixtures', 'rendering-bundles')
const FIXTURE_ROOT = join(process.cwd(), 'testing', 'fixtures')

describe('render-shape catalog coverage (Phase 4 gate)', () => {
  const index = buildFingerprintIndex(ALL_RENDER_SHAPE_CATALOGS)

  it('catalogs themselves are structurally sound', () => {
    expect(auditRenderShapeCatalog(ALL_RENDER_SHAPE_CATALOGS)).toEqual([])
  })

  it('every fingerprint observed in the bundle corpus is catalogued', () => {
    const unclassified = new Map<string, { plane: string; eventType: string; paths: string; status: string }>()
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
        // A known fingerprint at an undeclared lifecycle is just as uncovered
        // as an unknown fingerprint: the painter reached a milestone for which
        // the catalog promises no route. The old gate ignored this state and
        // therefore passed the exact streaming-prefix regression it was meant
        // to prevent.
        if (classification.kind !== 'known-structure') {
          unclassified.set(`${obs.provider} ${obs.fingerprint.fingerprint}`, {
            plane: obs.plane,
            eventType: obs.eventType,
            paths: obs.fingerprint.shapePaths.slice(0, 8).join(' '),
            status: classification.kind,
          })
        }
      }
    }
    expect(observations).toBeGreaterThan(3000) // corpus sanity — a broken sweep must not vacuously pass
    expect(
      [...unclassified.entries()].map(([k, v]) => `${k} (${v.status} ${v.plane} ${v.eventType}) ${v.paths}`),
      'uncatalogued fingerprints/lifecycles — run the --seed audit and land entries in shapes.ts',
    ).toEqual([])
  })

  it('every catalogued fingerprint is claimed by exactly one entry', () => {
    expect([...index.duplicateFingerprints.entries()]).toEqual([])
  })

  it('fixture references exist and bundle-backed claims match their declared shape', () => {
    const missing: string[] = []
    const unrelated: string[] = []
    for (const catalog of ALL_RENDER_SHAPE_CATALOGS) {
      for (const def of Object.values(catalog)) {
        const refs = [...def.fixtures.final, ...def.fixtures.prefixes]
        for (const ref of refs) {
          if (!existsSync(join(FIXTURE_ROOT, ref))) missing.push(`${def.id}: ${ref}`)
        }
        const bundleRefs = def.fixtures.final.filter(ref => ref.startsWith('rendering-bundles/'))
        // WHY inspect semantic contents, not merely existence: a broad bundle
        // can exist while containing none of the shape it supposedly proves,
        // making the specialized/absorbed fixture gate tautological.
        const matched = bundleRefs.some(ref => {
          const bundle = JSON.parse(readFileSync(join(FIXTURE_ROOT, ref), 'utf-8'))
          return sweepBundleShapes(bundle).some(obs =>
            obs.provider === def.provider &&
            def.planes.includes(obs.plane) &&
            def.eventTypes.includes(obs.eventType) &&
            def.fingerprints.includes(obs.fingerprint.fingerprint),
          )
        })
        if (bundleRefs.length > 0 && !matched) unrelated.push(def.id)

        const curatedRefs = refs.filter(ref => ref.startsWith('rendering-shapes/'))
        for (const ref of curatedRefs) {
          const fixturePath = join(FIXTURE_ROOT, ref)
          if (!existsSync(fixturePath)) continue
          const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))
          const observations = sweepCuratedShapeFixture(fixture, def.provider)
          // Curated files are narrow evidence claims, unlike broad session
          // bundles. Every referenced curated file must itself reproduce one
          // fingerprint/plane/event/lifecycle declared by this definition;
          // existence alone lets stale synthetic JSON bless any catalog id.
          const matches = observations.some(obs =>
            def.planes.includes(obs.plane) &&
            def.eventTypes.includes(obs.eventType) &&
            def.lifecycles.includes(obs.lifecycle) &&
            def.fingerprints.includes(obs.fingerprint.fingerprint),
          )
          if (!matches) unrelated.push(`${def.id}: ${ref}`)
        }
      }
    }
    expect(missing, 'catalog fixture paths that do not exist').toEqual([])
    expect(unrelated, 'catalog fixture claims with no matching fingerprinted observation').toEqual([])
  })
})
