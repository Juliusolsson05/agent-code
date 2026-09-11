import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { open, stat } from 'fs/promises'

import { performanceService } from '@main/performance/PerformanceService.js'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'

// Incremental user-prompt reader over an append-only provider transcript.
//
// Moved verbatim from src/main/sessionIndex.ts (#735) so the conversation
// catalog can list a row's prompts, search them, and feed View Prompts
// without the discovery/search code that surrounded it there. The byte-range
// contract is unchanged: a listing folds the tail it needs, growth folds only
// the appended bytes, search extends to the head once, and a rewrite starts a
// cold entry. Its tests moved with it.
//
// ONE behaviour change from the original: texts starting with `<` are no
// longer dropped here. The old filter treated every angle-bracket prefix as a
// Claude Code system wrapper, which is false for `<stt …>` (a real prompt the
// user dictated) and loses the task text inside `<orchestration-handoff>`.
// What a wrapper means is the catalog's decision (catalog/unwrap.ts); this
// module reports what the transcript holds.

export type FoldedPrompt = {
  text: string
  /** Epoch ms if the entry's ISO timestamp parsed, else null. */
  ts: number | null
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = {
  mtime: number
  size: number
  /** Cwd captured from the same records the prompts were folded from —
   *  Claude stamps it on every conversation entry, Codex only in the
   *  session_meta at the head (see readHeadCwd). '' until found. */
  cwd: string
  /** Chronological (oldest first). Public results reverse a copy. */
  prompts: FoldedPrompt[]
  /** Byte range `[parsedFrom, parsedTo)` already folded into `prompts`.
   *  Both sit on line boundaries. `parsedFrom === 0` means the head has
   *  been parsed, i.e. `prompts` is complete for the range. */
  parsedFrom: number
  parsedTo: number
  /** Codex only: the head was already searched for a cwd and had none, so
   *  growth reads must not re-read it every time. */
  headCwdChecked?: boolean
  /** The last bytes of the parsed range (up to SEAM_BYTES, ending at
   *  `parsedTo`). A growth read re-reads and compares them first: the
   *  providers' files are append-only by convention, not by guarantee, and a
   *  rewrite that happens to end larger must not be folded on top of stale
   *  prompts. Byte-for-byte on a real tail is a far stronger check than
   *  "is the byte before parsedTo still a newline". */
  seam?: Buffer
  /** Bytes read by the most recent extraction (test/diagnostic hook). */
  lastBytesRead?: number
}

// WHY a byte range instead of "the whole file, keyed by mtime" (#735): both
// providers' transcripts are append-only, and the picker lists the most
// recently MODIFIED transcripts — the live sessions, whose mtime moves every
// few seconds. Keying on mtime alone made every open a cache miss for exactly
// the largest files (122 MB across the top ten on the machine this was
// measured on), each re-read from byte 0, split and parsed on the main
// thread to show four prompts. With a parsed range the entry extends by the
// appended bytes on growth, and a listing that only needs the newest K
// prompts folds the tail first and stops.
// WHY the cache is larger than the search bound: a search folds up to
// SEARCH_CANDIDATES_PER_PROVIDER transcripts per provider, and every one of
// them must still be cached when the next keystroke arrives or the search
// thrashes the LRU and re-reads everything. Keep this above the sum of the
// per-provider bounds plus the listing's ten.
const PROMPT_CACHE_MAX_ENTRIES = 1024
const SEAM_BYTES = 64
const TAIL_WINDOW_BYTES = 256 * 1024
const HEAD_CWD_WINDOW_BYTES = 64 * 1024

/** Keyed by provider session id. Codex session ids are globally
 *  unique (uuid); Claude session ids are uuids too. No collisions
 *  across providers in practice, but we prefix to be safe. Bounded:
 *  every transcript ever listed or searched used to stay here forever
 *  with its full prompt list. */
const promptCache = new Map<string, CacheEntry>()

function cacheGet(key: string): CacheEntry | undefined {
  const entry = promptCache.get(key)
  if (entry === undefined) return undefined
  // Re-insert so Map iteration order doubles as LRU order.
  promptCache.delete(key)
  promptCache.set(key, entry)
  return entry
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (promptCache.has(key)) promptCache.delete(key)
  promptCache.set(key, entry)
  while (promptCache.size > PROMPT_CACHE_MAX_ENTRIES) {
    const oldest = promptCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    promptCache.delete(oldest)
  }
}

/** Test-only hooks: the cache is module state by design (one per process). */
export function __resetPromptFolderCacheForTests(): void {
  promptCache.clear()
}
export function __promptFolderCacheEntryForTests(
  kind: AgentProviderKind,
  sessionId: string,
): { parsedFrom: number; parsedTo: number; prompts: number; cwd: string; lastBytesRead: number } | null {
  const entry = promptCache.get(cacheKey(kind, sessionId))
  if (!entry) return null
  return {
    parsedFrom: entry.parsedFrom,
    parsedTo: entry.parsedTo,
    prompts: entry.prompts.length,
    cwd: entry.cwd,
    lastBytesRead: entry.lastBytesRead ?? 0,
  }
}
export function __promptFolderCacheSizeForTests(): number {
  return promptCache.size
}

function cacheKey(kind: AgentProviderKind, id: string): string {
  return `${kind}:${id}`
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

// ---------------------------------------------------------------------------
// Prompt extraction (per file)
// ---------------------------------------------------------------------------

/** Extract a transcript's user prompts, newest first, reading only what
 *  `need` requires (see the CacheEntry notes for why this is a byte range):
 *
 *    - growth: fold only the bytes appended since the last read;
 *    - `need` = K (listing): on a cold entry fold the tail in a growing
 *      window until K prompts are known or the head is reached;
 *    - `need` = 'all' (search): extend to the head once, incremental after.
 *
 *  A rewrite (size shrank below the parsed range, or the mtime moved with
 *  the size unchanged) drops the entry and starts over — the append-only
 *  assumption no longer holds for that file.
 *
 *  Exported for tests; production callers are the two entry points below. */
export async function extractPromptsFromFile(
  kind: AgentProviderKind,
  sessionId: string,
  file: string,
  need: number | 'all' = 'all',
  options: { maxBytes?: number } = {},
): Promise<{ prompts: FoldedPrompt[]; cwd: string }> {
  // WHY calls for the same transcript are serialised: the cached entry is
  // mutated in place across awaits (fold ranges, prompts). Two overlapping
  // calls — the picker fires a listing on open and again from its debounced
  // effect, and a search keystroke can land while a cold search is still
  // folding — would both capture the same range, both fold the same chunk,
  // and leave duplicated prompts in an entry that then reads as a permanent
  // cache hit. Chaining on the key makes the second call see the committed
  // entry instead.
  const key = cacheKey(kind, sessionId)
  const previous = inflight.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => extractPromptsUnlocked(kind, sessionId, file, need, options.maxBytes))
  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

const inflight = new Map<string, Promise<{ prompts: FoldedPrompt[]; cwd: string }>>()

async function extractPromptsUnlocked(
  kind: AgentProviderKind,
  sessionId: string,
  file: string,
  need: number | 'all',
  maxBytes?: number,
): Promise<{ prompts: FoldedPrompt[]; cwd: string }> {
  const span = performanceService.span('sessionIndex.extractPrompts', {
    kind,
    sessionId,
    file,
    need: need === 'all' ? -1 : need,
  })
  const key = cacheKey(kind, sessionId)
  let entry = cacheGet(key)
  let size: number
  let mtime: number
  try {
    const st = await stat(file)
    size = st.size
    mtime = st.mtime.getTime()
  } catch {
    span.end({ result: 'stat-failed' })
    return { prompts: [], cwd: '' }
  }
  if (
    entry &&
    (size < entry.parsedTo || (mtime !== entry.mtime && size === entry.size))
  ) {
    entry = undefined
  }
  // A listing that asks for nothing still needs the cwd, so read at least one
  // prompt's worth of tail.
  const wanted = need === 'all' ? Number.POSITIVE_INFINITY : Math.max(1, need)
  if (
    entry &&
    entry.mtime === mtime &&
    entry.size === size &&
    (entry.parsedFrom === 0 || entry.prompts.length >= wanted)
  ) {
    span.end({ result: 'cache-hit', prompts: entry.prompts.length })
    return { prompts: entry.prompts.slice().reverse(), cwd: entry.cwd }
  }
  if (!entry) {
    entry = { mtime, size, cwd: '', prompts: [], parsedFrom: size, parsedTo: size }
  }

  let bytesRead = 0
  try {
    if (size > entry.parsedTo && entry.seam && entry.seam.length > 0) {
      // See CacheEntry.seam: verify the tail we parsed is still there before
      // folding what follows it; otherwise the file was rewritten — start
      // over from a cold entry.
      const seam = await readRange(file, entry.parsedTo - entry.seam.length, entry.parsedTo)
      bytesRead += seam.length
      if (!seam.equals(entry.seam)) {
        entry = { mtime, size, cwd: '', prompts: [], parsedFrom: size, parsedTo: size }
      }
    }
    if (size > entry.parsedTo) {
      bytesRead += await foldForward(entry, kind, file, size)
    }
    // WHY a byte budget as well as a prompt count: a rollout with fewer
    // prompts than `need` would otherwise be folded to its head, and the
    // newest two hundred rollouts of one repository total 1.2 GB on the
    // author's machine. Search wants "the prompts in the recent tail" and
    // stops when the budget is spent; the entry keeps parsedFrom > 0, so a
    // later 'all' read (View Prompts) continues backward from there.
    let window = TAIL_WINDOW_BYTES
    while (entry.parsedFrom > 0 && entry.prompts.length < wanted && (maxBytes === undefined || bytesRead < maxBytes)) {
      bytesRead += await foldBackward(entry, kind, file, window)
      window *= 4
    }
    if (!entry.cwd && kind === 'codex' && entry.parsedFrom > 0 && !entry.headCwdChecked) {
      entry.cwd = await readHeadCwd(file, size)
      entry.headCwdChecked = true
    }
  } catch {
    span.end({ result: 'read-failed' })
    return { prompts: [], cwd: '' }
  }
  entry.mtime = mtime
  entry.size = size
  entry.lastBytesRead = bytesRead
  cacheSet(key, entry)
  span.end({
    result: 'parsed',
    bytes: bytesRead,
    prompts: entry.prompts.length,
    parsedFrom: entry.parsedFrom,
    hasCwd: entry.cwd.length > 0,
  })
  return { prompts: entry.prompts.slice().reverse(), cwd: entry.cwd }
}

const NEWLINE = 0x0a

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, end - start))
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === buf.length ? buf : buf.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Fold the bytes appended after `entry.parsedTo`. Only complete lines are
 *  folded: a trailing partial line (the provider mid-write) stays outside the
 *  range so it is parsed whole once its newline lands. */
