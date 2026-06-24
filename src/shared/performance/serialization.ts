import type { PerformanceRecord } from '@shared/performance/types.js'

// Shared performance-telemetry serialization.
//
// WHY shared: main (`PerformanceService`) and renderer (`performance/client`)
// each had a byte-identical `serializeError` + `sanitizeData`, and an
// `areaFromName` that differed ONLY in its fallback string. The sanitizer is a
// PRIVACY control — it drops prompt/content/token/secret/key fields when not
// verbose. Two copies meant the same event could be redacted in one process and
// over-retained in the other if one copy drifted. Centralizing makes the
// redaction rule single-sourced.
//
// INVARIANTS (must not change without a deliberate privacy review):
//   - sensitive-key regex stays /prompt|content|text|env|token|secret|key/i
//   - non-verbose string truncation stays 300 chars + '...'
//   - verbose string truncation stays 2000 chars + '...'
//   - the per-process area fallback ('app' for main, 'renderer' for renderer)
//     stays a CALLER-supplied parameter — it is intentionally process-specific.
//
// This module must remain Node- and DOM-free so both bundles can import it.

const SENSITIVE_KEY_RE = /prompt|content|text|env|token|secret|key/i

/** Normalize any thrown value into the structured record error shape. */
export function serializePerformanceError(error: unknown): PerformanceRecord['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

/**
 * Redact sensitive keys (unless verbose) and truncate long strings. Returns a
 * shallow copy; non-string values pass through untouched.
 */
export function sanitizePerformanceData(
  data: Record<string, unknown> | undefined,
  opts: { verbose: boolean },
): Record<string, unknown> | undefined {
  if (!data) return undefined
  const limit = opts.verbose ? 2000 : 300
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!opts.verbose && SENSITIVE_KEY_RE.test(key)) continue
    if (typeof value === 'string' && value.length > limit) {
      out[key] = `${value.slice(0, limit)}...`
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Derive the coarse `area` ("a.b") from a dotted metric/span name. `fallback`
 * is process-specific ('app' in main, 'renderer' in the renderer) — callers
 * pass it so the shared rule doesn't bake in one process's identity.
 */
export function areaFromPerformanceName(name: string, fallback: string): string {
  const parts = name.split('.')
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] || fallback
}
