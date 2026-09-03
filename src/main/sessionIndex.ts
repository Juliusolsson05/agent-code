import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { open, readdir, stat } from 'fs/promises'
import { join } from 'path'

import { listSessionsForCwd } from '@providers/claude/runtime/sessionList.js'
import { getProjectDirForCwd } from '@shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '@providers/codex/runtime/projectDir.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'

// Session Prompt Index — power source for the "Search Conversation
// Prompts" command.
//
// WHY this file exists:
//   Finding a past session by its NAME is a lost cause — most of them
//   are auto-titled to things like "refactor-codex-renderer" that look
//   identical to a dozen other sessions. Users find sessions by
//   recognising the first 1–2 user prompts they typed. This module
//   reads every transcript on disk, extracts the user-prompt tail, and
//   serves it up for the UI to search across.
//
// Design choices:
//   - Two entry points: listRecent (top-N active sessions with their
//     last-M user prompts) and search (query across ALL prompts with
//     matching-bubbles-to-top ranking). The UI toggles based on
//     whether the user has typed anything.
//   - Linear scan over JSONL files is fine at Agent Code scale; we cap
//     visible sessions and back the rest with search. A proper inverted
//     index would be overkill — a typical user has ≤200 sessions, each
//     with ≤100 user prompts, so we're scanning a few tens of thousands
//     of short strings per query. No SQLite/minisearch needed.
//   - mtime-based cache: parsing a session's prompts is idempotent for
//     a given file mtime. Cache the (mtime, prompts) tuple per session
//     so a second query doesn't re-read the file. Invalidate when
//     stat().mtimeMs changes.
//   - Filtering mirrors the in-conversation filter the Feed uses
//     (`isConversationEntry` + role=user + not compact-summary + not
//     meta + not `<`-prefixed synthetic). The shared lib at
//     renderer/.../latestUserPrompts.ts already encapsulates this, but
//     it assumes pre-parsed Entry[] — we operate on raw JSONL lines
//     here and re-implement the predicates inline. Same shape, same
//     filters.

export type SessionIndexPrompt = {
  text: string
  /** Epoch ms if the entry's ISO timestamp parsed, else null. */
  ts: number | null
}

export type SessionIndexEntry = {
  /** Provider-side uuid (Claude) or rollout uuid (Codex). Stable;
   *  used as the resume argument. */
  providerSessionId: string
  kind: AgentProviderKind
  /** Cwd the session was recorded in (from session_meta for Codex;
   *  from the first entry's cwd field for Claude). Falls back to
   *  empty string if not discoverable. */
  cwd: string
  /** File mtime epoch ms. Primary sort key for the recent view. */
  lastModified: number
  /** One-line summary from the existing session listers (customTitle
   *  for Claude if set, else the last prompt; the first prompt for
   *  Codex). Used as a fallback label when the user hasn't typed
   *  any prompts yet. */
  summary: string
  /** Up to the last N user prompts (newest first). Empty array
   *  when a session exists on disk but has no visible user prompts
   *  (rare — fresh session with only assistant bootstrap text). */
  recentUserPrompts: SessionIndexPrompt[]
  /** Count of matched prompts when returned from search, else 0. */
  matchCount: number
}

type ListRecentOptions = {
  /** How many sessions to include. Default 10. */
  limit?: number
  /** How many prompts per session. Default 4 — enough to recognize
   *  a session visually without bloating the modal. */
  promptsPerSession?: number
  /** Restrict to sessions whose cwd equals this value. When null,
   *  ALL sessions on disk are included. Default: all. The caller
   *  decides — the main process doesn't know the "current" cwd
   *  without asking. */
  cwd?: string | null
}