async function foldForward(
  entry: CacheEntry,
  kind: AgentProviderKind,
  file: string,
  size: number,
): Promise<number> {
  const buf = await readRange(file, entry.parsedTo, size)
  const lastNewline = buf.lastIndexOf(NEWLINE)
  if (lastNewline < 0) return buf.length
  const text = buf.subarray(0, lastNewline + 1).toString('utf8')
  const folded = foldLines(kind, text, lastPromptText(entry.prompts))
  entry.prompts.push(...folded.prompts)
  if (!entry.cwd && folded.cwd) entry.cwd = folded.cwd
  entry.parsedTo = entry.parsedTo + lastNewline + 1
  entry.seam = seamOf(buf, lastNewline + 1)
  return buf.length
}

// A private copy of the last SEAM_BYTES bytes before `end` in `buf`; a copy so
// the entry never keeps a whole read buffer alive through a subarray.
function seamOf(buf: Buffer, end: number): Buffer {
  const start = Math.max(0, end - SEAM_BYTES)
  return Buffer.from(buf.subarray(start, end))
}

/** Fold up to `window` bytes older than `entry.parsedFrom`. If the window
 *  contains no line boundary at all the line is longer than the window;
 *  keep widening rather than parse a fragment. */
async function foldBackward(
  entry: CacheEntry,
  kind: AgentProviderKind,
  file: string,
  window: number,
): Promise<number> {
  let bytes = 0
  let start = Math.max(0, entry.parsedFrom - window)
  for (;;) {
    const end = entry.parsedFrom
    const buf = await readRange(file, start, end)
    bytes += buf.length
    // Head alignment: unless we are at byte 0 the first line is partial.
    let from = 0
    if (start > 0) {
      const firstNewline = buf.indexOf(NEWLINE)
      if (firstNewline < 0) {
        // The whole window sat inside one line (a pasted image can be a
        // single multi-MB record). Widen geometrically: a constant step here
        // re-reads the same prefix on every iteration — quadratic for a line
        // that is a large multiple of the window.
        window *= 2
        start = Math.max(0, start - window)
        continue
      }
      from = firstNewline + 1
    }
    // Tail alignment applies only to the very first read of a cold entry,
    // whose range still ends at EOF and may include a partial line.
    let to = buf.length
    if (entry.parsedFrom === entry.parsedTo) {
      const lastNewline = buf.lastIndexOf(NEWLINE)
      if (lastNewline < from) {
        if (start === 0) {
          entry.parsedFrom = 0
          entry.parsedTo = from
          break
        }
        window *= 2
        start = Math.max(0, start - window)
        continue
      }
      to = lastNewline + 1
      entry.parsedTo = start + to
      entry.seam = seamOf(buf, to)
    }
    const text = buf.subarray(from, to).toString('utf8')
    const folded = foldLines(kind, text, null)
    // Seam: the adjacent-duplicate rule keeps the OLDER occurrence, so if the
    // newest folded prompt repeats the oldest one already held, the held one
    // is the later duplicate and goes.
    const older = folded.prompts
    if (
      older.length > 0 &&
      entry.prompts.length > 0 &&
      older[older.length - 1]!.text === entry.prompts[0]!.text
    ) {
      entry.prompts.shift()
    }
    entry.prompts.unshift(...older)
    if (!entry.cwd && folded.cwd) entry.cwd = folded.cwd
    entry.parsedFrom = start + from
    break
  }
  return bytes
}

