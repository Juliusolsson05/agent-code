import { createReadStream } from 'fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join, normalize } from 'path'
import { createInterface } from 'readline'

import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import {
  appendDebugBundleSaved,
  debugBundleRootForReason,
  isAutosaveDebugBundleReason,
} from '@main/storage/debugBundleLog.js'
import { getAppRunId } from '@main/incident/appRunIds.js'
import { getBuildInfo } from '@main/buildInfo.js'
import { INCIDENT_RUNS_DIR } from '@main/storage/paths.js'
import {
  isCodexTranscriptObservationEventName,
  isCodexTranscriptObservationSessionId,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  SESSION_LIFECYCLE_AREA,
} from '@shared/lifecycle/events.js'
// Filename-safe session-id token — shared with feedDebugLog so the two
// session-keyed storage layouts can't diverge on their escape rule. See
// @shared/runtime/projectDir sanitizeFilenameToken.
import { sanitizeFilenameToken } from '@shared/runtime/projectDir.js'

// Debug-bundle writer.
//
// The renderer assembles the bundle (it has every diagnostic source:
// runtime.semantic, runtime.feedDebugLog, the DOM outerHTML, and can
// run sanitizeHtml locally) and ships the pre-serialized files here
// in a single IPC call. Main owns filesystem layout + atomicity and
// returns the absolute bundle path so the renderer can surface it.
//
// Why the renderer assembles vs. main assembling:
//   The data lives in three different places in the renderer
//   (workspace runtime store, the live DOM, sanitizeHtml in
//   @renderer/lib). Forwarding all of that through IPC in structured
//   form would recreate those representations in main just to
//   stringify them back out. Shipping the already-stringified files
//   is one round-trip, no schema duplication, and keeps main a thin
//   byte-mover — same discipline as workspace.json (see paths.ts).
//
// Why per-invocation folders instead of a single shared dir:
//   A bundle is a coherent snapshot — all files were captured at the
//   same instant from the same pane. Mixing multiple invocations
//   into one folder would make it ambiguous which proxy-semantic.json
//   goes with which feed-debug.jsonl. Timestamped folders also double
//   as a history: the user can compare "before / after" bundles
//   without manual renaming.

// Payload shapes are the shared IPC contract — see @shared/types/debugBundle.
// Re-exported here so `@main/ipc/debug` (and any other main importer) keeps
// importing them from this module while the source of truth is shared.
export type {
  DebugBundleFile,
  SaveDebugBundleParams,
  SaveDebugBundleResult,
} from '@shared/types/debugBundle.js'
import type {
  DebugBundleFile,
  SaveDebugBundleParams,
  SaveDebugBundleResult,
} from '@shared/types/debugBundle.js'

// Was a local `sanitizeForPath` duplicating feedDebugLog's regex; now the one
// shared `sanitizeFilenameToken` (same output, single source of truth).
const sanitizeForPath = sanitizeFilenameToken

const CODEX_TRANSCRIPT_OBSERVATIONS_FILE = 'codex-transcript-observations.jsonl'
// Four MiB is intentionally generous relative to the closed, rate-limited
// lifecycle vocabulary while still keeping one pathological run from turning a
// manual bundle into a second copy of the 50 MiB app journal. We count UTF-8
// bytes, not JavaScript characters, because the filesystem cap is a byte cost.
const CODEX_TRANSCRIPT_OBSERVATIONS_MAX_BYTES = 4 * 1024 * 1024
const LEGACY_CROSS_PROVIDER_SUBMIT_EVENTS: ReadonlySet<string> = new Set([
  'submit.begin',
  'submit.result',
  'submit.unwound',
])

type AppRunJournalCompleteness = {
  capped: boolean
  bytesWritten: number
  droppedEvents: number
  flushFailed: boolean
}
type CodexTranscriptObservationCompleteness = {
  gapTrackingCapped: boolean
}
const MAIN_AUTHORED_RUN_DISPOSITIONS: ReadonlySet<unknown> = new Set([
  'current',
  'stale',
  'missing',
  'retired-or-unknown',
])

