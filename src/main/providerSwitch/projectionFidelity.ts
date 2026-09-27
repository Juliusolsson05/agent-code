import type { NativeResumeProjectionResult } from 'agent-transcript-parser'

import {
  PROJECTION_FIDELITY_MAX_LINES,
  type NativeProjectionFidelity,
  type ProjectionFidelityCode,
} from '@shared/types/projectionFidelity.js'

/**
 * The bounded, curated summary of a real native-resume projection (#927).
 *
 * Called right after `projectNativeResume` and before `write`, so every
 * caller holds the summary even when publication fails afterwards. Pure: it
 * reads the report and copies what it keeps, so a later reuse of the
 * projector's objects cannot change a summary already handed out (#918 §6.2).
 * See `@shared/types/projectionFidelity` for why messages and evidence are
 * left out.
 */
export function summarizeProjectionReport(projection: NativeResumeProjectionResult): NativeProjectionFidelity {
  const { report, providerProfile } = projection
  const rows = new Map<string, ProjectionFidelityCode>()
  let sourceLinesOmitted = 0
  for (const change of report.changes) {
    const key = `${change.kind}\u0000${change.code}`
    let row = rows.get(key)
    if (!row) {
      row = { kind: change.kind, code: change.code, count: 0, sourceLines: [] }
      rows.set(key, row)
    }
    row.count += 1
    if (change.sourceLine === null) continue
    if (row.sourceLines.length < PROJECTION_FIDELITY_MAX_LINES) row.sourceLines.push(change.sourceLine)
    else sourceLinesOmitted += 1
  }
  const evidence = providerProfile.evidence
  return {
    profile: 'native-resume',
    sourceProvider: report.sourceProvider,
    targetProvider: report.targetProvider,
    providerProfileId: providerProfile.id,
    providerEvidence: {
      ...(evidence.sourceCommit ? { sourceCommit: evidence.sourceCommit } : {}),
      ...(evidence.cliVersion ? { cliVersion: evidence.cliVersion } : {}),
      ...(evidence.observedAt ? { observedAt: evidence.observedAt } : {}),
    },
    counts: { ...report.counts },
    codes: [...rows.values()],
    sourceLinesOmitted,
  }
}
