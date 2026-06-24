import { sanitizeHtml } from '@renderer/lib/sanitizeHtml'

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

type ScreenTailSample = {
  id: string
  seq: number
  ts: number
  tsIso: string
  hash: string
  lineCount: number
  content: string
}

type SessionTrace = {
  sessionId: string
  startedAt: number
  htmlCommits: HtmlCommit[]
  htmlCheckpoints: HtmlCheckpoint[]
  screenSamples: ScreenTailSample[]
  nextHtmlSeq: number
  nextScreenSeq: number
  lastHtml: string
  lastHtmlHash: string | null
  lastHtmlCommitId: string | null
  lastScreenHash: string | null
}

type BundleFile = {
  name: string
  content: string
}

const HTML_TRACE_DIR = 'trace/html'
const SCREEN_TRACE_DIR = 'trace/screen'
const HTML_CHECKPOINT_EVERY = 20
const HTML_MAX_COMMITS = 200
const SCREEN_MAX_SAMPLES = 300
const SCREEN_TAIL_LINES = 50

const traces = new Map<string, SessionTrace>()

function getTrace(sessionId: string): SessionTrace {
  let trace = traces.get(sessionId)
  if (!trace) {
    trace = {
      sessionId,
      startedAt: Date.now(),
      htmlCommits: [],
      htmlCheckpoints: [],
      screenSamples: [],
      nextHtmlSeq: 0,
      nextScreenSeq: 0,
      lastHtml: '',
      lastHtmlHash: null,
      lastHtmlCommitId: null,
      lastScreenHash: null,
    }
    traces.set(sessionId, trace)
  }
  return trace
}

function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(13, '0')
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

function sanitizeScreenText(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n\t]+$/gm, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trimEnd()
}

function tailLines(text: string, count: number): string {
  const lines = text.split('\n')
  return lines.length <= count ? text : lines.slice(lines.length - count).join('\n')
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

export function recordScreenTailSnapshot(sessionId: string, screenText: string): void {
  const trace = getTrace(sessionId)
  const content = tailLines(sanitizeScreenText(screenText), SCREEN_TAIL_LINES)
  if (!content) return

  const hash = hashText(content)
  if (hash === trace.lastScreenHash) return

  const ts = Date.now()
  const seq = trace.nextScreenSeq++
  trace.screenSamples.push({
    id: `${seq.toString(36)}-${hash}`,
    seq,
    ts,
    tsIso: nowIso(ts),
    hash,
    lineCount: content.split('\n').length,
    content,
  })
  trace.lastScreenHash = hash

  if (trace.screenSamples.length > SCREEN_MAX_SAMPLES) {
    trace.screenSamples.splice(0, trace.screenSamples.length - SCREEN_MAX_SAMPLES)
  }
}

export function exportDebugTraceFiles(sessionId: string): BundleFile[] {
  const trace = traces.get(sessionId)
  if (!trace) return []

  const capturedAt = Date.now()
  const manifest = {
    schemaVersion: 1,
    sessionId,
    startedAt: trace.startedAt,
    startedAtIso: nowIso(trace.startedAt),
    capturedAt,
    capturedAtIso: nowIso(capturedAt),
    html: {
      commits: trace.htmlCommits.length,
      checkpoints: trace.htmlCheckpoints.length,
      checkpointEvery: HTML_CHECKPOINT_EVERY,
      maxCommits: HTML_MAX_COMMITS,
      latestHash: trace.lastHtmlHash,
    },
    screen: {
      samples: trace.screenSamples.length,
      tailLines: SCREEN_TAIL_LINES,
      maxSamples: SCREEN_MAX_SAMPLES,
      latestHash: trace.lastScreenHash,
      mode: 'deduped snapshots; no commit chain',
    },
  }

  const files: BundleFile[] = [
    {
      name: 'trace/manifest.json',
      content: JSON.stringify(manifest, null, 2),
    },
    {
      name: `${HTML_TRACE_DIR}/commits.jsonl`,
      content: trace.htmlCommits.map(commit => JSON.stringify(commit)).join('\n') +
        (trace.htmlCommits.length ? '\n' : ''),
    },
    {
      name: `${HTML_TRACE_DIR}/checkpoints.jsonl`,
      content: trace.htmlCheckpoints.map(checkpoint => JSON.stringify(checkpoint)).join('\n') +
        (trace.htmlCheckpoints.length ? '\n' : ''),
    },
    {
      name: `${SCREEN_TRACE_DIR}/tail-samples.jsonl`,
      content: trace.screenSamples.map(sample => JSON.stringify(sample)).join('\n') +
        (trace.screenSamples.length ? '\n' : ''),
    },
  ]

  const latestScreen = trace.screenSamples[trace.screenSamples.length - 1]
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
