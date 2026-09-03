import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { FileHandle } from 'fs/promises'
import { open, stat } from 'fs/promises'

import { performanceService } from '@main/performance/PerformanceService.js'
import { makeStringPool, internEntryFields } from '@main/sessions/internEntry.js'
import { resolveProviderTranscriptPath } from '@main/providerSwitch/shared.js'

// Loader for the bootstrap tail and for older history chunks.
//
// When a session is resumed the renderer asks main for the newest `limit`
// durable transcript records (`session:load-initial-history`), and when the
// user scrolls up past that window it asks for the chunk immediately before
// the `beforeMarker` it already has (`session:load-older-history`). This
// module walks the provider's on-disk JSONL transcript for both.
//
// WHY the file is read BACKWARDS from EOF (#747): both requests want records
// at or near the tail, but the first implementation streamed the whole file
// through readline + JSON.parse and kept a ring buffer of the last `limit`.
// On a workspace restore that ran for every resumed session in the first
// seconds of boot — 25 loads read 252 MB in 10.7 s of main-thread time, and
// one 89 MB rollout took 4.6 s to hand back 120 entries. The bytes that
// matter are the last few hundred KB; everything before them was parsed only
// to be thrown away (initial tail) or to find the anchor (older page). Reading
// blocks backwards and stopping as soon as the window is complete makes the
// parse cost proportional to the WINDOW, not the file.
//
// The marker is provider-specific:
//   - Claude entries expose a stable `uuid`; progress-wrapped entries
//     carry the same uuid on their embedded message.
//   - Codex rollouts don't have a uuid, so we synthesize a marker from
//     timestamp + a stable field inside the payload (id / call_id /
//     type). That's good enough for chunk alignment; the renderer
//     never persists these markers across sessions.

export type HistoryChunkRequest = {
  kind: AgentProviderKind
  cwd: string
  providerSessionId: string
  beforeMarker: string
  limit: number
}

export type InitialHistoryChunkRequest = Omit<HistoryChunkRequest, 'beforeMarker'>

export type HistoryChunk = {
  entries: Record<string, unknown>[]
  hasMore: boolean
  // Total count of usable JSONL records in the on-disk transcript at
  // the moment this chunk was read. Set on initial-load chunks. Older-
  // history pagination omits it because the renderer keeps its own
  // running total from the initial load + live appends, and counting
  // the whole file just to page one older window would reintroduce the
  // read-everything cost this loader is specifically avoiding.
  totalEntries?: number
}

// WHY 256 KiB: the initial window is 120 records and a typical Claude/Codex
// record is 1–5 KB, so the whole tail usually fits in one or two blocks and
// the loader issues one or two reads. Tool results and pasted images can push
// single records to hundreds of KB or more; the line assembly below handles
// those by carrying chunks across blocks, so a larger block would only buy
// fewer syscalls on an already-rare path while every ordinary load would read
// (and allocate) more than it needs. The same size the session picker's tail
// window uses (sessionIndex.ts), for the same reason.
const TAIL_BLOCK_BYTES = 256 * 1024

// WHY a bigger block for the newline count: that pass touches every byte
// before the tail with no decode and no parse, so its only cost is syscalls
// and the memchr-speed scan; 1 MiB keeps an 89 MB file at ~90 reads.
const COUNT_BLOCK_BYTES = 1024 * 1024

const NEWLINE = 0x0a

function extractClaudeHistoryMarker(entry: Record<string, unknown>): string | null {
  if (typeof entry.uuid === 'string' && entry.uuid.length > 0) return entry.uuid
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  return typeof embedded?.uuid === 'string' && embedded.uuid.length > 0
    ? embedded.uuid
    : null
}

function extractCodexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}

async function resolveHistoryTranscriptPath(
  params: InitialHistoryChunkRequest,
): Promise<string | null> {
  // Use the same resolver as transcript templates/provider-switch flows. The
  // old history-loader-local walker returned the first lexical match; the shared
  // resolver picks newest by mtime, which is the correct tie-break when the same
  // Codex thread id appears in more than one rollout file.
  return resolveProviderTranscriptPath(params)
}