/** Codex writes its cwd only in the session_meta record at the head, which a
 *  tail-first read never sees. One bounded head read, cached with the entry. */
async function readHeadCwd(file: string, size: number): Promise<string> {
  const buf = await readRange(file, 0, Math.min(size, HEAD_CWD_WINDOW_BYTES))
  const lastNewline = buf.lastIndexOf(NEWLINE)
  const text = (lastNewline < 0 ? buf : buf.subarray(0, lastNewline + 1)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const obj = parseJsonRecord(line)
    if (!obj) continue
    const cwd = recordCwd('codex', obj)
    if (cwd) return cwd
  }
  return ''
}

function lastPromptText(prompts: readonly FoldedPrompt[]): string | null {
  return prompts.length > 0 ? prompts[prompts.length - 1]!.text : null
}

/** Fold complete JSONL lines into chronological prompts. `previousText` seeds
 *  the adjacent-duplicate rule across a chunk boundary (forward growth). */
function foldLines(
  kind: AgentProviderKind,
  jsonl: string,
  previousText: string | null,
): { prompts: FoldedPrompt[]; cwd: string } {
  const chronological: FoldedPrompt[] = []
  let cwd = ''
  let lastText = previousText
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    const obj = parseJsonRecord(line)
    if (!obj) continue
    if (!cwd) cwd = recordCwd(kind, obj)
    const prompt = kind === 'claude' ? foldClaudeRecord(obj) : foldCodexRecord(obj)
    if (!prompt) continue
    if (prompt.text === lastText) continue
    chronological.push(prompt)
    lastText = prompt.text
  }
  return { prompts: chronological, cwd }
}

