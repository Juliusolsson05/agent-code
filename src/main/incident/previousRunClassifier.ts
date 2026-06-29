import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INCIDENT_RUNS_DIR } from '@main/storage/paths.js'

// Prior-run classification (plan Phase 2).
//
// The most valuable moment to classify a crash is the NEXT launch: the previous
// process is gone, but the evidence it left — a missing clean-shutdown marker,
// crash incidents in its incidents.jsonl, a stale heartbeat — is still on disk.
// Waiting for the user to file a bug loses that causality.
//
// This runs synchronously at startup (one small directory scan + a couple of
// file reads) and is intentionally read-only: it must NEVER delete or rewrite
// previous-run evidence. The caller turns a non-clean result into an
// `app.prior_unclean_shutdown` incident on the CURRENT run.

export type PreviousRunClassification =
  | 'clean'
  | 'unclean_shutdown'
  | 'main_crash_suspected'
  | 'renderer_crash_suspected'
  | 'force_quit_or_power_loss'
  | 'unknown'

export type PreviousRunReport = {
  priorRunId: string
  priorRunDir: string
  classification: PreviousRunClassification
  hadCleanMarker: boolean
  evidence: Record<string, unknown>
}

const MAX_INCIDENT_LINES = 200

export function classifyPreviousRun(currentAppRunId: string): PreviousRunReport | null {
  let dirNames: string[]
  try {
    dirNames = readdirSync(INCIDENT_RUNS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== currentAppRunId)
      .map(entry => entry.name)
  } catch {
    // No incidents dir yet — first run ever, or it was pruned. Nothing to classify.
    return null
  }
  if (dirNames.length === 0) return null

  // Run-dir names are ISO-timestamp-prefixed (createAppRunId), so a lexical sort
  // is chronological. Take the most recent prior run.
  dirNames.sort()
  const priorRunId = dirNames[dirNames.length - 1]
  const priorRunDir = join(INCIDENT_RUNS_DIR, priorRunId)

  // A present clean-shutdown marker is the one unambiguous signal: the user (or
  // the OS quit sequence) ended that run cleanly.
  const hadCleanMarker = existsSync(join(priorRunDir, 'clean-shutdown'))
  if (hadCleanMarker) {
    return { priorRunId, priorRunDir, classification: 'clean', hadCleanMarker: true, evidence: {} }
  }

  // No marker → something other than a clean quit. Look for a recorded cause.
  const incidents = readJsonlTail(join(priorRunDir, 'incidents.jsonl'), MAX_INCIDENT_LINES)
  const kinds = new Set(incidents.map(incident => incident?.kind).filter(Boolean))

  let classification: PreviousRunClassification
  if (kinds.has('main.uncaught_exception')) {
    classification = 'main_crash_suspected'
  } else if (
    incidents.some(i => i?.kind === 'window.render_process_gone' && i?.severity === 'fatal')
  ) {
    classification = 'renderer_crash_suspected'
  } else {
    // No JS-level crash incident AND no clean marker. Either a NATIVE crash
    // (look for a Crashpad minidump separately), a force-quit/SIGKILL, or power
    // loss. A heartbeat proves the run was alive and writing; absent one we
    // genuinely can't tell. We can't distinguish force-quit from power-loss from
    // disk evidence alone, so collapse them into one honest bucket.
    const hadHeartbeat = existsSync(join(priorRunDir, 'heartbeat.json'))
    classification = hadHeartbeat ? 'force_quit_or_power_loss' : 'unknown'
  }

  return {
    priorRunId,
    priorRunDir,
    classification,
    hadCleanMarker: false,
    evidence: { incidentKinds: [...kinds] },
  }
}

function readJsonlTail(path: string, maxLines: number): Array<Record<string, unknown>> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const tail = lines.slice(-maxLines)
  const out: Array<Record<string, unknown>> = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // A torn final line is expected after an unclean exit — skip it.
    }
  }
  return out
}
