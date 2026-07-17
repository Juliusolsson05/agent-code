import type {
  RenderOutcome,
  RenderShapeDisposition,
  RenderShapeLifecycle,
} from '@shared/types/renderShapes'
import type { RenderShapeDefinition } from '@renderer/rendering/evidence/defineRenderShape'

// ---------------------------------------------------------------------------
// Catalog coverage: the pure comparison layer between what was OBSERVED
// (sightings) and what is PROMISED (checked-in catalogs). Phase 1 ships the
// helpers + tests only; the Phase 2 observer and Phase 3 inbox/audit script
// consume them unchanged — keeping this pure (no IPC, no fs, no React) is
// what lets the same classification run in the renderer, in the audit
// script, and in unit tests without three re-implementations drifting.
//
// The five classifications mirror plan §Step 4 exactly. Only the first is
// "fine"; the other four are inbox states. The distinction between
// `known-misrouted` and `unknown-outcome` matters operationally: misrouted
// means the catalog promised a specific renderer and something else painted
// it (a routing bug); unknown-outcome means a catalogued shape vanished or
// was absorbed by an undeclared owner (a visibility bug — the #469 class).
// ---------------------------------------------------------------------------

export type SightingClassification =
  | { kind: 'known-claimed'; shapeId: string }
  | { kind: 'known-misrouted'; shapeId: string; expected: RenderShapeDisposition; actual: RenderOutcome }
  | { kind: 'known-unsupported-lifecycle'; shapeId: string; lifecycle: RenderShapeLifecycle }
  | { kind: 'unknown-structure'; structuralFingerprint: string }
  | { kind: 'unknown-outcome'; shapeId: string; actual: RenderOutcome }

/** Minimal slice of a sighting the classifier needs — accepting the full
 *  RenderShapeSighting would couple this pure layer to IPC-era fields it
 *  never reads. */
export type ClassifiableSighting = {
  structuralFingerprint: string
  lifecycle: RenderShapeLifecycle
  outcome: RenderOutcome
}

export type StructureSightingClassification =
  | { kind: 'known-structure'; shapeId: string }
  | { kind: 'known-unsupported-lifecycle'; shapeId: string; lifecycle: RenderShapeLifecycle }
  | { kind: 'unknown-structure'; structuralFingerprint: string }

export type ClassifiableStructureSighting = Omit<ClassifiableSighting, 'outcome'>

export type FingerprintIndex = {
  byFingerprint: ReadonlyMap<string, RenderShapeDefinition>
  /** Fingerprints claimed by MORE than one catalog entry — always a catalog
   *  bug (two entries would race for the same observation), surfaced here so
   *  the coverage test can fail loudly instead of classification being
   *  order-dependent. */
  duplicateFingerprints: ReadonlyMap<string, readonly string[]>
}

export function buildFingerprintIndex(
  catalogs: readonly Readonly<Record<string, RenderShapeDefinition>>[],
): FingerprintIndex {
  const byFingerprint = new Map<string, RenderShapeDefinition>()
  const claims = new Map<string, string[]>()
  for (const catalog of catalogs) {
    for (const def of Object.values(catalog)) {
      for (const fp of def.fingerprints) {
        const owners = claims.get(fp) ?? []
        owners.push(def.id)
        claims.set(fp, owners)
        // First claim wins in the index; duplicates are reported, not
        // silently overwritten — deterministic either way because catalog
        // iteration order is source order.
        if (!byFingerprint.has(fp)) byFingerprint.set(fp, def)
      }
    }
  }
  const duplicateFingerprints = new Map<string, readonly string[]>()
  for (const [fp, owners] of claims) {
    if (owners.length > 1) duplicateFingerprints.set(fp, owners)
  }
  return { byFingerprint, duplicateFingerprints }
}

/**
 * Does the observed paint outcome satisfy the catalogued promise?
 *
 * Deliberately CONSERVATIVE: a disposition/outcome pair not explicitly
 * listed here is a mismatch. Failing closed means a new disposition kind
 * added without updating this table shows up as misrouted sightings in the
 * inbox (annoying, visible) rather than silently passing (invisible, the
 * exact forgetting this system exists to prevent).
 */
export function outcomeSatisfiesDisposition(
  disposition: RenderShapeDisposition,
  outcome: RenderOutcome,
): boolean {
  switch (disposition.kind) {
    case 'specialized':
      return outcome.kind === 'specialized' &&
        outcome.rendererId === disposition.rendererId &&
        (outcome.protocolId ?? null) === (disposition.protocolId ?? null)
    case 'generic':
      return outcome.kind === 'generic'
    case 'absorbed':
      // The absorbing owner must be the DECLARED owner. An absorption by
      // anyone else is exactly the undeclared-hiding case (§Step 6 calls
      // hiding the most dangerous operation in the renderer).
      return outcome.kind === 'absorbed' &&
        outcome.ownerRenderId === disposition.ownerRendererId &&
        (outcome.protocolId ?? null) === (disposition.protocolId ?? null)
    case 'condition-surface':
      return outcome.kind === 'condition-surface' && outcome.surface === disposition.surface
    case 'planned':
      // Planned is outstanding implementation work, never permission for any
      // current route to masquerade as correct. Phase 10's exit gate is zero
      // planned catalog entries.
      return false
    case 'unsupported':
      // Unsupported means "visible through the total fallback", not "may be
      // hidden or claimed by any renderer".
      return outcome.kind === 'generic'
  }
}