/**
 * Read exactly `[start, end)` from `handle`. A short read means the file is
 * smaller than the size we stat'ed a moment ago, i.e. it was truncated or
 * rewritten under us. Both providers append only, so that is not a state
 * this loader can make sense of: the blocks already consumed to the right
 * would no longer be contiguous with this one and any line assembled across
 * the gap would be garbage. Throwing turns it into the ordinary read-failed
 * path (an empty chunk), which is honest and what a vanished file produces.
 */
async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start))
  let offset = 0
  while (offset < buf.length) {
    const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== buf.length) {
    throw new Error(`transcript shrank while reading [${start}, ${end}) — got ${offset} bytes`)
  }
  return buf
}

/**
 * Walk the lines of `[0, size)` NEWEST FIRST, reading `blockBytes` at a time
 * backwards from `size`. `onLine` receives every line (blank ones and an
 * unterminated final line included — the caller decides what a line means)
 * together with the absolute offset of its first byte, and returns `true`
 * to stop. Returns the number of bytes read, which is what makes the
 * "bounded by the window" claim testable.
 *
 * WHY lines are split on the NEWLINE BYTE and decoded only once complete:
 * 0x0A never occurs inside a multi-byte UTF-8 sequence (continuation bytes
 * are 0x80–0xBF, lead bytes 0xC2+), so a newline byte is always a character
 * boundary and no block boundary can be mistaken for one. A character that
 * straddles two blocks lives inside one line, and that line is assembled
 * from both blocks before `toString('utf8')` sees it, so it decodes exactly
 * as the forward reader decoded it.
 *
 * WHY the carried head is a LIST of chunks concatenated once: a single
 * record can be far larger than a block (a pasted image is a multi-MB line).
 * Concatenating the carry on every block would copy the growing prefix
 * again per block — quadratic in the record's size. Collecting the chunks
 * and joining them when the line's leading newline finally appears is one
 * copy per byte. (The chunks are subarrays, so each block buffer stays
 * alive until its line completes; that is bounded by the line's length.)
 */
async function readLinesBackward(
  handle: FileHandle,
  size: number,
  blockBytes: number,
  onLine: (line: Buffer, start: number) => boolean,
): Promise<number> {
  let bytesRead = 0
  let end = size
  // The not-yet-terminated head of the line that continues to the LEFT of
  // `end`, in file order (oldest chunk first). Empty when `end` sits right
  // after a newline or at EOF.
  let pending: Buffer[] = []
  while (end > 0) {
    const start = Math.max(0, end - blockBytes)
    const buf = await readRange(handle, start, end)
    bytesRead += buf.length
    // `cursor` is the exclusive end of the segment we have not yet assigned
    // to a line, scanning right to left.
    let cursor = buf.length
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      if (buf[i] !== NEWLINE) continue
      const head = buf.subarray(i + 1, cursor)
      const line = pending.length === 0 ? head : Buffer.concat([head, ...pending])
      pending = []
      cursor = i
      if (onLine(line, start + i + 1)) return bytesRead
    }
    if (cursor > 0) pending.unshift(buf.subarray(0, cursor))
    end = start
  }
  // The file's first line has no newline before it. An empty `pending` here
  // means the file starts with a newline (or is empty), which is no line.
  if (pending.length > 0) {
    onLine(pending.length === 1 ? pending[0]! : Buffer.concat(pending), 0)
  }
  return bytesRead
}

/**
 * Count newline bytes in `[from, to)` — no decode, no parse, one reused
 * buffer. This is how `totalEntries` accounts for the part of the file the
 * tail read never parsed. WHY counting lines is an acceptable stand-in for
 * counting usable records there: the two differ only on blank or malformed
 * lines, and the only malformed line a provider ever writes is the partial
 * one at the very END of the file (mid-append), which is inside the parsed
 * tail. So for provider-written transcripts the count is exact; only a
 * hand-edited file with junk in its head would be over-counted, and a full
 * parse to make a scroll denominator exact for corrupt files is precisely
 * the cost #747 removed. Callers only ever pass a `to` that sits on a line
 * boundary, so every counted newline terminates a whole line.
 */