type SearchOptions = {
  query: string
  /** How many sessions to include in the ranked result. Default 20. */
  limit?: number
  /** How many prompts per session (matched ones prioritized). Default 8. */
  promptsPerSession?: number
  cwd?: string | null
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
  prompts: SessionIndexPrompt[]
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
// Search used to fold every transcript on disk per query (2,150 files, one
// of them 148 MB). Results are recency-ranked and capped at 20, so bounding
// the candidates to the most recently modified per provider is the same
// answer for any query a user types while working. The bound is per
// provider, applied AFTER the cwd filter for Claude (whose cwd is known
// from discovery), so a burst of Codex rollouts in other projects cannot
// crowd this project's Claude sessions out of the search. Sessions older
// than the bound are not searchable — the price of never freezing on a
// keystroke; raise the bound (and the cache) rather than remove it.
const SEARCH_CANDIDATES_PER_PROVIDER = 400

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
export function __resetSessionIndexCacheForTests(): void {
  promptCache.clear()
}
export function __sessionIndexCacheEntryForTests(
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
export function __sessionIndexCacheSizeForTests(): number {
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
// Discovery
// ---------------------------------------------------------------------------

/** Find every Claude session file on disk, grouped by cwd. Walks the
 *  ~/.claude/projects tree — each subdir is a sanitized cwd.
 *  Fallback for cases where the caller doesn't know/care about cwd
 *  scoping. For cwd-scoped calls we use listSessionsForCwd directly. */
async function discoverClaudeSessions(
  restrictCwd: string | null,
): Promise<Array<{ providerSessionId: string; cwd: string; lastModified: number; file: string; summary: string }>> {
  const results: Array<{
    providerSessionId: string
    cwd: string
    lastModified: number
    file: string
    summary: string
  }> = []

  if (restrictCwd) {
    // Fast path: ask the existing per-cwd lister. Returns pre-parsed
    // metadata including summary + cwd.
    try {
      const sessions = await listSessionsForCwd(restrictCwd, { limit: 200 })
      for (const s of sessions) {
        const dir = getProjectDirForCwd(s.cwd ?? restrictCwd)
        results.push({
          providerSessionId: s.sessionId,
          cwd: s.cwd ?? restrictCwd,
          lastModified: s.lastModified,
          file: `${dir}/${s.sessionId}.jsonl`,
          summary: s.summary,
        })
      }
      return results
    } catch {
      return []
    }
  }

  // No cwd restriction — walk all project dirs.
  // ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl. Each subdir is a
  // separate cwd. We walk them in parallel (modest — usually <20 cwds).
  //
  // getProjectDirForCwd returns the project dir for a specific cwd
  // (e.g. .../projects/-Users-x-y). We slice off the sanitized-cwd
  // suffix to enumerate siblings.
  const projectsRoot = (await getProjectDirForCwd('/')).replace(/\/+$/, '')
  const root = projectsRoot.slice(0, projectsRoot.lastIndexOf('/'))
  let subdirs: string[]
  try {
    subdirs = await readdir(root)
  } catch {
    return []
  }
  for (const sub of subdirs) {
    const dir = join(root, sub)
    try {
      const entries = await readdir(dir)
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue
        const sid = name.slice(0, -'.jsonl'.length)
        const file = join(dir, name)
        let st
        try {
          st = await stat(file)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        results.push({
          providerSessionId: sid,
          // We don't know the real cwd without reading the file. The
          // caller that needs cwd will fill it in during parse; leave
          // empty for now.
          cwd: '',
          lastModified: st.mtime.getTime(),
          file,
          summary: '',
        })
      }
    } catch {
      // subdir unreadable — skip
    }
  }
  return results
}

/** Find every Codex session file on disk. Codex stores all sessions
 *  globally (not per-cwd), so restrictCwd filters post-parse. */
async function discoverCodexSessions(): Promise<
  Array<{ providerSessionId: string; lastModified: number; file: string }>
> {
  const sessionsDir = getCodexSessionsDir()
  const out: Array<{ providerSessionId: string; lastModified: number; file: string }> = []
  const rolloutRe = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (st.isDirectory() && depth < 3) await walk(full, depth + 1)
        else if (st.isFile()) {
          const m = rolloutRe.exec(name)
          if (m) {
            out.push({
              providerSessionId: m[2],
              lastModified: st.mtime.getTime(),
              file: full,
            })
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
  try {
    await walk(sessionsDir, 0)
  } catch {
    // sessions dir doesn't exist yet
  }
  return out
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
): Promise<{ prompts: SessionIndexPrompt[]; cwd: string }> {
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
    .then(() => extractPromptsUnlocked(kind, sessionId, file, need))
  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

const inflight = new Map<string, Promise<{ prompts: SessionIndexPrompt[]; cwd: string }>>()

async function extractPromptsUnlocked(
  kind: AgentProviderKind,
  sessionId: string,
  file: string,
  need: number | 'all',
): Promise<{ prompts: SessionIndexPrompt[]; cwd: string }> {
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
    let window = TAIL_WINDOW_BYTES
    while (entry.parsedFrom > 0 && entry.prompts.length < wanted) {
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

function lastPromptText(prompts: readonly SessionIndexPrompt[]): string | null {
  return prompts.length > 0 ? prompts[prompts.length - 1]!.text : null
}

/** Fold complete JSONL lines into chronological prompts. `previousText` seeds
 *  the adjacent-duplicate rule across a chunk boundary (forward growth). */
function foldLines(
  kind: AgentProviderKind,
  jsonl: string,
  previousText: string | null,
): { prompts: SessionIndexPrompt[]; cwd: string } {
  const chronological: SessionIndexPrompt[] = []
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
function foldClaudeRecord(obj: Record<string, unknown>): SessionIndexPrompt | null {
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
  if (text.startsWith('<')) return null
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

function foldCodexRecord(obj: Record<string, unknown>): SessionIndexPrompt | null {
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
  if (text.startsWith('<')) return null
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

// ---------------------------------------------------------------------------
// Cwd fallback (Claude) — reverse the project-directory name
// ---------------------------------------------------------------------------

/** Claude sanitizes cwd into the project directory name by replacing
 *  every non-alphanumeric character with `-`. That transform is lossy
 *  (`/Users/x/my-app` and `/Users/x/my/app` both sanitize to
 *  `-Users-x-my-app`), so we can't perfectly reverse it. But for the
 *  common case where the cwd has no real dashes in its path segments,
 *  replacing `-` with `/` gets us back to a plausible absolute path.
 *  Used only as a fallback when the JSONL scan didn't find a cwd
 *  field — handy for sessions whose first few entries are oversized
 *  injected hooks that crowded the metadata out of the first N KB.
 *
 *  We additionally stat() the reversed path: if it doesn't exist,
 *  we return '' so the caller surfaces the "no cwd" error rather
 *  than resuming under a made-up directory that would confuse the
 *  model about which files are available. */
async function claudeCwdFromProjectDir(file: string): Promise<string> {
  // file looks like: .../.claude/projects/-Users-x-y/abc.jsonl
  const dirname = file.slice(0, file.lastIndexOf('/'))
  const projectDirName = dirname.slice(dirname.lastIndexOf('/') + 1)
  if (!projectDirName.startsWith('-')) return ''
  const reversed = projectDirName.replace(/-/g, '/')
  try {
    const st = await stat(reversed)
    if (st.isDirectory()) return reversed
  } catch {
    // Directory doesn't exist — lossy reverse guessed wrong, or the
    // original cwd was deleted. Either way, don't return a stale path.
  }
  return ''
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List the N most-recently-active sessions across both providers,
 *  each with their last M user prompts. Sorted by file mtime desc.
 *
 *  Implementation: discover all session files (cheap metadata walk),
 *  sort by mtime, take the top (limit × 2) — the overshoot is to
 *  tolerate sessions that have zero visible prompts after filtering,
 *  which would otherwise leave fewer than `limit` results. Parse
 *  prompts for that subset only. Truncate to `limit`. */
export async function listRecentSessionsWithPrompts(
  options: ListRecentOptions = {},
): Promise<SessionIndexEntry[]> {
  const span = performanceService.span('sessionIndex.listRecent', {
    limit: options.limit ?? 10,
    promptsPerSession: options.promptsPerSession ?? 4,
    cwdScoped: Boolean(options.cwd),
  })
  const limit = options.limit ?? 10
  const promptsPerSession = options.promptsPerSession ?? 4
  const cwd = options.cwd ?? null

  try {
    const claude = await discoverClaudeSessions(cwd)
    const codexFiles = await discoverCodexSessions()

  // Unify into one discovery list with provider tagged.
  const candidates: Array<{
    kind: AgentProviderKind
    providerSessionId: string
    file: string
    lastModified: number
    cwd: string
    summary: string
  }> = []
  for (const c of claude) {
    candidates.push({
      kind: 'claude',
      providerSessionId: c.providerSessionId,
      file: c.file,
      lastModified: c.lastModified,
      cwd: c.cwd,
      summary: c.summary,
    })
  }
  for (const c of codexFiles) {
    candidates.push({
      kind: 'codex',
      providerSessionId: c.providerSessionId,
      file: c.file,
      lastModified: c.lastModified,
      cwd: '',
      summary: '',
    })
  }
  candidates.sort((a, b) => b.lastModified - a.lastModified)

  const results: SessionIndexEntry[] = []
  for (const c of candidates) {
    if (results.length >= limit) break
    // Listing needs the newest few prompts only; the tail read stops there.
    const { prompts, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
      promptsPerSession,
    )
    // Cwd precedence:
    //   1. Whatever the discoverer already knew (e.g. listSessionsForCwd
    //      populated it when cwd scope was restricted).
    //   2. The cwd parsed from the full JSONL (picks up sessions whose
    //      first few entries are pushed past any fixed head window by
    //      oversized hook_success injections).
    //   3. For Claude only: reverse the project-directory name as a
    //      best-effort fallback — correct when the cwd has no real
    //      dashes in its path segments.
    //   4. Empty string — UI surfaces a "no cwd recorded" error
    //      rather than resuming under a guess.
    let resolvedCwd = c.cwd || parsedCwd
    if (!resolvedCwd && c.kind === 'claude') {
      resolvedCwd = await claudeCwdFromProjectDir(c.file)
    }
    // Apply cwd filter now if requested.
    if (cwd && resolvedCwd && resolvedCwd !== cwd) continue
    results.push({
      providerSessionId: c.providerSessionId,
      kind: c.kind,
      cwd: resolvedCwd,
      lastModified: c.lastModified,
      summary: c.summary || (prompts[0]?.text ?? '').slice(0, 200),
      recentUserPrompts: prompts.slice(0, promptsPerSession),
      matchCount: 0,
    })
  }
    span.end({
      claudeCandidates: claude.length,
      codexCandidates: codexFiles.length,
      results: results.length,
    })
    return results
  } catch (err) {
    span.fail(err)
    throw err
  }
}

/** Search every session's prompts for the query. Matching sessions
 *  rank by match-quality × recency. Returns up to `limit` sessions,
 *  each with up to `promptsPerSession` prompts prioritizing matched
 *  ones. */
export async function searchSessionPrompts(
  options: SearchOptions,
): Promise<SessionIndexEntry[]> {
  const q = options.query.trim()
  if (!q) return listRecentSessionsWithPrompts(options)

  const span = performanceService.span('sessionIndex.search', {
    limit: options.limit ?? 20,
    promptsPerSession: options.promptsPerSession ?? 8,
    cwdScoped: Boolean(options.cwd),
    queryLength: q.length,
  })
  const limit = options.limit ?? 20
  const promptsPerSession = options.promptsPerSession ?? 8
  const cwd = options.cwd ?? null

  try {
    const claude = await discoverClaudeSessions(cwd)
    const codex = await discoverCodexSessions()
  const candidates: Array<{
    kind: AgentProviderKind
    providerSessionId: string
    file: string
    lastModified: number
    cwd: string
    summary: string
  }> = []
  for (const c of claude) {
    candidates.push({ ...c, kind: 'claude' })
  }
  for (const c of codex) {
    candidates.push({
      kind: 'codex',
      providerSessionId: c.providerSessionId,
      file: c.file,
      lastModified: c.lastModified,
      cwd: '',
      summary: '',
    })
  }

  const qLower = q.toLowerCase()

  // Score every candidate. Parse prompts as we go (cached).
  const scored: Array<{
    entry: SessionIndexEntry
    score: number
  }> = []

  // Newest first, bounded per provider AFTER the cwd filter where the cwd is
  // already known — see SEARCH_CANDIDATES_PER_PROVIDER. Codex cwd is only
  // known after a head read, so its candidates are filtered below as before.
  candidates.sort((a, b) => b.lastModified - a.lastModified)
  const bounded: typeof candidates = []
  const taken: Partial<Record<AgentProviderKind, number>> = {}
  for (const c of candidates) {
    if (cwd && c.cwd && c.cwd !== cwd) continue
    const count = taken[c.kind] ?? 0
    if (count >= SEARCH_CANDIDATES_PER_PROVIDER) continue
    taken[c.kind] = count + 1
    bounded.push(c)
  }
  for (const c of bounded) {
    const { prompts, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
      'all',
    )
    // Score = best match among prompts × recency boost.
    let bestMatch = 0
    let matchCount = 0
    const matchedPrompts: SessionIndexPrompt[] = []
    const nonMatchedPrompts: SessionIndexPrompt[] = []
    for (const p of prompts) {
      const lower = p.text.toLowerCase()
      let match = 0
      if (lower.includes(qLower)) {
        // Word-boundary prefix bumps higher than mid-word substring.
        const wordBoundaryIdx = lower.search(
          new RegExp(`\\b${escapeRegex(qLower)}`),
        )
        match = wordBoundaryIdx >= 0 ? 1.0 : 0.6
      }
      if (match > 0) {
        matchCount++
        if (match > bestMatch) bestMatch = match
        matchedPrompts.push(p)
      } else {
        nonMatchedPrompts.push(p)
      }
    }
    if (bestMatch === 0) continue

    // Recency boost: 1 / (1 + days_since). Recent sessions win ties.
    const daysSince = Math.max(
      0,
      (Date.now() - c.lastModified) / (1000 * 60 * 60 * 24),
    )
    const recency = 1 / (1 + daysSince)
    const score = bestMatch * (1 + recency)

    let resolvedCwd = c.cwd || parsedCwd
    if (!resolvedCwd && c.kind === 'claude') {
      resolvedCwd = await claudeCwdFromProjectDir(c.file)
    }
    if (cwd && resolvedCwd && resolvedCwd !== cwd) continue

    // Show matched prompts first, then fill from non-matched for
    // context. Newest-first within each group (prompts array is
    // already newest-first).
    const combined = [...matchedPrompts, ...nonMatchedPrompts].slice(
      0,
      promptsPerSession,
    )

    scored.push({
      entry: {
        providerSessionId: c.providerSessionId,
        kind: c.kind,
        cwd: resolvedCwd,
        lastModified: c.lastModified,
        summary: c.summary || (prompts[0]?.text ?? '').slice(0, 200),
        recentUserPrompts: combined,
        matchCount,
      },
      score,
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.entry.lastModified - a.entry.lastModified
  })

    const results = scored.slice(0, limit).map(s => s.entry)
    span.end({
      claudeCandidates: claude.length,
      codexCandidates: codex.length,
      scored: scored.length,
      results: results.length,
    })
    return results
  } catch (err) {
    span.fail(err)
    throw err
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
