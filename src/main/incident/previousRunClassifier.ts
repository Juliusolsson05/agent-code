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

// Version of THIS classifier's decision procedure, stamped into every
// PreviousRunReport (and from there into the app.prior_unclean_shutdown
// incident context) and into each run's manifest.json. WHY: incident artifacts
// outlive the code that produced them — the #374 investigation wasted time
// deciding whether a surprising classification came from current logic or a
// stale build. With the version in the artifact, that question is answered by
// reading the artifact.
//
// BUMP THIS when the classification SEMANTICS change: a new/removed
// classification value, a different priority order between evidence sources
// (node report vs incidents vs minidumps), or a changed matching rule (e.g.
// the minidump time-window bounds or the confidence thresholds below). Do NOT
// bump for pure refactors or added evidence fields that don't change which
// classification comes out — the version answers "would this classifier have
// judged the same evidence differently?", not "did the file change?".
export const PREVIOUS_RUN_CLASSIFIER_VERSION = 1

export type PreviousRunReport = {
  priorRunId: string
  priorRunDir: string
  classification: PreviousRunClassification
  hadCleanMarker: boolean
  // Echo of PREVIOUS_RUN_CLASSIFIER_VERSION so callers stamp provenance into
  // the incident context without importing the constant themselves.
  classifierVersion: number
  evidence: Record<string, unknown>
}

// One Crashpad minidump candidate observed during the prior-run scan. Kept
// deliberately small (path + mtime + which subdir + window verdict): the whole
// candidate list lands in the incident context and must stay cheap to record.
export type CrashpadMinidumpCandidate = {
  path: string
  mtimeMs: number
  subdir: 'completed' | 'pending'
  // false ⇔ the dump's mtime is AFTER the heartbeat-derived upper bound (see
  // CrashpadScan.upperBoundMs) — it postdates the prior run's plausible death
  // window, so it likely belongs to a later process (helper, another run).
  withinWindow: boolean
}

