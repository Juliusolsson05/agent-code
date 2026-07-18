import type { RenderOutcome, RenderShapeSighting } from '@shared/types/renderShapes'
import {
  RENDER_SHAPE_LIFECYCLES,
  RENDER_SHAPE_PLANES,
  renderOutcomeRouteIdentity,
  renderShapeWriterKey,
} from '@shared/types/renderShapes'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'
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
// scripts/audit-rendering-shapes.mts (fed by direct disk reads), and in
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
   *  sighting. Literal keys are retained; scalar values are not copied. */
  shapePaths: readonly string[]
  discriminatorValues: Readonly<Record<string, string>>
  firstSeenAt: number
  lastSeenAt: number
  totalCount: number
  /** Paint outcomes observed for this structure, by outcome kind. */
  outcomes: Readonly<Record<string, number>>
  /** Exact renderer/owner/surface routes. Outcome kind alone erases the
   *  difference between a correct specialized renderer and a misroute. */
  routes: Readonly<Record<string, number>>
  /** Worst classification across the group's sightings. */
  status: SightingClassification['kind']
  /** Catalog id when the fingerprint is catalogued (any status). */
  catalogShapeId: string | null
  /** Source recording ids (injected by the sidecar sweep) — the plan
   *  §Step 5 traceability link back to the evidence on disk. */
  recordings: readonly string[]
}

export type UnknownShapeReport = {
  rows: readonly UnknownShapeReportRow[]
  /** Rows needing attention (status ≠ known-claimed), worst first. */
  inbox: readonly UnknownShapeReportRow[]
  totalSightings: number
  /** Sidecar lines that failed shape validation — nonzero means a schema
   *  drift between observer and reader, worth its own investigation. */
  invalidSightings: number
  /** Intentionally rejected prerelease records. These are recapture debt, not
   * malformed current-writer output, so the UI reports them separately. */
  legacySightings: number
  /** Non-v1 records that fail the current trust-boundary contract, including
   * malformed v2 writer output and unknown schema versions. */
  malformedSightings: number
}

/** Trust-boundary validation: sidecar lines come off disk and cross IPC,
 *  so the reader proves the fields it uses rather than casting. */
function asRenderOutcome(value: unknown): RenderOutcome | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const outcome = value as Record<string, unknown>
  const hasShapeId = outcome.shapeId === null || typeof outcome.shapeId === 'string'
  const hasOnlyKeys = (...allowed: string[]): boolean => {
    const keys = Object.keys(outcome)
    return keys.length === allowed.length && keys.every(key => allowed.includes(key))
  }
  switch (outcome.kind) {
    case 'specialized':
      return hasShapeId && typeof outcome.rendererId === 'string' &&
        (outcome.protocolId === undefined || typeof outcome.protocolId === 'string') &&
        hasOnlyKeys('kind', 'rendererId', 'shapeId', ...(outcome.protocolId === undefined ? [] : ['protocolId']))
        ? value as RenderOutcome
        : null
    case 'generic':
      return hasShapeId && outcome.rendererId === 'shared.generic-tool' &&
        hasOnlyKeys('kind', 'rendererId', 'shapeId')
        ? value as RenderOutcome
        : null
    case 'absorbed':
      return hasShapeId && typeof outcome.ownerRenderId === 'string' &&
        typeof outcome.reason === 'string' &&
        (outcome.protocolId === undefined || typeof outcome.protocolId === 'string') &&
        hasOnlyKeys('kind', 'ownerRenderId', 'reason', 'shapeId', ...(outcome.protocolId === undefined ? [] : ['protocolId']))
        ? value as RenderOutcome
        : null
    case 'condition-surface':
      return hasShapeId &&
        ['outlet', 'feed-inline', 'composer', 'attention-only'].includes(String(outcome.surface)) &&
        hasOnlyKeys('kind', 'surface', 'shapeId')
        ? value as RenderOutcome
        : null
    case 'unknown':
      return typeof outcome.fallbackRenderId === 'string' &&
        hasOnlyKeys('kind', 'fallbackRenderId')
        ? value as RenderOutcome
        : null
    default:
      // This closed check is load-bearing: renderOutcomeRouteIdentity assumes
      // an exhaustive union. Letting an arbitrary disk value through can
      // produce undefined route keys and make malformed v2 evidence look like
      // a valid clean row.
      return null
  }
}

type SightingParse =
  | { kind: 'valid'; sighting: RenderShapeSighting & { sourceRecordingId?: string } }
  | { kind: 'legacy' }
  | { kind: 'malformed' }