function recordCwd(kind: AgentProviderKind, obj: Record<string, unknown>): string {
  // Claude stamps cwd on conversation entries (user / assistant) but NOT on
  // permission-mode or hook_success attachment entries. Codex carries it
  // either at the top level or under session_meta's payload.
  const topCwd = obj.cwd
  if (typeof topCwd === 'string' && topCwd.length > 0) return topCwd
  if (kind === 'codex') {
    const payloadCwd = asRecord(obj.payload)?.cwd
    if (typeof payloadCwd === 'string' && payloadCwd.length > 0) return payloadCwd
  }
  return ''
}

/** Claude user prompt filter. Mirrors renderer/.../latestUserPrompts.ts:
 *   - only role=user conversation entries
 *   - skip compact-summary entries
 *   - skip isMeta entries
 *   - skip text starting with '<' (CC injects <command-message>,
 *     <command-name>, <local-command-stdout> wrappers for its own
 *     system prompts)
 *  Adjacent-duplicate suppression (CC occasionally double-records) is the
 *  caller's, so it can span chunk boundaries. */
function foldClaudeRecord(obj: Record<string, unknown>): FoldedPrompt | null {
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type !== 'user') return null
  if (obj.isCompactSummary === true) return null
  if (obj.isMeta === true) return null
  if (obj.permissionMode === undefined) return null
  const message = asRecord(obj.message)
  if (!message) return null
  if (message.role !== 'user') return null
  const text = extractClaudeUserText(message.content)
  if (!text) return null
  const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
  return { text, ts: Number.isFinite(ts) ? ts : null }
}

function extractClaudeUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    const b = asRecord(block)
    const text = stringField(b, 'text')
    if (b?.type === 'text' && text) {
      return text.trim()
    }
  }
  return ''
}

function foldCodexRecord(obj: Record<string, unknown>): FoldedPrompt | null {
  let text = ''
  let ts: number | null = null
  const type = typeof obj.type === 'string' ? obj.type : ''
  const payload = asRecord(obj.payload)
  if (type === 'response_item') {
    const item = payload ?? obj
    const itemType = typeof item.type === 'string' ? item.type : ''
    const role = typeof item.role === 'string' ? item.role : ''
    if (itemType !== 'message' || role !== 'user') return null
    text = flattenCodexContent(item.content)
  } else if (type === 'event_msg') {
    const msgType = typeof payload?.type === 'string' ? payload.type : ''
    if (msgType !== 'user_message') return null
    const maybeText = payload?.message
    if (typeof maybeText === 'string') text = maybeText.trim()
  } else if (type === 'message' && (obj.role === 'user')) {
    text = flattenCodexContent(obj.content)
  } else {
    return null
  }
  text = text.trim()
  if (!text) return null
  const tsField = obj.timestamp ?? payload?.timestamp
  if (typeof tsField === 'string') {
    const parsed = Date.parse(tsField)
    if (Number.isFinite(parsed)) ts = parsed
  }
  return { text, ts }
}

function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const entry of content) {
    const obj = asRecord(entry)
    const t = stringField(obj, 'type')
    const text = stringField(obj, 'text')
    if ((t === 'input_text' || t === 'text') && text) {
      parts.push(text)
    } else if (t === 'input_image') {
      parts.push('[image]')
    }
  }
  return parts.join(' ')
}