// Bundle folder naming: `<ISO-like timestamp-with-ms>-<sessionShort>`.
//
// Why colon-free ISO: macOS tolerates ':' in file names but many
// tools (and Windows) don't, and the user WILL be copy-pasting this
// path into a terminal. `2026-04-23T14-32-07` reads unambiguously
// as a date+time and sorts lexicographically. Keep milliseconds
// because autosave can race a manual save or close-save inside the
// same second; silently overwriting a just-written debug bundle is
// worse than a slightly longer folder name.
//
// Why include the 8-char session id: if the user saves two bundles
// from two different panes in the same second, bare timestamp would
// collide. Short prefix keeps the folder name readable while
// disambiguating.
function buildBundleFolderName(sessionId: string, now: Date): string {
  const iso = now.toISOString()
  // `2026-04-23T14:32:07.842Z` → `2026-04-23T14-32-07-842`
  const stamp = iso.replace(/Z$/, '').replace(/[:.]/g, '-')
  const short = sanitizeForPath(sessionId.slice(0, 8))
  return `${stamp}-${short}`
}

// Autosave folder naming — DELIBERATELY stable (no timestamp), one folder
// per session.
//
// WHY this differs from manual saves: aggressiveDebugPersistence ticks every
// AUTO_DEBUG_BUNDLE_INTERVAL_MS (60s) and saves a bundle for EVERY active
// claude/codex pane. With the timestamped naming used by manual saves, a
// workspace with N panes minted N new ~1MB folders every minute — thousands
// per session. debugRetention caps the autosave bucket, so it then deleted the
// oldest ~285 folders on every save just to have them regenerated seconds
// later: a permanent ~310 MiB/cycle churn loop (the `[debug-retention] pruned
// 285 artifacts` spam) plus pointless SSD wear, for history nothing ever reads.
//
// Autosave is a crash-recovery snapshot: only the LATEST capture per session is
// useful, and nothing in the app consumes these dirs programmatically. Keying
// the folder on the (full, path-sanitized) session id collapses the firehose to
// at most one folder per active session — bounded, no churn — while manual
// saves keep their timestamped before/after history below.
function buildAutosaveFolderName(sessionId: string): string {
  return sanitizeForPath(sessionId)
}