async function countNewlines(handle: FileHandle, from: number, to: number): Promise<number> {
  if (to <= from) return 0
  const buf = Buffer.allocUnsafe(Math.min(COUNT_BLOCK_BYTES, to - from))
  let count = 0
  let pos = from
  while (pos < to) {
    const want = Math.min(buf.length, to - pos)
    const { bytesRead } = await handle.read(buf, 0, want, pos)
    if (bytesRead === 0) {
      throw new Error(`transcript shrank while counting at ${pos} of ${to}`)
    }
    let i = buf.indexOf(NEWLINE, 0)
    while (i !== -1 && i < bytesRead) {
      count += 1
      i = buf.indexOf(NEWLINE, i + 1)
    }
    pos += bytesRead
  }
  return count
}

/**
 * The line contract of the forward reader (`streamJsonl`), applied to one
 * raw line: `undefined` for a blank line (neither a record nor an error —
 * readline skipped these before parsing), `null` for a line that does not
 * parse (a parse error the caller counts), otherwise the parsed value. A
 * literal `null` line is indistinguishable from a parse failure, exactly as
 * it was when `streamJsonl` yielded null for both. `\r\n` needs no special
 * casing: `trim()` sees a lone `\r` as blank and `JSON.parse` accepts the
 * trailing `\r` as whitespace.
 */
