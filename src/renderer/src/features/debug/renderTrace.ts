import { sanitizeHtml } from '@renderer/lib/sanitizeHtml'
import {
  hashText,
  SCREEN_MAX_SAMPLES,
  SCREEN_TAIL_LINES,
  type ScreenTailSample,
} from '@shared/debug/screenTail'

type TraceReason = 'initial' | 'mutation' | 'screen' | 'manual'

type TextDelta = {
  baseHash: string
  prefixLen: number
  suffixLen: number
  insert: string
}

type HtmlCommit = {
  id: string
  parentId: string | null
  seq: number
  ts: number
  tsIso: string
  reason: TraceReason
  hash: string
  size: number
  checkpoint: boolean
  delta?: TextDelta
}

type HtmlCheckpoint = {
  commitId: string
  hash: string
  content: string
}

type SessionTrace = {
  sessionId: string
  startedAt: number
  htmlCommits: HtmlCommit[]
  htmlCheckpoints: HtmlCheckpoint[]
  nextHtmlSeq: number
  lastHtml: string
  lastHtmlHash: string | null
  lastHtmlCommitId: string | null
}

type BundleFile = {
  name: string
  content: string
}

const HTML_TRACE_DIR = 'trace/html'
const SCREEN_TRACE_DIR = 'trace/screen'
const HTML_CHECKPOINT_EVERY = 20
const HTML_MAX_COMMITS = 200

const traces = new Map<string, SessionTrace>()

function getTrace(sessionId: string): SessionTrace {
  let trace = traces.get(sessionId)
  if (!trace) {
    trace = {
      sessionId,
      startedAt: Date.now(),
      htmlCommits: [],
      htmlCheckpoints: [],
      nextHtmlSeq: 0,
      lastHtml: '',
      lastHtmlHash: null,
      lastHtmlCommitId: null,
    }
    traces.set(sessionId, trace)
  }
  return trace
}


function nowIso(ts: number): string {
  return new Date(ts).toISOString()
}

function buildDelta(base: string, next: string, baseHash: string): TextDelta {
  let prefixLen = 0
  const maxPrefix = Math.min(base.length, next.length)
  while (prefixLen < maxPrefix && base.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)) {
    prefixLen++
  }

  let suffixLen = 0
  const maxSuffix = Math.min(base.length - prefixLen, next.length - prefixLen)
  while (
    suffixLen < maxSuffix &&
    base.charCodeAt(base.length - 1 - suffixLen) === next.charCodeAt(next.length - 1 - suffixLen)
  ) {
    suffixLen++
  }

  return {
    baseHash,
    prefixLen,
    suffixLen,
    insert: next.slice(prefixLen, next.length - suffixLen),
  }
}

function pruneHtmlTrace(trace: SessionTrace): void {
  if (trace.htmlCommits.length <= HTML_MAX_COMMITS) return
  const overflow = trace.htmlCommits.length - HTML_MAX_COMMITS
  let checkpointIndex = 0
  for (let index = 0; index <= overflow; index++) {
    if (trace.htmlCommits[index]?.checkpoint) checkpointIndex = index
  }
  // Replay correctness beats an exact commit cap. A previous implementation
  // promoted the first retained non-checkpoint commit and filled its checkpoint
  // content with `lastHtml`, which paired an old hash with new HTML. That made
  // debug bundles worse than incomplete: replay metadata could confidently show
  // the wrong DOM. We instead keep the nearest real checkpoint at or before the
  // target window, so the cap is soft by at most HTML_CHECKPOINT_EVERY - 1
  // commits and every checkpoint hash still describes its own content.
  trace.htmlCommits.splice(0, checkpointIndex)

  const first = trace.htmlCommits[0]
  if (first) {
    first.parentId = null
    first.checkpoint = true
    delete first.delta
  }

  const keepIds = new Set(trace.htmlCommits.filter(commit => commit.checkpoint).map(commit => commit.id))
  trace.htmlCheckpoints = trace.htmlCheckpoints.filter(checkpoint => keepIds.has(checkpoint.commitId))
}

