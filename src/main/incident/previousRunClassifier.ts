import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
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
  // Prior run died from a V8 fatal error (OOM abort, ineffective mark-compact,
  // "FATAL ERROR: Allocation failed"). Node.js writes a diagnostic report JSON
  // in the run directory when process.report.reportOnFatalError is enabled;
  // seeing that file promoted the crash from the generic force_quit_or_power_loss
  // fallback to a specific attribution. Motivation: 2026-07-04 crash (#388).
  | 'main_oom_suspected'
  | 'force_quit_or_power_loss'
  | 'unknown'

export type PreviousRunReport = {
  priorRunId: string
  priorRunDir: string
  classification: PreviousRunClassification
  hadCleanMarker: boolean
  evidence: Record<string, unknown>
}

export type ClassifyPreviousRunOptions = {
  // Crashpad directory (Electron app.getPath('crashDumps')). Its completed/ and
  // pending/ subdirs hold .dmp minidumps for NATIVE crashes (V8 OOM aborts,
  // SIGSEGV in a native addon) that never reach JS and so leave no incident.
  crashDumpsDir?: string
}

const MAX_INCIDENT_LINES = 200

export function classifyPreviousRun(
  currentAppRunId: string,
  options: ClassifyPreviousRunOptions = {},
): PreviousRunReport | null {
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
  let minidumpPath: string | undefined
  // Look for a Node.js diagnostic report first: process.report.reportOnFatalError
  // (enabled in AppRunJournal.start) writes report.<ts>.<pid>.<seq>.json into the
  // run directory when V8 aborts on a fatal error, and the "trigger" field
  // distinguishes OOM aborts from other fatal errors. That is more specific than
  // any downstream signal (JS incidents, minidumps), so it wins.
  const nodeReport = findNodeDiagnosticReport(priorRunDir)
  if (nodeReport?.trigger === 'OOMError' || nodeReport?.trigger === 'FatalError') {
    // Both triggers map to the same class in our vocabulary: the process was
    // terminated by V8 before JS could react. OOM is by far the common case; a
    // future observed non-OOM FatalError can be split out here if needed.
    classification = 'main_oom_suspected'
  } else if (kinds.has('main.uncaught_exception')) {
    classification = 'main_crash_suspected'
  } else if (
    incidents.some(i => i?.kind === 'window.render_process_gone' && i?.severity === 'fatal')
  ) {
    classification = 'renderer_crash_suspected'
  } else {
    // No JS-level crash incident and no clean marker. A NATIVE crash — a V8 OOM
    // abort or a SIGSEGV in a native addon — never reaches JS, so it leaves no
    // incident; but crashReporter/Crashpad writes a minidump. If one exists dated
    // within this run's lifetime, THAT is the cause: a native main crash, not a
    // force-quit. (This is the real case that motivated the change — a heap-OOM
    // abort was mislabeled `force_quit_or_power_loss` while its .dmp sat unused on
    // disk.) Only fall back to force-quit / power-loss when there is no minidump.
    //
    // Note: the Node diagnostic-report branch above is preferred, but on prior
    // runs from BEFORE the reportOnFatalError flag existed — or when V8 aborts
    // before Node writes the report — the minidump-only path still surfaces the
    // native crash so we don't regress.
    minidumpPath = findRecentMinidump(options.crashDumpsDir, readPriorStartedAt(priorRunDir))
    if (minidumpPath) {
      classification = 'main_crash_suspected'
    } else {
      const hadHeartbeat = existsSync(join(priorRunDir, 'heartbeat.json'))
      classification = hadHeartbeat ? 'force_quit_or_power_loss' : 'unknown'
    }
  }

  return {
    priorRunId,
    priorRunDir,
    classification,
    hadCleanMarker: false,
    evidence: {
      incidentKinds: [...kinds],
      // Point triage straight at the dump so a native crash is symbolicatable.
      ...(minidumpPath ? { native: true, minidumpPath } : {}),
      // Node diagnostic report path + trigger, when found — the JSON alongside
      // it holds heap statistics, native/JS stacks, and env info at the moment
      // of the abort. Callers surface these as evidence on the
      // app.prior_unclean_shutdown incident so triage can jump straight to it.
      ...(nodeReport
        ? { nodeReportPath: nodeReport.path, nodeReportTrigger: nodeReport.trigger }
        : {}),
    },
  }
}

