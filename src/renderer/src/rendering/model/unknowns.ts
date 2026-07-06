import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderSourcePlane, UnknownBehavior } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Unknown-behavior registry (plan §3 contract).
//
// Unknown behavior is EVIDENCE, not an exception. Anything the pipeline
// does not recognize — a proxy event type without handling, a block kind
// with no render policy, a committed row that correlates with nothing —
// becomes a structured finding: logged, counted, fixture-able. Never a
// silent row, never a silent drop. `queued_for_implementation` is how
// future provider behavior gets discovered from a debug bundle instead of
// re-reading raw event archives (the dump's explicit design goal).
//
// Redaction (#115) is structural, not best-effort: the registry stores
// shape PATHS and a content HASH — never the payload. The optional preview
// must be passed pre-redacted by the caller and is hard-capped, so a
// mistake at a call site cannot leak a full prompt into feed-debug or a
// bundle. Auth-looking keys are stripped from shape paths as a second
// belt: even the KEY NAMES of secrets should not advertise their presence.
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 80
const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|cookie|password/i

/** Deterministic, dependency-free FNV-1a — identity for dedupe/counting,
 *  NOT cryptographic. Collisions merely merge two counters. */
export function hashPayload(payload: unknown): string {
  let json: string
  try {
    json = JSON.stringify(payload) ?? 'undefined'
  } catch {
    json = 'unserializable'
  }
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Sorted key paths to depth 3 — enough to recognize a shape in a bundle
 *  without carrying any values. */
export function shapePathsOf(payload: unknown, prefix = '', depth = 0): string[] {
  if (depth >= 3 || typeof payload !== 'object' || payload === null) return []
  const out: string[] = []
  for (const key of Object.keys(payload as Record<string, unknown>).sort()) {
    if (SENSITIVE_KEY.test(key)) {
      out.push(`${prefix}${key}=<redacted-key>`)
      continue
    }
    const path = `${prefix}${key}`
    out.push(path)
    out.push(...shapePathsOf((payload as Record<string, unknown>)[key], `${path}.`, depth + 1))
  }
  return out
}

export type UnknownSighting = {
  provider: AgentProviderKind | 'unknown'
  sourcePlane: RenderSourcePlane
  eventType?: string
  payload: unknown
  /** Caller-redacted; hard-capped here regardless. */
  redactedPreview?: string
  disposition: UnknownBehavior['disposition']
  evidence?: string[]
  nowMs: number
}

/**
 * Per-session registry, deduping by (plane, eventType, payload hash) —
 * a flood of identical unknown events becomes ONE finding with a count,
 * which is what makes unknowns readable in a bundle instead of noise
 * (the same rollup lesson as feed-debug text-delta batching).
 */
export function createUnknownRegistry(): {
  record: (s: UnknownSighting) => UnknownBehavior
  list: () => readonly UnknownBehavior[]
} {
  const byId = new Map<string, UnknownBehavior>()
  return {
    record(s) {
      const payloadHash = hashPayload(s.payload)
      const id = `unknown:${s.sourcePlane}:${s.eventType ?? 'untyped'}:${payloadHash}`
      const existing = byId.get(id)
      if (existing) {
        const bumped: UnknownBehavior = { ...existing, seenCount: existing.seenCount + 1 }
        byId.set(id, bumped)
        return bumped
      }
      const fresh: UnknownBehavior = {
        id,
        provider: s.provider,
        sourcePlane: s.sourcePlane,
        eventType: s.eventType,
        shapePaths: shapePathsOf(s.payload),
        payloadHash,
        redactedPreview: s.redactedPreview?.slice(0, PREVIEW_MAX),
        firstSeenAt: s.nowMs,
        seenCount: 1,
        disposition: s.disposition,
        evidence: s.evidence ?? [],
      }
      byId.set(id, fresh)
      return fresh
    },
    list() {
      return [...byId.values()]
    },
  }
}