function asSighting(value: unknown): SightingParse {
  if (typeof value !== 'object' || value === null) return { kind: 'malformed' }
  const s = value as Partial<RenderShapeSighting>
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion
  // v1 was the prerelease painter-era contract where shapeId was absent or a
  // renderer id. Accepting it would manufacture thousands of false misroutes
  // beside v2 receipts, so the cutover is intentionally strict: recapture.
  if (schemaVersion === 1) return { kind: 'legacy' }
  if (schemaVersion !== 2) return { kind: 'malformed' }
  if (typeof s.structuralFingerprint !== 'string') return { kind: 'malformed' }
  if (
    typeof s.provider !== 'string' ||
    (s.provider !== 'unknown' && !(AGENT_PROVIDER_KINDS as readonly string[]).includes(s.provider))
  ) return { kind: 'malformed' }
  if (
    typeof s.sourcePlane !== 'string' ||
    !(RENDER_SHAPE_PLANES as readonly string[]).includes(s.sourcePlane)
  ) return { kind: 'malformed' }
  if (
    typeof s.lifecycle !== 'string' ||
    !(RENDER_SHAPE_LIFECYCLES as readonly string[]).includes(s.lifecycle)
  ) return { kind: 'malformed' }
  if (typeof s.eventType !== 'string') return { kind: 'malformed' }
  const outcome = asRenderOutcome(s.outcome)
  if (!outcome) return { kind: 'malformed' }
  if (typeof s.seenCount !== 'number' || !Number.isFinite(s.seenCount) || s.seenCount < 1) return { kind: 'malformed' }
  // A non-number observedAt would poison Math.min/max into NaN downstream.
  if (typeof s.observedAt !== 'number' || !Number.isFinite(s.observedAt)) return { kind: 'malformed' }
  if (s.shapePaths !== undefined && (
    !Array.isArray(s.shapePaths) || s.shapePaths.some(path => typeof path !== 'string')
  )) return { kind: 'malformed' }
  const recordingId = (s as { sourceRecordingId?: unknown }).sourceRecordingId
  if (recordingId !== undefined && typeof recordingId !== 'string') return { kind: 'malformed' }
  return {
    kind: 'valid',
    sighting: { ...s, outcome } as RenderShapeSighting & { sourceRecordingId?: string },
  }
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
      routes: Record<string, number>
      recordings: Set<string>
      status: SightingClassification['kind']
      catalogShapeId: string | null
    }
  }
  const groups = new Map<string, Group['row']>()
  // Writer contract (observer.ts): a dedup key's FIRST sight lands as one
  // line (count 1 implied) and the disarm flush re-emits the key with the
  // cumulative seenCount. Summing both lines double-counts (review
  // finding: 5,000 observations reported as 5,001) — so counts aggregate
  // as MAX per writer dedup key, then sum across keys.
  const countsByWriterKey = new Map<string, number>()
  let legacy = 0
  let malformed = 0

  for (const raw of rawSightings) {
    const parsed = asSighting(raw)
    if (parsed.kind === 'legacy') {
      legacy += 1
      continue
    }
    if (parsed.kind === 'malformed') {
      malformed += 1
      continue
    }
    const s = parsed.sighting
    const count = s.seenCount
    const writerKey = renderShapeWriterKey(s, s.sourceRecordingId ?? '')
    const prev = countsByWriterKey.get(writerKey) ?? 0
    const delta = Math.max(0, count - prev)
    countsByWriterKey.set(writerKey, Math.max(prev, count))
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
        totalCount: delta,
        outcomes: { [s.outcome.kind]: delta },
        routes: { [renderOutcomeRouteIdentity(s.outcome)]: delta },
        recordings: new Set(s.sourceRecordingId ? [s.sourceRecordingId] : []),
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
    existing.totalCount += delta
    existing.outcomes[s.outcome.kind] = (existing.outcomes[s.outcome.kind] ?? 0) + delta
    const route = renderOutcomeRouteIdentity(s.outcome)
    existing.routes[route] = (existing.routes[route] ?? 0) + delta
    if (s.sourceRecordingId) existing.recordings.add(s.sourceRecordingId)
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
      recordings: [...g.recordings].sort(),
    }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.totalCount - a.totalCount,
    )

  return {
    rows,
    inbox: rows.filter(r => r.status !== 'known-claimed'),
    totalSightings: [...countsByWriterKey.values()].reduce((n, c) => n + c, 0),
    invalidSightings: legacy + malformed,
    legacySightings: legacy,
    malformedSightings: malformed,
  }
}