// Validate that a bundle file path stays inside the timestamped
// folder. Root-level debug files still pass (`manifest.json`), and
// trace files can now live in controlled subfolders
// (`trace/html/commits.jsonl`). Absolute paths, empty segments, and
// `..` are rejected.
function isSafeRelativePath(name: string): boolean {
  if (!name || name.length > 512) return false
  if (name.startsWith('/') || name.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false
  const rawParts = name.split(/[\\/]/)
  if (rawParts.some(part => !part || part === '.' || part === '..' || part.length > 255)) {
    return false
  }
  const normalized = normalize(name)
  if (normalized.startsWith('..')) return false
  return true
}

export async function saveDebugBundle(
  params: SaveDebugBundleParams,
  options?: {
    appRunJournalCompleteness?: AppRunJournalCompleteness
    codexTranscriptObservationCompleteness?: CodexTranscriptObservationCompleteness
  },
): Promise<SaveDebugBundleResult> {
  if (!params?.sessionId || !Array.isArray(params.files) || params.files.length === 0) {
    throw new Error('saveDebugBundle: missing sessionId or empty files list')
  }
  for (const file of params.files) {
    if (!isSafeRelativePath(file.name)) {
      throw new Error(`saveDebugBundle: unsafe file path: ${JSON.stringify(file.name)}`)
    }
  }

  const isAutosave = isAutosaveDebugBundleReason(params.reason)
  const bundleRoot = debugBundleRootForReason(params.reason)
  const bundlePath = join(
    bundleRoot,
    isAutosave
      ? buildAutosaveFolderName(params.sessionId)
      : buildBundleFolderName(params.sessionId, new Date()),
  )

  if (isAutosave) {
    // Autosave reuses one folder per session (see buildAutosaveFolderName), so
    // we must REPLACE the previous snapshot rather than write over it in place.
    // In-place writes would (a) leave stale files behind if the file set ever
    // shrinks, breaking the "one folder = one coherent snapshot" invariant, and
    // (b) expose a half-written mix if a reader inspects the folder during an
    // in-place rewrite. We write to a unique temp dir first, then replace the
    // stable cache path. Directory replacement is intentionally "good cache
    // hygiene", not a durable transaction: there is a tiny rm->rename window
    // where the latest autosave folder may be absent, which is acceptable for
    // best-effort debug recovery and much better than retaining stale files.
    // The temp name is unique (pid+time) because a beforeunload save can race an
    // in-flight interval save for the same session; the `finally` drops any temp
    // the rename didn't consume so a failed/raced write never orphans cache.
    const tmpPath = `${bundlePath}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeBundleFiles(tmpPath, params.files)
      // Provenance stamp for autosave bundles too (#374): every bundle must be
      // able to identify the build that produced it, and autosave bundles are
      // the ones most likely to be the ONLY artifact left after a crash — the
      // exact case where "which source built this?" matters most. Stamped on
      // the temp dir BEFORE the swap so the stable folder is always coherent:
      // a reader never observes a snapshot whose manifest lacks the stamp.
      //
      // Deliberately only the cheap identity stamp (manifest appRunId + build
      // + the write-once incident-run-manifest.json copy), NOT the journal
      // tails that manual saves also get. Autosave ticks every 60s per active
      // pane, and its history shows what happens when that path gets heavy
      // (see buildAutosaveFolderName: the folder-churn / debug-retention spam
      // incident). Copying ~200 KiB of events/incidents tails per pane per
      // minute would roughly double the bytes written per tick for data that
      // is fully recoverable anyway: the stamped appRunId keys straight into
      // the run's journal dir under INCIDENT_RUNS_DIR, which outlives the run
      // (50-run retention). Identity is the part that CANNOT be recovered
      // later; the timeline can.
      await stampBundleProvenance(tmpPath)
      await rm(bundlePath, { recursive: true, force: true })
      await rename(tmpPath, bundlePath)
    } finally {
      await rm(tmpPath, { recursive: true, force: true }).catch(() => {})
    }

    // No ledger append for autosave: the autosaved-debug-bundles.jsonl file is
    // write-only (nothing reads it — retention classifies autosave purely by
    // directory), so appending one line per 60s-per-pane tick was an unbounded
    // leak of its own. Retention also already understands these bundles by
    // their root dir, so the ledger adds nothing.
    scheduleDebugStoragePrune('debug-bundle-save')
    return { bundlePath }
  }

  // Manual saves keep the timestamped before/after history and the lookup
  // ledger — they are user-intentional captures, not a high-frequency cache.
  await writeBundleFiles(bundlePath, params.files)

  // Phase 7: correlate this manual bundle with the always-on incident journal,
  // so a bundle is self-contained for triage without timestamp-matching against
  // the incidents dir. Autosave gets the identity stamp only (see the autosave
  // branch above for why the journal-tail copies stay manual-only).
  await enrichBundleWithIncidentJournal(bundlePath, {
    sessionId: params.sessionId,
    kind: params.kind ?? null,
    appRunJournalCompleteness: options?.appRunJournalCompleteness,
    codexTranscriptObservationCompleteness:
      options?.codexTranscriptObservationCompleteness,
  })

  try {
    await appendDebugBundleSaved({
      bundlePath,
      sessionId: params.sessionId,
      kind: params.kind ?? null,
      reason: params.reason ?? null,
      cwd: params.cwd ?? null,
      providerSessionId: params.providerSessionId ?? null,
    })
  } catch (err) {
    // WHY the index is best-effort: the timestamped bundle folder is the
    // durable artifact the user asked us to save. The JSONL is only a lookup
    // aid for future browsing. Reporting "save failed" after every file was
    // already written would make the worst disk-pressure case actively
    // misleading and would also skip the note prompt for a usable bundle.
    console.warn('[debug-bundle] failed to append saved-bundle index entry', err)
  }

  scheduleDebugStoragePrune('debug-bundle-save')

  return { bundlePath }
}

// Sequential writes. Could parallelize with Promise.all but bundles
// are small (a few files, typically < 1MB total) and a serial loop
// keeps error messages unambiguous — a failure names the file that
// actually failed, not an aggregate rejection that's harder to act
// on when debugging Agent Code itself (which is the whole point of
// this feature).
async function writeBundleFiles(bundlePath: string, files: DebugBundleFile[]): Promise<void> {
  // mkdir recursive handles both the manual/autosave root (first invocation
  // ever) and the new per-bundle folder in one call.
  await mkdir(bundlePath, { recursive: true })
  for (const file of files) {
    const target = join(bundlePath, file.name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
  }
}

// Phase 7: full enrichment for MANUAL bundles — the identity stamp shared with
// autosave, plus a bounded tail of this run's journal (events.jsonl +
// heartbeat.json + incidents.jsonl). Entirely best-effort: the timestamped
// bundle the user asked for is the durable artifact, so NOTHING here may throw
// out of the save path.
async function enrichBundleWithIncidentJournal(
  bundlePath: string,
  params: {
    sessionId: string
    kind: string | null
    appRunJournalCompleteness?: AppRunJournalCompleteness
    codexTranscriptObservationCompleteness?: CodexTranscriptObservationCompleteness
  },
): Promise<void> {
  const appRunId = await stampBundleProvenance(bundlePath)

  // Copy the journal tail so the bundle is triage-complete on its own.
  const runDir = join(INCIDENT_RUNS_DIR, appRunId)
  const copies: Array<[src: string, dest: string, maxBytes: number]> = [
    [join(runDir, 'events.jsonl'), 'incident-events.jsonl', 128 * 1024],
    [join(runDir, 'incidents.jsonl'), 'incident-incidents.jsonl', 64 * 1024],
  ]
  for (const [src, dest, maxBytes] of copies) {
    try {
      const tail = await readJsonlTailBytes(src, maxBytes)
      if (tail) await writeFile(join(bundlePath, dest), tail, 'utf8')
    } catch (err) {
      console.warn(`[debug-bundle] failed to copy ${dest}`, err)
    }
  }
  // heartbeat.json is tiny and overwrite-only — copy it whole if present.
  try {
    const heartbeat = await readFile(join(runDir, 'heartbeat.json'), 'utf8')
    await writeFile(join(bundlePath, 'incident-heartbeat.json'), heartbeat, 'utf8')
  } catch {
    // No heartbeat yet (very early crash) is fine.
  }

  if (params.kind === 'codex') {
    await exportCodexTranscriptObservations({
      bundlePath,
      appRunId,
      sessionId: params.sessionId,
      appRunJournalCompleteness: params.appRunJournalCompleteness,
      codexTranscriptObservationCompleteness:
        params.codexTranscriptObservationCompleteness,
    })
  }
}

type CodexTranscriptObservationExport = {
  source: 'app-run-journal'
  sourceAppRunId: string
  sourceAvailable: boolean
  scopeAccepted: boolean
  matchedEvents: number
  writtenEvents: number
  bytes: number
  truncated: boolean
  sourceCompletenessAvailable: boolean
  sourceCapped: boolean | null
  sourceBytesWritten: number | null
  sourceDroppedEvents: number | null
  sourceFlushFailed: boolean | null
  sourceGapTrackingStatusAvailable: boolean
  sourceGapTrackingCapped: boolean | null
  rendererObservationGapObserved: boolean
  rateLimitGapObserved: boolean
  attachmentTrackingCappedObserved: boolean
  attachmentSuppressionObserved: boolean
  malformedJsonRows: number
  invalidChronologyRows: number
  sourceHasGaps: boolean
}

/**
 * Export one Codex pane's Stage 0 chronology from the existing app-run
 * journal. This is a projection, not a second runtime store: the journal
 * remains the durable source of truth and the bundle gets only the rows whose
 * closed lifecycle name and exact `ids.sessionId` prove they belong here.
 *
 * WHY scan the full file instead of reusing `incident-events.jsonl`: that file
 * is deliberately a 128 KiB cross-pane tail. The submitted prompt that started
 * this investigation had already fallen outside the renderer bundle ring and
 * could just as easily fall outside this tail. Stage 0 needs the complete
 * session chain, so we stream the run journal from the beginning while bounding
 * only the sparse matched output. Streaming prevents a long run's 50 MiB
 * journal from being duplicated in memory.
 *
 * WHY re-apply the shared pickers even though `SessionLifecycleJournal` already
 * uses them: the named file promises to be content-safe on its own. A future
 * main-owned producer could accidentally write the right event name directly
 * to AppRunJournal with an extra field. Reusing the SAME shared pickers here
 * gives the export defense in depth without creating a second privacy schema
 * that can drift from the writer.
 */
async function exportCodexTranscriptObservations(params: {
  bundlePath: string
  appRunId: string
  sessionId: string
  appRunJournalCompleteness?: AppRunJournalCompleteness
  codexTranscriptObservationCompleteness?: CodexTranscriptObservationCompleteness
}): Promise<void> {
  const sourcePath = join(INCIDENT_RUNS_DIR, params.appRunId, 'events.jsonl')
  const outputPath = join(params.bundlePath, CODEX_TRANSCRIPT_OBSERVATIONS_FILE)
  const output: string[] = []
  let bytes = 0
  let matchedEvents = 0
  let writtenEvents = 0
  let truncated = false
  let sourceAvailable = true
  const scopeAccepted = isCodexTranscriptObservationSessionId(params.sessionId)
  let rendererObservationGapObserved = false
  let rateLimitGapObserved = false
  let attachmentTrackingCappedObserved = false
  let attachmentSuppressionObserved = false
  let malformedJsonRows = 0
  let invalidChronologyRows = 0

  try {
    if (!scopeAccepted) throw new Error('invalid Codex transcript observation session scope')
    const lines = createInterface({
      input: createReadStream(sourcePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of lines) {
      if (!line) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        // A crash may leave only the final JSONL line torn. Treat it exactly as
        // every other journal reader does: preserve all complete evidence and
        // skip the fragment rather than making bundle save fail. Unlike a
        // permissive replay reader, this forensic projection also counts the
        // uncertainty: an unparsable global row cannot prove which pane lost
        // evidence, so no pane exported from this source may claim completeness.
        malformedJsonRows += 1
        continue
      }
      const ids = event.ids as Record<string, unknown> | undefined
      if (event.area !== SESSION_LIFECYCLE_AREA) continue
      if (!isCodexTranscriptObservationEventName(event.name)) continue
      if (ids?.sessionId !== params.sessionId) continue
      const eventData = event.data as Record<string, unknown> | undefined
      if (
        event.name === 'transcript.outbox-gap' ||
        event.name === 'transcript.surface-gap'
      ) rendererObservationGapObserved = true
      if (event.name === 'transcript.observation-gap') rateLimitGapObserved = true
      if (
        event.name === 'transcript.attachment' &&
        eventData?.trackingCapped === true
      ) attachmentTrackingCappedObserved = true
      if (
        event.name === 'transcript.attachment' &&
        typeof eventData?.suppressed === 'number' &&
        eventData.suppressed > 0
      ) attachmentSuppressionObserved = true
      if (
        LEGACY_CROSS_PROVIDER_SUBMIT_EVENTS.has(event.name) &&
        (eventData?.provider !== 'codex' ||
          !MAIN_AUTHORED_RUN_DISPOSITIONS.has(eventData.runDisposition))
      ) {
        // Stable pane ids can survive a provider switch within one app run.
        // These three names were provider-neutral before Stage 0, so session
        // equality alone cannot make an earlier Claude/OpenCode submit into a
        // Codex transcript fact. Provider alone is not provenance either: that
        // value originates in renderer data. Lifecycle IPC strips any renderer
        // runDisposition and writes its own only after exact live/retired proof,
        // so requiring BOTH fields keeps forged generic rows out of this named
        // evidence stream while preserving them in the broad app journal.
        continue
      }

      if (
        typeof event.seq !== 'number' ||
        typeof event.ts !== 'number' ||
        typeof event.monotonicMs !== 'number' ||
        !Number.isSafeInteger(event.seq) ||
        event.seq < 0 ||
        !Number.isSafeInteger(event.ts) ||
        !Number.isFinite(event.monotonicMs) ||
        event.monotonicMs < 0 ||
        Math.abs(event.ts) > 8.64e15
      ) {
        // These are the ordering coordinates that make the file a chronology.
        // A malformed direct journal write is not useful evidence and should
        // not be made to look authoritative by filling invented timestamps.
        // The row already passed exact pane/name scope above, so count this gap
        // only for the affected exported stream rather than every pane.
        invalidChronologyRows += 1
        continue
      }
      matchedEvents += 1
      if (truncated) continue
      const data = pickCodexTranscriptObservationData(event.name, event.data)
      const correlationIds = pickCodexTranscriptObservationCorrelationIds(
        event.name,
        event.ids,
        data,
      )
      const safeEvent = {
        schemaVersion: 1,
        seq: event.seq,
        ts: event.ts,
        tsIso: new Date(event.ts).toISOString(),
        monotonicMs: event.monotonicMs,
        appRunId: params.appRunId,
        area: SESSION_LIFECYCLE_AREA,
        name: event.name,
        severity:
          event.severity === 'debug' ||
          event.severity === 'warn' ||
          event.severity === 'error' ||
          event.severity === 'fatal'
            ? event.severity
            : 'info',
        // Session attribution was already checked against the requested exact
        // pane above. The shared correlation picker intentionally excludes
        // sessionId because main owns it, so restore that one authoritative id
        // after filtering the renderer-provided ids.
        ids: { ...(correlationIds ?? {}), sessionId: params.sessionId },
        ...(data ? { data } : {}),
      }
      const serialized = `${JSON.stringify(safeEvent)}\n`
      const lineBytes = Buffer.byteLength(serialized, 'utf8')
      if (bytes + lineBytes > CODEX_TRANSCRIPT_OBSERVATIONS_MAX_BYTES) {
        // Keep scanning so the manifest reports the honest matched count. The
        // `truncated` flag is the explicit evidence gap; silently stopping at
        // four MiB would make a partial chronology look complete.
        truncated = true
        continue
      }
      output.push(serialized)
      bytes += lineBytes
      writtenEvents += 1
    }
  } catch (err) {
    // The manual renderer-owned files are still a valid bundle when the
    // always-on journal failed to start or disappeared under external cleanup.
    // Emit an empty named stream plus manifest counts so absence is explicit,
    // never confused with an enrichment exception that aborted the save.
    console.warn('[debug-bundle] failed to export Codex transcript observations', err)
    sourceAvailable = false
  }

  try {
    await writeFile(outputPath, output.join(''), 'utf8')
    await stampCodexTranscriptObservationExport(params.bundlePath, {
      source: 'app-run-journal',
      sourceAppRunId: params.appRunId,
      sourceAvailable,
      scopeAccepted,
      matchedEvents,
      writtenEvents,
      bytes,
      truncated,
      sourceCompletenessAvailable: params.appRunJournalCompleteness !== undefined,
      sourceCapped: params.appRunJournalCompleteness?.capped ?? null,
      sourceBytesWritten: params.appRunJournalCompleteness?.bytesWritten ?? null,
      sourceDroppedEvents: params.appRunJournalCompleteness?.droppedEvents ?? null,
      sourceFlushFailed: params.appRunJournalCompleteness?.flushFailed ?? null,
      sourceGapTrackingStatusAvailable:
        params.codexTranscriptObservationCompleteness !== undefined,
      sourceGapTrackingCapped:
        params.codexTranscriptObservationCompleteness?.gapTrackingCapped ?? null,
      rendererObservationGapObserved,
      rateLimitGapObserved,
      attachmentTrackingCappedObserved,
      attachmentSuppressionObserved,
      malformedJsonRows,
      invalidChronologyRows,
      // Projection truncation and source loss are separately reported but both
      // make the aggregate completeness verdict false. A complete 4 MiB prefix
      // cannot repair rows the upstream journal already dropped, and an
      // unavailable snapshot is unknown—not permission to claim completeness.
      sourceHasGaps: !sourceAvailable ||
        !scopeAccepted ||
        truncated ||
        params.appRunJournalCompleteness === undefined ||
        params.appRunJournalCompleteness.capped ||
        params.appRunJournalCompleteness.droppedEvents > 0 ||
        params.appRunJournalCompleteness.flushFailed ||
        params.codexTranscriptObservationCompleteness === undefined ||
        params.codexTranscriptObservationCompleteness.gapTrackingCapped ||
        rendererObservationGapObserved ||
        rateLimitGapObserved ||
        attachmentTrackingCappedObserved ||
        attachmentSuppressionObserved ||
        malformedJsonRows > 0 ||
        invalidChronologyRows > 0,
    })
  } catch (err) {
    // Enrichment is forensic aid, never the durable artifact the user asked to
    // save. Match the incident-tail policy above and leave the core bundle in
    // place even when this optional write fails.
    console.warn('[debug-bundle] failed to write Codex transcript observations', err)
  }
}

async function stampCodexTranscriptObservationExport(
  bundlePath: string,
  observationExport: CodexTranscriptObservationExport,
): Promise<void> {
  const manifestPath = join(bundlePath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter((file): file is string => typeof file === 'string')
    : []
  if (!files.includes(CODEX_TRANSCRIPT_OBSERVATIONS_FILE)) {
    files.push(CODEX_TRANSCRIPT_OBSERVATIONS_FILE)
  }
  manifest.files = files
  // Counts and the cap flag belong beside bundle provenance, not as an invented
  // observation event. Consumers can therefore distinguish "zero matching
  // events" from "the export was truncated" without teaching the lifecycle
  // vocabulary a fake product event that never occurred.
  manifest.codexTranscriptObservations = observationExport
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// Identity stamp shared by BOTH bundle flavors (#374 requires EVERY bundle —
// autosave included — to identify the build that produced it). Two cheap,
// bounded writes; anything heavier belongs in enrichBundleWithIncidentJournal
// so the 60s-per-pane autosave tick stays lean. Never throws (same best-effort
// contract as the rest of the save path). Returns the appRunId so the manual
// enrichment above doesn't resolve it twice.
async function stampBundleProvenance(bundlePath: string): Promise<string> {
  const appRunId = getAppRunId()

  // (a) The renderer builds manifest.json without an appRunId (it doesn't own
  // the canonical id); stamp it here so the bundle correlates by one key.
  try {
    const manifestPath = join(bundlePath, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.appRunId = appRunId
    // Build provenance (#374), stamped for the same reason as appRunId: the
    // renderer can't know it (it lives in a main-only injected define), and a
    // bundle without it can't prove WHICH source built the app that produced
    // the report — a dirty local build was mistaken for origin/main during the
    // crash-classifier investigation. Duplicated in the copied run manifest
    // below, but bundle manifest.json is the file people actually open first,
    // and the run-manifest copy can be missing (journal failed to start).
    manifest.build = getBuildInfo()
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn('[debug-bundle] failed to stamp appRunId into manifest', err)
  }

  // (b) The run's manifest.json, copied verbatim (#374). The journal tails
  // (manual-only, above) give a bundle the run's TIMELINE but nothing about
  // the run's IDENTITY — versions, platform, build provenance, classifier
  // version all live in the manifest, and pre-#374 bundles forced triage to go
  // find the matching ~/.config run dir (often already pruned by 50-run
  // retention) to learn them. Write-once at run start and a few hundred
  // bytes, so a whole-file copy is bounded — cheap enough for autosave.
  // `incident-` prefix matches its journal siblings and avoids colliding with
  // the bundle's own manifest.json.
  try {
    const runManifest = await readFile(join(INCIDENT_RUNS_DIR, appRunId, 'manifest.json'), 'utf8')
    await writeFile(join(bundlePath, 'incident-run-manifest.json'), runManifest, 'utf8')
  } catch {
    // Missing run manifest means the journal never started (degraded boot,
    // e.g. read-only ~/.config) — the bundle manifest.json build stamp above
    // still carries provenance, so skipping is safe.
  }

  return appRunId
}

// Read the trailing `maxBytes` of a possibly-large JSONL file, dropping the
// first partial line so the result is valid JSONL. Returns null on error/empty.
// Keeps bundle assembly cheap even if events.jsonl has grown over a long run.
async function readJsonlTailBytes(path: string, maxBytes: number): Promise<string | null> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return null
  }
  if (size === 0) return null
  if (size <= maxBytes) {
    const full = await readFile(path, 'utf8')
    return full.length > 0 ? full : null
  }
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    await handle.read(buf, 0, maxBytes, size - maxBytes)
    const text = buf.toString('utf8')
    const firstNewline = text.indexOf('\n')
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text
  } finally {
    await handle.close()
  }
}