function parseJsonlLine(line: Buffer): Record<string, unknown> | null | undefined {
  const text = line.toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

async function readInitialTranscriptTail(
  filePath: string,
  limit: number,
  blockBytes: number = TAIL_BLOCK_BYTES,
): Promise<{
  bytes: number
  // Bytes read (and parsed) to assemble the window — bounded by the window
  // plus one block, never by the file. Exposed for the span and for tests.
  tailBytes: number
  parseErrors: number
  // Usable records in the whole file: those parsed in the tail plus the
  // line count of the untouched head (see countNewlines for why that is
  // exact for provider-written files).
  parsed: number
  entries: Record<string, unknown>[]
}> {
  const size = await stat(filePath).then(s => s.size).catch(() => 0)
  const empty = { bytes: size, tailBytes: 0, parseErrors: 0, parsed: 0, entries: [] }
  if (size === 0 || limit <= 0) return empty

  // #288: one local pool per load. Every parsed line freshly allocates its
  // cwd/sessionId/role/type metadata strings; interning them against a pool
  // scoped to this single load collapses them to one instance each. The pool
  // dies with this function, so it can never become the global leak that a
  // shared pool would. See internEntry.ts for the full retainer-trace
  // evidence (cwd ×30k, role/type ×23k, sessionId ×20k per session).
  const intern = makeStringPool()

  let handle: FileHandle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return empty
  }
  try {
    let parseErrors = 0
    let parsedInTail = 0
    // Newest first while collecting; reversed once at the end.
    const newestFirst: Record<string, unknown>[] = []
    // Start offset of the oldest line the tail walk parsed. Everything in
    // [0, headEnd) is whole, unparsed lines. Stays 0 when the walk reached
    // the head of the file, in which case there is nothing left to count.
    let headEnd = 0

    // WHY `limit + 1`: `hasMore` promises "at least one more usable record
    // exists before this window", the same meaning the full parse gave it
    // via `parsed > limit`. Finding the (limit+1)th record proves that
    // without parsing anything further; the record itself is dropped.
    const tailBytes = await readLinesBackward(handle, size, blockBytes, (line, start) => {
      const value = parseJsonlLine(line)
      if (value === undefined) return false
      if (value === null) {
        parseErrors += 1
        return false
      }
      parsedInTail += 1
      internEntryFields(value, intern)
      newestFirst.push(value)
      if (parsedInTail > limit) {
        headEnd = start
        return true
      }
      return false
    })
    const headLines = await countNewlines(handle, 0, headEnd)
    newestFirst.length = Math.min(newestFirst.length, limit)
    return {
      bytes: size,
      tailBytes,
      parseErrors,
      parsed: parsedInTail + headLines,
      entries: newestFirst.reverse(),
    }
  } catch {
    return empty
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readOlderTranscriptWindow(
  filePath: string,
  params: { kind: AgentProviderKind; beforeMarker: string; limit: number },
  blockBytes: number = TAIL_BLOCK_BYTES,
): Promise<{
  bytes: number
  tailBytes: number
  parseErrors: number
  parsed: number
  foundMarker: boolean
  hasMore: boolean
  entries: Record<string, unknown>[]
}> {
  const size = await stat(filePath).then(s => s.size).catch(() => 0)
  const empty = {
    bytes: size,
    tailBytes: 0,
    parseErrors: 0,
    parsed: 0,
    foundMarker: false,
    hasMore: false,
    entries: [],
  }
  if (size === 0) return empty
  const markerOf = params.kind === 'claude'
    ? extractClaudeHistoryMarker
    : extractCodexHistoryMarker

  // #288: local pool for this older-window load (same rationale as the
  // initial-tail reader above — intern the duplicated metadata, drop the
  // pool when the load returns). Only entries we may return are interned;
  // the ones scanned past while hunting the anchor never need it.
  const intern = makeStringPool()

  let handle: FileHandle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return empty
  }
  try {
    let parseErrors = 0
    let parsed = 0
    let hunting = true
    // WHY the newest `limit + 1` records are kept while hunting: the
    // historical fallback for an anchor that is NOT in the file is "page
    // from the file tail", because a live-append race can leave the renderer
    // asking before a marker the durable transcript never got. Walking
    // newest-first, the tail is simply the first records we meet, so keeping
    // them costs nothing extra and the fallback needs no second read.
    const tailFallback: Record<string, unknown>[] = []
    // Records before the anchor, newest first, up to `limit + 1` — the extra
    // one exists only to make `hasMore` exact (see the initial reader).
    const older: Record<string, unknown>[] = []

    // WHY this anchors on the NEWEST occurrence of a duplicated marker where
    // the forward scan anchored on the oldest: the renderer's window grows
    // contiguously from the tail, so the occurrence at its edge is the newest
    // one. Stopping at an older duplicate would skip every record between
    // the two. Codex markers are synthesized from timestamp + payload id and
    // can in principle collide; Claude uuids should not.
    const tailBytes = await readLinesBackward(handle, size, blockBytes, line => {
      const value = parseJsonlLine(line)
      if (value === undefined) return false
      if (value === null) {
        parseErrors += 1
        return false
      }
      parsed += 1
      if (hunting) {
        if (markerOf(value) === params.beforeMarker) {
          hunting = false
        } else if (tailFallback.length <= params.limit) {
          internEntryFields(value, intern)
          tailFallback.push(value)
        }
        return false
      }
      internEntryFields(value, intern)
      older.push(value)
      return older.length > params.limit
    })
    const foundMarker = !hunting
    const kept = foundMarker ? older : tailFallback
    const hasMore = kept.length > params.limit
    kept.length = Math.min(kept.length, Math.max(0, params.limit))
    return {
      bytes: size,
      tailBytes,
      parseErrors,
      parsed,
      foundMarker,
      hasMore,
      entries: kept.reverse(),
    }
  } catch {
    return empty
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Locate `beforeMarker` from the tail of the transcript and return up to
 * `limit` entries immediately preceding it. `hasMore: true` means
 * there's still earlier history the renderer can request.
 */
export async function loadOlderHistoryChunk(
  params: HistoryChunkRequest,
): Promise<HistoryChunk> {
  // Thin resolver wrapper — the reading work, span bookkeeping, and
  // return shaping all live in the FromFile variant so the two entrypoints
  // cannot drift (review finding: the first extraction duplicated the span
  // + catch scaffolding in both).
  const filePath = await resolveHistoryTranscriptPath(params)
  if (!filePath) {
    performanceService
      .span('historyLoader.loadOlderChunk', { kind: params.kind, limit: params.limit })
      .end({ result: 'missing-file' })
    return { entries: [], hasMore: false }
  }
  return loadOlderHistoryChunkFromFile(filePath, params)
}

/**
 * Path-based variant for callers that already hold the transcript file —
 * the remote mobile companion's get-history serves live sessions whose
 * {cwd, providerSessionId} main cannot reconstruct (cwd is provider-
 * constructor-private; the provider session id exists only inside the
 * jsonl), but whose FILE path rides every jsonl-entry event and is cached
 * on SessionManager. Splitting here rather than teaching remote to fake a
 * resolver input keeps one reader implementation for both entrypoints.
 */
export async function loadOlderHistoryChunkFromFile(
  filePath: string,
  params: { kind: AgentProviderKind; beforeMarker: string; limit: number },
): Promise<HistoryChunk> {
  const span = performanceService.span('historyLoader.loadOlderChunk', {
    kind: params.kind,
    limit: params.limit,
    hasBeforeMarker: params.beforeMarker.length > 0,
  })
  try {
    const parsed = await readOlderTranscriptWindow(filePath, {
      kind: params.kind,
      beforeMarker: params.beforeMarker,
      limit: params.limit,
    })
    return finishOlderChunk(span, parsed, filePath)
  } catch (err) {
    span.fail(err)
    throw err
  }
}

function finishOlderChunk(
  span: ReturnType<typeof performanceService.span>,
  parsed: Awaited<ReturnType<typeof readOlderTranscriptWindow>>,
  filePath: string,
): HistoryChunk {
  if (parsed.entries.length === 0) {
    // filePath in the failure record — losing the file identity is what
    // made past transcript-path bugs (double-applied project dirs, wrong
    // rollout picked) invisible in the perf journal.
    span.end({ result: 'empty-or-read-failed', filePath })
    return { entries: [], hasMore: false }
  }
  span.end({
    result: 'loaded',
    bytes: parsed.bytes,
    tailBytes: parsed.tailBytes,
    parsed: parsed.parsed,
    parseErrors: parsed.parseErrors,
    foundMarker: parsed.foundMarker,
    returned: parsed.entries.length,
    hasMore: parsed.hasMore,
  })
  return { entries: parsed.entries, hasMore: parsed.hasMore }
}

/**
 * Return the newest durable transcript records without waiting for the
 * provider process to replay them over IPC. The renderer still folds
 * this through its normal feed-entry mapper and uuid set, so live
 * replay can arrive before or after this read without double-rendering
 * entries that carry stable ids.
 */
export async function loadInitialHistoryChunk(
  params: InitialHistoryChunkRequest,
): Promise<HistoryChunk> {
  const span = performanceService.span('historyLoader.loadInitialChunk', {
    kind: params.kind,
    limit: params.limit,
  })

  try {
    const filePath = await resolveHistoryTranscriptPath(params)
    if (!filePath) {
      span.end({ result: 'missing-file' })
      return { entries: [], hasMore: false, totalEntries: 0 }
    }
    span.end({ result: 'delegated', filePath })
    return await loadInitialHistoryChunkFromFile(filePath, params.limit)
  } catch (err) {
    span.fail(err)
    throw err
  }
}

/** Path-based variant — same rationale as loadOlderHistoryChunkFromFile. */
export async function loadInitialHistoryChunkFromFile(
  filePath: string,
  limit: number,
): Promise<HistoryChunk> {
  const span = performanceService.span('historyLoader.loadInitialChunk', {
    limit,
    fromFile: true,
  })
  try {
    const parsed = await readInitialTranscriptTail(filePath, limit)
    return finishInitialChunk(span, parsed, limit, filePath)
  } catch (err) {
    span.fail(err)
    throw err
  }
}

function finishInitialChunk(
  span: ReturnType<typeof performanceService.span>,
  parsed: Awaited<ReturnType<typeof readInitialTranscriptTail>>,
  limit: number,
  filePath: string,
): HistoryChunk {
  if (parsed.entries.length === 0) {
    span.end({ result: 'empty-or-read-failed', filePath })
    return { entries: [], hasMore: false, totalEntries: 0 }
  }
  span.end({
    result: 'loaded',
    bytes: parsed.bytes,
    tailBytes: parsed.tailBytes,
    parsed: parsed.parsed,
    parseErrors: parsed.parseErrors,
    returned: parsed.entries.length,
    hasMore: parsed.parsed > limit,
  })
  return {
    entries: parsed.entries,
    hasMore: parsed.parsed > limit,
    totalEntries: parsed.parsed,
  }
}

// Test seams. The readers take a block size so a test can force block
// boundaries to fall inside records (and inside a multi-byte character)
// with a small file instead of a multi-hundred-KB one, and they report the
// bytes read for the window so "bounded by the window, not the file" is an
// assertion rather than a belief. Production callers never pass a block
// size.
export const __readInitialTranscriptTailForTests = readInitialTranscriptTail
export const __readOlderTranscriptWindowForTests = readOlderTranscriptWindow
