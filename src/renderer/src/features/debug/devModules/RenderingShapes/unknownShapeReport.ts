import type { RenderShapeSighting } from '@shared/types/renderShapes'
import {
  classifySighting,
  type FingerprintIndex,
  type SightingClassification,
} from '@renderer/rendering/evidence/catalogCoverage'

// Unknown Shape Inbox report derivation — Phase 3 (PR #555).
//
// PURE by design: (raw sidecar sightings, compiled fingerprint index) →
// grouped report rows. No IPC, no fs, no React — the same derivation runs
// in the Dev Debug module (fed by render-shape:read-sightings), in
// scripts/audit-rendering-shapes.mjs (fed by direct disk reads), and in
// unit tests. One implementation means the CLI report and the panel can
// never disagree about what "unknown" means.
//
// DERIVED STATE, NOT A DATABASE (plan §Step 5): the inbox is recomputed
// from disk-backed recordings + checked-in catalogs on every open. It
// survives restart because the recordings do; there is nothing else to
// persist and therefore nothing to migrate or corrupt.

/** Severity order for a group's status — worst sighting wins the row.
 *  unknown-structure outranks everything (nothing owns it at all);
 *  unknown-outcome next (a catalogued shape VANISHED — the #469 class);
 *  then misrouted, unsupported lifecycle, and finally clean. */
const STATUS_RANK = {
  'unknown-structure': 0,
  'unknown-outcome': 1,
  'known-misrouted': 2,
  'known-unsupported-lifecycle': 3,
  'known-claimed': 4,
} as const

export type UnknownShapeReportRow = {
  structuralFingerprint: string
  provider: string
  planes: readonly string[]
  lifecycles: readonly string[]
  eventTypes: readonly string[]
  /** Sample of the structure the fingerprint denotes — from the first
   *  sighting; content-free by the sighting contract. */
  shapePaths: readonly string[]
  discriminatorValues: Readonly<Record<string, string>>
  firstSeenAt: number
  lastSeenAt: number
  totalCount: number
  /** Paint outcomes observed for this structure, by outcome kind. */
  outcomes: Readonly<Record<string, number>>
  /** Worst classification across the group's sightings. */
  status: SightingClassification['kind']
  /** Catalog id when the fingerprint is catalogued (any status). */
  catalogShapeId: string | null
}

export type UnknownShapeReport = {
  rows: readonly UnknownShapeReportRow[]
  /** Rows needing attention (status ≠ known-claimed), worst first. */
  inbox: readonly UnknownShapeReportRow[]
  totalSightings: number
  /** Sidecar lines that failed shape validation — nonzero means a schema
   *  drift between observer and reader, worth its own investigation. */
  invalidSightings: number
}

/** Trust-boundary validation: sidecar lines come off disk and cross IPC,
 *  so the reader proves the fields it uses rather than casting. */
function asSighting(value: unknown): RenderShapeSighting | null {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Partial<RenderShapeSighting>
  if (s.schemaVersion !== 1) return null
  if (typeof s.structuralFingerprint !== 'string') return null
  if (typeof s.provider !== 'string') return null
  if (typeof s.sourcePlane !== 'string') return null
  if (typeof s.lifecycle !== 'string') return null
  if (typeof s.eventType !== 'string') return null
  if (typeof s.outcome !== 'object' || s.outcome === null) return null
  return s as RenderShapeSighting
}

export function buildUnknownShapeReport(
  rawSightings: readonly unknown[],
  index: FingerprintIndex,
): UnknownShapeReport {
  type Group = {
    row: {
      structuralFingerprint: string
      provider: string
      planes: Set<string>
      lifecycles: Set<string>
      eventTypes: Set<string>
      shapePaths: readonly string[]
      discriminatorValues: Readonly<Record<string, string>>
      firstSeenAt: number
      lastSeenAt: number
      totalCount: number
      outcomes: Record<string, number>
      status: SightingClassification['kind']
      catalogShapeId: string | null
    }
  }
  const groups = new Map<string, Group['row']>()
  let invalid = 0
  let total = 0

  for (const raw of rawSightings) {
    const s = asSighting(raw)
    if (!s) {
      invalid += 1
      continue
    }
    const count = s.seenCount ?? 1
    total += count
    // Group by provider + fingerprint (NOT payload hash — plan §Step 5):
    // one structure = one inbox item regardless of how varied its content.
    const key = `${s.provider} ${s.structuralFingerprint}`
    const classification = classifySighting(
      {
        structuralFingerprint: s.structuralFingerprint,
        lifecycle: s.lifecycle,
        outcome: s.outcome,
      },
      index,
    )
    const catalogShapeId =
      classification.kind === 'unknown-structure' ? null : classification.shapeId
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        structuralFingerprint: s.structuralFingerprint,
        provider: s.provider,
        planes: new Set([s.sourcePlane]),
        lifecycles: new Set([s.lifecycle]),
        eventTypes: new Set([s.eventType]),
        shapePaths: s.shapePaths ?? [],
        discriminatorValues: s.discriminatorValues ?? {},
        firstSeenAt: s.observedAt,
        lastSeenAt: s.observedAt,
        totalCount: count,
        outcomes: { [s.outcome.kind]: count },
        status: classification.kind,
        catalogShapeId,
      })
      continue
    }
    existing.planes.add(s.sourcePlane)
    existing.lifecycles.add(s.lifecycle)
    existing.eventTypes.add(s.eventType)
    existing.firstSeenAt = Math.min(existing.firstSeenAt, s.observedAt)
    existing.lastSeenAt = Math.max(existing.lastSeenAt, s.observedAt)
    existing.totalCount += count
    existing.outcomes[s.outcome.kind] = (existing.outcomes[s.outcome.kind] ?? 0) + count
    if (STATUS_RANK[classification.kind] < STATUS_RANK[existing.status]) {
      existing.status = classification.kind
    }
    if (!existing.catalogShapeId && catalogShapeId) existing.catalogShapeId = catalogShapeId
  }

  const rows: UnknownShapeReportRow[] = [...groups.values()]
    .map(g => ({
      ...g,
      planes: [...g.planes].sort(),
      lifecycles: [...g.lifecycles].sort(),
      eventTypes: [...g.eventTypes].sort(),
    }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.totalCount - a.totalCount,
    )

  return {
    rows,
    inbox: rows.filter(r => r.status !== 'known-claimed'),
    totalSightings: total,
    invalidSightings: invalid,
  }
}
