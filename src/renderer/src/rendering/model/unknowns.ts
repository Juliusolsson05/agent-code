import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderSourcePlane, UnknownBehavior } from '@renderer/rendering/model/types'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'

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
// bundle. Auth-looking keys are redacted IN PLACE in the shape paths as a
// second belt: the KEY NAME is retained (so a bundle reader still sees the
// structural shape — that a secret-carrying key was present at this path),
// but its VALUE/subtree is never walked and is replaced with a
// `<redacted-key>` marker. Keeping the name while dropping the value is what
// makes the path diagnostic without ever carrying the secret itself; the
// earlier wording claimed key NAMES were stripped, which the code has never
// done (see `shapePathsOf`).
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 80
// Historical home of the SINGLE source-of-truth secret-key regex. The
// definition moved to ./sensitiveKey.ts (Phase 1, evidence-first rendering
// plan) so the structural fingerprint helper and this registry can both use
// it without a circular import — see that file's header. Re-exported here so
// rendering/replay/redact.ts and scripts/audit-sensitive-core.mts keep their
// documented import path; it is still the same one regex everywhere.
import { SENSITIVE_KEY } from '@renderer/rendering/model/sensitiveKey'
export { SENSITIVE_KEY }

/**
 * How many distinct payload-hash samples one finding retains. Samples are
 * DIAGNOSTIC (they prove "n different payloads shared this structure" and
 * seed extraction), never identity — so a small bound is enough and an
 * unbounded list would grow with content churn, exactly the flood the
 * fingerprint re-key exists to stop.
 */
const PAYLOAD_HASH_SAMPLES_MAX = 8
/**
 * Saturation bound for the distinct-hash COUNTER. Tracking every distinct
 * hash forever is an unbounded Set per finding (a long session piping
 * varied commands through one unknown shape would grow it indefinitely);
 * past this bound `distinctPayloadHashes` simply stops incrementing.
 * "At least 64 variants" is all the diagnosis ever needs.
 */
const DISTINCT_HASH_TRACK_MAX = 64

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
 * Per-session registry, deduping by (plane, eventType, STRUCTURAL
 * fingerprint) — a flood of identical unknown events becomes ONE finding
 * with a count, which is what makes unknowns readable in a bundle instead
 * of noise (the same rollup lesson as feed-debug text-delta batching).
 *
 * RE-KEYED 2026-07-16 (Phase 1, evidence-first rendering plan): identity was
 * previously the content-sensitive payload hash, which split ONE structure
 * into a new finding per distinct command/prompt — `Bash ls` and
 * `Bash git status` read as two unknowns, so a busy session drowned the
 * registry in duplicates of the same missing decoder. The structural
 * fingerprint groups them into one finding; the payload hash demotes to a
 * bounded per-finding SAMPLE list, still useful to prove "this structure
 * arrived with many different contents" and to seed fixture extraction, but
 * never identity again.
 */
export function createUnknownRegistry(): {
  record: (s: UnknownSighting) => UnknownBehavior
  list: () => readonly UnknownBehavior[]
} {
  const byId = new Map<string, UnknownBehavior>()
  // Distinct-hash tracking lives OUTSIDE the published record: the Set is
  // bookkeeping, and leaking it into UnknownBehavior would make every bump
  // serialize an ever-growing structure into debug bundles.
  const hashesById = new Map<string, Set<string>>()
  return {
    record(s) {
      const payloadHash = hashPayload(s.payload)
      const { fingerprint } = fingerprintRenderShape({
        provider: s.provider,
        plane: s.sourcePlane,
        eventType: s.eventType ?? 'untyped',
        payload: s.payload,
      })
      const id = `unknown:${s.sourcePlane}:${s.eventType ?? 'untyped'}:${fingerprint}`
      const existing = byId.get(id)
      if (existing) {
        const hashes = hashesById.get(id)!
        if (hashes.size < DISTINCT_HASH_TRACK_MAX) hashes.add(payloadHash)
        const bumped: UnknownBehavior = {
          ...existing,
          seenCount: existing.seenCount + 1,
          distinctPayloadHashes: hashes.size,
          payloadHashSamples:
            existing.payloadHashSamples.length < PAYLOAD_HASH_SAMPLES_MAX &&
            !existing.payloadHashSamples.includes(payloadHash)
              ? [...existing.payloadHashSamples, payloadHash]
              : existing.payloadHashSamples,
        }
        byId.set(id, bumped)
        return bumped
      }
      const fresh: UnknownBehavior = {
        id,
        provider: s.provider,
        sourcePlane: s.sourcePlane,
        eventType: s.eventType,
        structuralFingerprint: fingerprint,
        shapePaths: shapePathsOf(s.payload),
        payloadHash,
        payloadHashSamples: [payloadHash],
        distinctPayloadHashes: 1,
        redactedPreview: s.redactedPreview?.slice(0, PREVIEW_MAX),
        firstSeenAt: s.nowMs,
        seenCount: 1,
        disposition: s.disposition,
        evidence: s.evidence ?? [],
      }
      byId.set(id, fresh)
      hashesById.set(id, new Set([payloadHash]))
      return fresh
    },
    list() {
      return [...byId.values()]
    },
  }
}