export function classifySighting(
  sighting: ClassifiableSighting,
  index: FingerprintIndex,
): SightingClassification {
  const structure = classifySightingStructure(sighting, index)
  if (structure.kind === 'unknown-structure') return structure
  if (structure.kind === 'known-unsupported-lifecycle') return structure
  // `known-structure` guarantees this lookup. Keeping structure-only
  // classification as a public helper lets pre-receipt corpora prove catalog
  // coverage without fabricating a paint outcome; the full runtime path still
  // continues here and verifies the actual owner.
  const def = index.byFingerprint.get(sighting.structuralFingerprint)!
  const expectedDisposition = def.dispositionByLifecycle?.[sighting.lifecycle] ?? def.disposition
  if (sighting.outcome.kind === 'unknown') {
    return { kind: 'unknown-outcome', shapeId: def.id, actual: sighting.outcome }
  }
  const alternates = def.alternateDispositionsByLifecycle?.[sighting.lifecycle]
    ?? def.alternateDispositions
    ?? []
  const shapeMatches = sighting.outcome.shapeId === def.id
  const routeMatches = [expectedDisposition, ...alternates].some(disposition =>
    outcomeSatisfiesDisposition(disposition, sighting.outcome),
  )
  if (!shapeMatches || !routeMatches) {
    return {
      kind: 'known-misrouted',
      shapeId: def.id,
      expected: expectedDisposition,
      actual: sighting.outcome,
    }
  }
  return { kind: 'known-claimed', shapeId: def.id }
}

/**
 * Classify only facts an evidence source actually contains.
 *
 * Frozen rendering bundles predate outcome receipts. Treating their missing
 * outcome as `shared.generic-tool` made every later catalog graduation appear
 * misrouted even though the bundle never observed a renderer at all. This
 * helper deliberately stops after fingerprint + lifecycle and must not be used
 * for live sightings, which always have an outcome and require classifySighting.
 */
export function classifySightingStructure(
  sighting: ClassifiableStructureSighting,
  index: FingerprintIndex,
): StructureSightingClassification {
  const def = index.byFingerprint.get(sighting.structuralFingerprint)
  if (!def) {
    return { kind: 'unknown-structure', structuralFingerprint: sighting.structuralFingerprint }
  }
  if (!def.lifecycles.includes(sighting.lifecycle)) {
    // The final shape is catalogued but THIS milestone has no declared
    // behavior — the "streaming prefix nobody thought about" class that
    // regressed PR #524 repeatedly.
    return { kind: 'known-unsupported-lifecycle', shapeId: def.id, lifecycle: sighting.lifecycle }
  }
  return { kind: 'known-structure', shapeId: def.id }
}

export type CatalogAuditFinding =
  | { kind: 'specialized-without-fixture'; shapeId: string }
  | { kind: 'absorbed-without-fixture'; shapeId: string }
  | { kind: 'planned-shape'; shapeId: string }
  | { kind: 'empty-fingerprints'; shapeId: string }
  | { kind: 'malformed-fingerprint'; shapeId: string; fingerprint: string }
  | { kind: 'duplicate-fingerprint'; fingerprint: string; shapeIds: readonly string[] }

/**
 * Structural audit of catalog entries themselves — the invariants the type
 * system cannot express. Run by the coverage test (Phase 1) and by
 * scripts/audit-rendering-shapes.mjs (Phase 3) so CI and the CLI report
 * cannot disagree about what a healthy catalog is.
 *
 * Every declared route is audited, including lifecycle overrides and finite
 * alternates. Auditing only the primary disposition let an unfixture-backed
 * absorption hide in an alternate while CI still called the shape healthy.
 * `planned` remains valid while drafting a catalog edit, but it is always a
 * finding: the shipping Phase 10 gate requires zero unfinished promises.
 */
export function auditRenderShapeCatalog(
  catalogs: readonly Readonly<Record<string, RenderShapeDefinition>>[],
): readonly CatalogAuditFinding[] {
  const findings: CatalogAuditFinding[] = []
  for (const catalog of catalogs) {
    for (const def of Object.values(catalog)) {
      if (def.fingerprints.length === 0) {
        findings.push({ kind: 'empty-fingerprints', shapeId: def.id })
      }
      for (const fp of def.fingerprints) {
        if (!/^fp2-[0-9a-f]{8}$/.test(fp)) {
          findings.push({ kind: 'malformed-fingerprint', shapeId: def.id, fingerprint: fp })
        }
      }
      const routes = [
        def.disposition,
        ...Object.values(def.dispositionByLifecycle ?? {}).filter((route): route is RenderShapeDisposition => Boolean(route)),
        ...(def.alternateDispositions ?? []),
        ...Object.values(def.alternateDispositionsByLifecycle ?? {}).flatMap(routes => routes ?? []),
      ]
      const hasFixture = def.fixtures.final.length > 0 || def.fixtures.prefixes.length > 0
      if (routes.some(route => route.kind === 'planned')) {
        findings.push({ kind: 'planned-shape', shapeId: def.id })
      }
      if (routes.some(route => route.kind === 'specialized') && !hasFixture) {
        findings.push({ kind: 'specialized-without-fixture', shapeId: def.id })
      }
      if (routes.some(route => route.kind === 'absorbed') && !hasFixture) {
        findings.push({ kind: 'absorbed-without-fixture', shapeId: def.id })
      }
    }
  }
  const { duplicateFingerprints } = buildFingerprintIndex(catalogs)
  for (const [fingerprint, shapeIds] of duplicateFingerprints) {
    findings.push({ kind: 'duplicate-fingerprint', fingerprint, shapeIds })
  }
  return findings
}