// Full record of one Crashpad scan (#374). Everything here flows into the
// app.prior_unclean_shutdown incident context so an ambiguous or wrong
// native-crash attribution is auditable from the artifact alone — the original
// sin this replaces was a lower-bound-only match that silently picked the
// newest dump and recorded nothing about what else it saw.
export type CrashpadScan = {
  // Subdirectories actually enumerated (a missing pending/ or completed/ is
  // normal and simply won't appear here).
  scannedDirs: string[]
  // Lower bound: the prior run's manifest startedAt (or run-dir mtime
  // fallback). Dumps older than this minus a small slop are not candidates.
  sinceMs: number
  // Upper bound: prior run's last heartbeat ts + heartbeat interval + slop.
  // undefined when heartbeat.json was missing/unreadable — then no upper
  // bound can be derived and every candidate counts as within-window.
  upperBoundMs: number | undefined
  // Newest-first, bounded to MAX_MINIDUMP_CANDIDATES so a machine with a
  // pathological dump pile can't bloat the incident record.
  candidates: CrashpadMinidumpCandidate[]
  // How many dumps passed the lower bound BEFORE the bound above was applied —
  // lets triage see that e.g. 40 dumps qualified even though only 10 are listed.
  qualifyingCount: number
  selected: string | undefined
  selectedMtimeMs: number | undefined
  // 'high' only when the attribution is unambiguous: exactly one qualifying
  // dump AND it sits inside the heartbeat-derived window (or no window could
  // be derived). 'low' when several dumps qualify (any of them could be the
  // prior run's death) or the winner postdates the window (it may belong to a
  // different process entirely). Absent when nothing was selected.
  confidence?: 'high' | 'low'
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
    return {
      priorRunId,
      priorRunDir,
      classification: 'clean',
      hadCleanMarker: true,
      classifierVersion: PREVIOUS_RUN_CLASSIFIER_VERSION,
      evidence: {},
    }
  }

  // No marker → something other than a clean quit. Look for a recorded cause.
  const incidents = readJsonlTail(join(priorRunDir, 'incidents.jsonl'), MAX_INCIDENT_LINES)
  const kinds = new Set(incidents.map(incident => incident?.kind).filter(Boolean))

  let classification: PreviousRunClassification
  // Memoized single scan: two branches below may want minidump evidence, and
  // the scan is a real directory enumeration on the startup hot path — it must
  // run at most once per launch. `undefined` also doubles as "the scan never
  // ran" so evidence assembly can distinguish no-scan from scanned-and-empty.
  let crashpadScan: CrashpadScan | undefined
  const runCrashpadScan = (): CrashpadScan | undefined => {
    if (!options.crashDumpsDir) return undefined
    if (!crashpadScan) {
      crashpadScan = scanCrashpadMinidumps(
        options.crashDumpsDir,
        readPriorStartedAt(priorRunDir),
        readPriorLastHeartbeatTs(priorRunDir),
      )
    }
    return crashpadScan
  }
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
    // A V8 fatal abort raises SIGABRT, so Crashpad almost always wrote a
    // minidump for the SAME crash the diagnostic report describes. Look it up
    // here too: when this branch first landed it returned without touching
    // the minidump lookup, which REGRESSED evidence for the exact crash class
    // the branch was added for — pre-report-flag code fell through to the
    // minidump lookup below and surfaced `native`/`minidumpPath` for OOM
    // aborts, the new branch dropped both, and downstream triage that
    // symbolicates from context.minidumpPath got undefined.
    runCrashpadScan()
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
    const scan = runCrashpadScan()
    if (scan?.selected) {
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
    classifierVersion: PREVIOUS_RUN_CLASSIFIER_VERSION,
    evidence: {
      incidentKinds: [...kinds],
      // Point triage straight at the dump so a native crash is symbolicatable.
      // `native`/`minidumpPath` keep their pre-#374 top-level shape (existing
      // triage tooling greps for context.minidumpPath); the full scan record
      // rides alongside under `crashpad`.
      ...(crashpadScan?.selected
        ? {
            native: true,
            minidumpPath: crashpadScan.selected,
            minidumpConfidence: crashpadScan.confidence,
          }
        : {}),
      // Complete Crashpad scan context (#374): bounds, every candidate seen,
      // and the confidence verdict — recorded whenever a scan RAN (even an
      // empty one: "we looked and found nothing" is evidence too, and its
      // absence distinguishes "no crashDumpsDir supplied" from "no dumps").
      ...(crashpadScan ? { crashpad: crashpadScan } : {}),
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
// would defeat the "cheap classifier" invariant. `trigger` lives under the
// report's `header` object (NOT at the top level — the shape is
// `{ "header": { "trigger": "OOMError", ... }, "javascriptStack": ..., ... }`),
// but `header` is the FIRST key Node serializes, so the field reliably lands
// in the first few hundred bytes of the file — far inside the 32 KB prefix.
// The full report stays on disk for triage tools to read at leisure.
function findNodeDiagnosticReport(
  priorRunDir: string,
): { path: string; trigger: string | undefined } | undefined {
  let candidates: string[]
  try {
    // Match Node's actual report name shape (report.<YYYYMMDD>.<HHMMSS>.
    // <PID>.<TID>.<SEQ>.json) instead of a loose report.*.json prefix test.
    // The loose test had a shadowing hazard: any future artifact named e.g.
    // `report.summary.json` sorts lexically AFTER the digit-dated names,
    // wins the "newest" pick below, has no trigger field — and the real
    // fatal-error report sitting right next to it is never read, silently
    // reverting the classification to force_quit_or_power_loss.
    candidates = readdirSync(priorRunDir)
      .filter(name => /^report\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.json$/.test(name))
  } catch {
    return undefined
  }
  if (candidates.length === 0) return undefined
  // Report names embed date+time first, so lexical sort ~= chronological.
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
      // Slice to the byte count readSync ACTUALLY returned. Discarding the
      // return value and stringifying the whole zero-initialized buffer
      // padded a short read with NUL characters — harmless to the regex
      // itself, but it made the scan lie about how much of the file was
      // really inspected. Short reads on a settled regular file are rare
      // (EINTR, racing truncation) but cost one line to handle honestly.
      const bytesRead = readSync(fd, buf, 0, readBytes, 0)
      text = buf.toString('utf8', 0, bytesRead)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  // `trigger` is nested under `header` in a Node diagnostic report; this regex
  // works because it is a FLAT text scan over the prefix, not a structural
  // lookup — nesting is irrelevant to it. Do NOT "simplify" this to
  // `JSON.parse(prefix).trigger`: that returns undefined (trigger is not
  // top-level) and would silently kill every main_oom_suspected
  // classification. The flat scan is also safe from false positives in
  // practice: `header` is the first serialized object and its `trigger` comes
  // before any user-controlled content (commandLine/env land later in the
  // header, stacks later still), so the FIRST match in the file is always the
  // real one. A regex also survives the truncated-JSON prefix a real parser
  // would reject.
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

// Mirrors AppRunJournal's HEARTBEAT_INTERVAL_MS. NOT imported from there: that
// module pulls in `electron` (BrowserWindow) at load time, and this classifier
// is deliberately a pure-fs module so it stays cheap to load on the startup
// hot path and trivially testable without an Electron runtime. If the journal
// interval ever changes, this constant must change with it — the only cost of
// drift is a slightly mis-sized matching window, never a wrong crash/no-crash
// verdict (the window only tunes confidence + within-window marking).
const PRIOR_RUN_HEARTBEAT_INTERVAL_MS = 5_000

// Slop below the lower bound (prior run start): absorbs clock/mtime skew
// between the run's manifest timestamp and when Crashpad flushed the dump.
// Unchanged from the pre-#374 matcher.
const MINIDUMP_LOWER_BOUND_SLOP_MS = 5_000

// Slop above the upper bound (last heartbeat + one interval). Generous by
// design — 60s, not another 5s — because everything on the death side of the
// timeline is slower and less trustworthy than the healthy-run side: the final
// heartbeat write itself can lag on a struggling disk (the exact scenario that
// kills runs), Crashpad serializes the dump AFTER the process is already dead
// (large heaps take seconds), and pending→completed processing can touch
// mtimes later still. A too-tight bound would mark the true crash dump
// "outside window" and downgrade a correct attribution to low confidence; a
// 60s-too-loose bound only risks including a dump from an immediate relaunch
// crash-loop, which the multiple-candidates → 'low' rule already flags.
const MINIDUMP_UPPER_BOUND_SLOP_MS = 60_000

// Cap on candidates RECORDED in the incident context (the scan itself still
// looks at every dump — `qualifyingCount` preserves the true total). 10 keeps
// the worst case (a crash-looping machine with dozens of dumps) from bloating
// incidents.jsonl while comfortably covering the ambiguity triage actually
// needs to see: past ~3 candidates the verdict is "hopelessly ambiguous"
// regardless of how many more there are.
const MAX_MINIDUMP_CANDIDATES = 10

// Last heartbeat timestamp of the prior run, for deriving the upper edge of
// the plausible death window. heartbeat.json is overwrite-only and constant
// size (~600 bytes), so a whole-file read is bounded — this does NOT violate
// the classifier's cheap-synchronous-startup invariant. undefined when the
// file is missing (journal never started / very early crash) or torn beyond
// parsing, in which case no upper bound is derivable.
function readPriorLastHeartbeatTs(priorRunDir: string): number | undefined {
  try {
    const heartbeat = JSON.parse(
      readFileSync(join(priorRunDir, 'heartbeat.json'), 'utf8'),
    ) as { ts?: unknown }
    return typeof heartbeat.ts === 'number' && Number.isFinite(heartbeat.ts)
      ? heartbeat.ts
      : undefined
  } catch {
    return undefined
  }
}

// Scan Crashpad's completed/ and pending/ for .dmp files plausibly written by
// the prior run, recording EVERYTHING the decision saw (#374). Pre-#374 this
// was a lower-bound-only "newest dump wins" match that returned a bare path —
// which silently attributed a helper-process or crash-loop dump to the wrong
// run with no way to audit it afterwards. Read-only, never throws.
//
// Window semantics:
//   lower bound  = prior run start − 5s slop      (a dump can't predate its run)
//   upper bound  = last heartbeat + interval + 60s (a dump long after the run's
//                                                   last sign of life is suspect)
// The lower bound still GATES candidacy (unchanged behavior). The upper bound
// deliberately does NOT gate: an out-of-window dump is still listed and even
// selectable when nothing better exists — because the heartbeat file can be
// stale for benign reasons (torn write at death) and dropping the only dump on
// the floor would regress the native-crash detection this matcher exists for.
// Instead, out-of-window shows up as withinWindow:false + confidence:'low', so
// the attribution is made AND flagged as unproven.
function scanCrashpadMinidumps(
  crashDumpsDir: string,
  sinceMs: number,
  lastHeartbeatTs: number | undefined,
): CrashpadScan {
  const upperBoundMs = lastHeartbeatTs !== undefined
    ? lastHeartbeatTs + PRIOR_RUN_HEARTBEAT_INTERVAL_MS + MINIDUMP_UPPER_BOUND_SLOP_MS
    : undefined
  const scannedDirs: string[] = []
  const qualifying: CrashpadMinidumpCandidate[] = []
  for (const sub of ['completed', 'pending'] as const) {
    const dir = join(crashDumpsDir, sub)
    let names: string[]
    try {
      names = readdirSync(dir).filter(name => name.endsWith('.dmp'))
    } catch {
      // Missing subdir is normal (no completed crashes yet); it simply doesn't
      // appear in scannedDirs, which itself documents what the scan could see.
      continue
    }
    scannedDirs.push(dir)
    for (const name of names) {
      const path = join(dir, name)
      try {
        const mtimeMs = statSync(path).mtimeMs
        if (mtimeMs >= sinceMs - MINIDUMP_LOWER_BOUND_SLOP_MS) {
          qualifying.push({
            path,
            mtimeMs,
            subdir: sub,
            withinWindow: upperBoundMs === undefined || mtimeMs <= upperBoundMs,
          })
        }
      } catch {
        // raced with Crashpad moving the file; skip.
      }
    }
  }
  // Newest-first so the recorded (bounded) list keeps the most decision-
  // relevant candidates when truncated.
  qualifying.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // Selection: newest WITHIN-WINDOW dump wins; only when none is within the
  // window fall back to the newest overall (see the gating rationale above).
  // With no derivable window every candidate is withinWindow, which reduces to
  // the pre-#374 "newest wins" behavior exactly.
  const selected = qualifying.find(c => c.withinWindow) ?? qualifying[0]
  // 'high' demands an unambiguous story: exactly one dump could plausibly be
  // this run's death, and the heartbeat timeline doesn't contradict it.
  // Multiple qualifying dumps mean ANY of them could be the crash (only mtime
  // ordering picked the winner), and an out-of-window winner means the dump
  // postdates the run's last sign of life by more than the generous slop —
  // both make the attribution a guess, and guesses must not be reported with
  // the same confidence as proof (issue #374 acceptance criterion).
  const confidence: 'high' | 'low' | undefined = selected
    ? (qualifying.length === 1 && selected.withinWindow ? 'high' : 'low')
    : undefined
  return {
    scannedDirs,
    sinceMs,
    upperBoundMs,
    candidates: qualifying.slice(0, MAX_MINIDUMP_CANDIDATES),
    qualifyingCount: qualifying.length,
    selected: selected?.path,
    selectedMtimeMs: selected?.mtimeMs,
    ...(confidence ? { confidence } : {}),
  }
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