export function recordHtmlTraceSnapshot(
  sessionId: string,
  rawHtml: string,
  reason: TraceReason,
): void {
  if (!rawHtml) return
  const trace = getTrace(sessionId)
  const cleanHtml = sanitizeHtml(rawHtml)
  if (!cleanHtml) return

  const hash = hashText(cleanHtml)
  if (hash === trace.lastHtmlHash) return

  const ts = Date.now()
  const seq = trace.nextHtmlSeq++
  const checkpoint = trace.htmlCommits.length === 0 || seq % HTML_CHECKPOINT_EVERY === 0
  const commit: HtmlCommit = {
    id: `${seq.toString(36)}-${hash}`,
    parentId: trace.lastHtmlCommitId,
    seq,
    ts,
    tsIso: nowIso(ts),
    reason,
    hash,
    size: cleanHtml.length,
    checkpoint,
  }

  if (checkpoint || trace.lastHtmlHash === null) {
    commit.parentId = trace.lastHtmlCommitId
    trace.htmlCheckpoints.push({
      commitId: commit.id,
      hash,
      content: cleanHtml,
    })
  } else {
    commit.delta = buildDelta(trace.lastHtml, cleanHtml, trace.lastHtmlHash)
  }

  trace.htmlCommits.push(commit)
  trace.lastHtml = cleanHtml
  trace.lastHtmlHash = hash
  trace.lastHtmlCommitId = commit.id
  pruneHtmlTrace(trace)
}

/**
 * @param screenSamples main's screen-tail history for this session (#762:
 *   recorded in main from every frame, since the renderer no longer receives
 *   them; fetched with window.api.getScreenDebug).
 */
export function exportDebugTraceFiles(sessionId: string, screenSamples: readonly ScreenTailSample[] = []): BundleFile[] {
  const trace = traces.get(sessionId)
  if (!trace && screenSamples.length === 0) return []
  const htmlCommits = trace?.htmlCommits ?? []
  const htmlCheckpoints = trace?.htmlCheckpoints ?? []

  const capturedAt = Date.now()
  const manifest = {
    schemaVersion: 1,
    sessionId,
    startedAt: trace?.startedAt ?? null,
    startedAtIso: trace ? nowIso(trace.startedAt) : null,
    capturedAt,
    capturedAtIso: nowIso(capturedAt),
    html: {
      commits: htmlCommits.length,
      checkpoints: htmlCheckpoints.length,
      checkpointEvery: HTML_CHECKPOINT_EVERY,
      maxCommits: HTML_MAX_COMMITS,
      latestHash: trace?.lastHtmlHash ?? null,
    },
    screen: {
      samples: screenSamples.length,
      tailLines: SCREEN_TAIL_LINES,
      maxSamples: SCREEN_MAX_SAMPLES,
      latestHash: screenSamples.at(-1)?.hash ?? null,
      mode: 'deduped snapshots; no commit chain; recorded in main',
    },
  }

  const files: BundleFile[] = [
    {
      name: 'trace/manifest.json',
      content: JSON.stringify(manifest, null, 2),
    },
    {
      name: `${HTML_TRACE_DIR}/commits.jsonl`,
      content: htmlCommits.map(commit => JSON.stringify(commit)).join('\n') +
        (htmlCommits.length ? '\n' : ''),
    },
    {
      name: `${HTML_TRACE_DIR}/checkpoints.jsonl`,
      content: htmlCheckpoints.map(checkpoint => JSON.stringify(checkpoint)).join('\n') +
        (htmlCheckpoints.length ? '\n' : ''),
    },
    {
      name: `${SCREEN_TRACE_DIR}/tail-samples.jsonl`,
      content: screenSamples.map(sample => JSON.stringify(sample)).join('\n') +
        (screenSamples.length ? '\n' : ''),
    },
  ]

  const latestScreen = screenSamples[screenSamples.length - 1]
  if (latestScreen) {
    files.push({
      name: `${SCREEN_TRACE_DIR}/latest-tail.txt`,
      content: latestScreen.content,
    })
  }

  return files
}

export function forgetDebugTrace(sessionId: string): void {
  // Traces are module-level because capture calls come from several renderer
  // surfaces that do not share React state. That shape is correct for active
  // sessions but dangerous after teardown: bounded-per-session arrays still
  // become unbounded if closed session ids stay in the map forever.
  traces.delete(sessionId)
}
