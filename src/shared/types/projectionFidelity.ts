// What a provider switch, duplicate or rewind actually carried over (#927).
//
// WHY this exists: all three operations run the conversation through a REAL
// native-resume projector (agent-transcript-parser), which reports every
// entry it preserved, dropped, demoted, repaired or synthesized. Before #927
// the host wrote `projection.values` and threw `projection.report` away, so
// the only account a user or a caller ever saw was the switch's
// `shrinkSummary`. That describes context REDUCTION (the fit ladder) and is
// null whenever nothing had to be shrunk, even when the projection itself
// dropped content. Every recorded Codex sequence loses something in both
// directions, a Codex -> Codex duplicate included (opaque records). Two
// recorded Claude sequences (prompts, tool-cycle) lose nothing either way, so
// "lossless" is a real outcome too (#1384 review b corrected the first
// version of this sentence).
//
// WHY a curated summary and not the parser's report as-is: this crosses IPC
// and reaches pane toasts. `ProjectionChange.message` is projector prose, and
// `evidence` carries source claims. Neither belongs in user-visible text
// (q22/q39: curated, bounded). The `code` is a closed vocabulary
// (`native-resume.<entry>.<outcome>`) that identifies each change without
// either. Source line numbers are kept (they locate the change) but bounded,
// with the rest COUNTED, never silently dropped (#918 §6.2: shortening a
// summary must not delete the fidelity record).

export type ProjectionChangeKind =
  | 'preserved'
  | 'dropped'
  | 'demoted'
  | 'synthesized'
  | 'repaired'
  | 'retargeted'
  | 'opaque'

export type ProjectionFidelityCode = {
  kind: ProjectionChangeKind
  /** The projector's closed change code, e.g. `native-resume.opaque.dropped`. */
  code: string
  count: number
  /** Source line of each change, first `PROJECTION_FIDELITY_MAX_LINES` only. */
  sourceLines: number[]
}

export type NativeProjectionFidelity = {
  profile: 'native-resume'
  sourceProvider: string
  targetProvider: string
  /** The projector profile the guarantee is stated against. */
  providerProfileId: string
  providerEvidence: { sourceCommit?: string; cliVersion?: string; observedAt?: string }
  counts: Record<ProjectionChangeKind, number>
  /** One row per distinct (kind, code), in first-seen order. */
  codes: ProjectionFidelityCode[]
  /** Source lines beyond the per-code cap, counted rather than listed. */
  sourceLinesOmitted: number
}

export const PROJECTION_FIDELITY_MAX_LINES = 20

// Loss a user should be told about in the operation's toast.
//
// UNCONFIRMED product default (#927 plan): material = `dropped` changes other
// than opaque records, plus every `demoted` change.
// - Opaque records are the provider's non-conversation rows (telemetry,
//   environment and turn bookkeeping), dropped by every Codex projection
//   (1-30 per recorded case). Naming them on every switch would train users to
//   ignore the line.
// - Repairs fix shape (an input object, content blocks) without losing
//   content.
// - Synthesized framing is the target's own session and turn identity.
// All of those stay in the result for inspection; only the toast skips them.
const QUIET_DROP_CODES = new Set(['native-resume.opaque.dropped'])

export function materialProjectionLoss(fidelity: NativeProjectionFidelity | null | undefined): string | null {
  if (!fidelity) return null
  let dropped = 0
  let demoted = 0
  for (const row of fidelity.codes) {
    if (row.kind === 'dropped' && !QUIET_DROP_CODES.has(row.code)) dropped += row.count
    if (row.kind === 'demoted') demoted += row.count
  }
  const parts: string[] = []
  if (dropped > 0) parts.push(`${dropped} dropped`)
  if (demoted > 0) parts.push(`${demoted} demoted`)
  // UNCONFIRMED wording: "history: 12 dropped, 19 demoted".
  return parts.length > 0 ? `history: ${parts.join(', ')}` : null
}