// Locate the newest Node.js diagnostic report in the prior run's directory and
// return its path plus V8's classification of what triggered the abort.
//
// WHY only in the run directory (not a global scan): process.report.directory is
// set per-run in AppRunJournal.start(), so a fatal-error report is guaranteed to
// land alongside events.jsonl for THAT run. Restricting the search to the
// specific priorRunDir removes any risk of misattributing a report from a
// different run (or from a background utility process) to this classification.
//
// WHY only reads the `trigger` field: the report can be tens of megabytes of
// heap statistics + stacks. Parsing it fully during a synchronous startup scan
// would defeat the "cheap classifier" invariant. The trigger is a top-level
// string; JSON.parse on a bounded prefix is enough to read it. The full report
// stays on disk for triage tools to read at leisure.
function findNodeDiagnosticReport(
  priorRunDir: string,
): { path: string; trigger: string | undefined } | undefined {
  let candidates: string[]
  try {
    candidates = readdirSync(priorRunDir)
      .filter(name => name.startsWith('report.') && name.endsWith('.json'))
  } catch {
    return undefined
  }
  if (candidates.length === 0) return undefined
  // Report names contain an ISO-like timestamp so lexical sort ~= chronological.
  candidates.sort()
  const reportPath = join(priorRunDir, candidates[candidates.length - 1])
  return { path: reportPath, trigger: readNodeReportTrigger(reportPath) }
}

const MAX_REPORT_PREFIX_BYTES = 32 * 1024

function readNodeReportTrigger(reportPath: string): string | undefined {
  // Bounded prefix read — see findNodeDiagnosticReport comment above.
  let size: number
  try {
    size = statSync(reportPath).size
  } catch {
    return undefined
  }
  if (size === 0) return undefined
  const readBytes = Math.min(size, MAX_REPORT_PREFIX_BYTES)
  let text: string
  try {
    const fd = openSync(reportPath, 'r')
    try {
      const buf = Buffer.alloc(readBytes)
      readSync(fd, buf, 0, readBytes, 0)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  // Node writes trigger as a top-level string field: `"trigger": "OOMError"` etc.
  // A quick regex is safer than trying to close a truncated JSON object with a
  // real parser; if the prefix is malformed, we just return undefined.
  const match = /"trigger"\s*:\s*"([^"\\]+)"/.exec(text)
  return match?.[1]
}

function readPriorStartedAt(priorRunDir: string): number {
  try {
    const manifest = JSON.parse(
      readFileSync(join(priorRunDir, 'manifest.json'), 'utf8'),
    ) as { startedAt?: number }
    if (typeof manifest.startedAt === 'number') return manifest.startedAt
  } catch {
    // manifest missing/corrupt — fall back to the run dir's own mtime.
  }
  try {
    return statSync(priorRunDir).mtimeMs
  } catch {
    return 0
  }
}

// Find the newest Crashpad .dmp written within (or just after) the prior run's
// lifetime. Scans completed/ and pending/ (a fresh crash lands in pending until
// Crashpad finishes it). Returns undefined if none — read-only, never throws.
function findRecentMinidump(crashDumpsDir: string | undefined, sinceMs: number): string | undefined {
  if (!crashDumpsDir) return undefined
  let best: { path: string; mtimeMs: number } | undefined
  for (const sub of ['completed', 'pending']) {
    let names: string[]
    try {
      names = readdirSync(join(crashDumpsDir, sub)).filter(name => name.endsWith('.dmp'))
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(crashDumpsDir, sub, name)
      try {
        const mtimeMs = statSync(path).mtimeMs
        // 5s slop absorbs clock/mtime skew between the run's manifest timestamp
        // and when Crashpad flushed the dump.
        if (mtimeMs >= sinceMs - 5_000 && (!best || mtimeMs > best.mtimeMs)) {
          best = { path, mtimeMs }
        }
      } catch {
        // raced with Crashpad moving the file; skip.
      }
    }
  }
  return best?.path
}

const MAX_TAIL_BYTES = 256 * 1024

function readJsonlTail(path: string, maxLines: number): Array<Record<string, unknown>> {
  // Read only the trailing bytes, never the whole file. incidents.jsonl is capped
  // at 50 MiB per run, and this runs SYNCHRONOUSLY on the startup hot path — a
  // 50 MiB readFileSync + split here would block the next launch. The tail is all
  // the classifier needs (it slices the last maxLines anyway).
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return []
  }
  if (size === 0) return []
  let text: string
  try {
    if (size <= MAX_TAIL_BYTES) {
      text = readFileSync(path, 'utf8')
    } else {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(MAX_TAIL_BYTES)
        readSync(fd, buf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES)
        text = buf.toString('utf8')
        // Drop the partial leading line so the slice starts on a JSONL boundary.
        const firstNewline = text.indexOf('\n')
        if (firstNewline >= 0) text = text.slice(firstNewline + 1)
      } finally {
        closeSync(fd)
      }
    }
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
