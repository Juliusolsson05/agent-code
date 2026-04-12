import { readdir, stat, open } from 'fs/promises'
import { basename, join } from 'path'

import { getProjectDirForCwd } from '../../shared/runtime/projectDir.js'

// Session lister — reimplements the minimal subset of CC's
// utils/listSessionsImpl.ts needed to power the cc-shell resume UI.
//
// We deliberately don't import from claude-code-src. CC's lister pulls
// in a big transitive dependency graph (bootstrap state, analytics,
// session-title AI inference, cross-worktree resolution, …) that we
// don't need and can't safely instantiate outside CC's own runtime.
// Since the JSONL file format is stable and the metadata we need lives
// in the first and last few lines of each file, a ~200-line standalone
// reader is the right trade-off.
//
// What this module does:
//   1. Walk the project directory for `<sessionId>.jsonl` files.
//   2. stat each for mtime + size.
//   3. For each, read a small HEAD chunk (first entries — user prompts,
//      timestamps, cwd, gitBranch) and TAIL chunk (last entries —
//      lastPrompt, customTitle) without parsing the whole file. JSONL
//      sessions can be megabytes, so full parse is wasteful when we
//      only want ~6 fields.
//   4. Extract fields via regex scans over the head/tail strings
//      (no JSON.parse — we don't need full object fidelity and the
//      scans stay fast on big tails).
//   5. Return structured SessionInfo[] sorted by mtime desc.
//
// Everything here is pure Node I/O — no Electron, no React, no xterm.
// Lives under src/core/runtime/ so main can import it directly. The
// testbench can too, for future session-list regression tests.

/** Public-facing session metadata. Matches CC's SessionInfo shape
 *  closely so if we later import CC's lister it's a drop-in swap. */
export type SessionInfo = {
  sessionId: string
  /** Best-effort "what this session was about" — custom title if set,
   *  else last user prompt, else first user prompt. */
  summary: string
  /** File mtime in epoch ms. Primary sort key. */
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  /** Cwd recorded in the session's first entry — useful for cross-cwd
   *  resume where the current cwd doesn't match the session's. */
  cwd?: string
  /** Epoch ms from the first entry's ISO timestamp if parseable. */
  createdAt?: number
}

export type ListSessionsOptions = {
  /** Max sessions to return. Default 20. */
  limit?: number
}

// ---------------------------------------------------------------------------
// File reading — head + tail without loading the whole file
// ---------------------------------------------------------------------------

// 16 KB covers the first ~20–30 JSONL entries for typical sessions,
// which is enough to see the first user prompt + session metadata.
const HEAD_BYTES = 16 * 1024
// 32 KB covers the tail custom-title / lastPrompt / tag entries even
// after a long tool interaction.
const TAIL_BYTES = 32 * 1024

type LiteRead = {
  head: string
  tail: string
  mtime: number
  size: number
}

/**
 * Read head + tail of a JSONL file without loading the middle. Uses
 * a single open() handle and two positioned reads — cheap even for
 * large sessions. Returns null if the file is empty or unreadable.
 *
 * For files smaller than HEAD_BYTES + TAIL_BYTES, `head` and `tail`
 * overlap (both contain the whole file). The extractors don't care —
 * we search both, and duplicate matches are idempotent.
 */
async function readSessionLite(filePath: string): Promise<LiteRead | null> {
  let fd
  try {
    fd = await open(filePath, 'r')
    const s = await fd.stat()
    if (s.size === 0) return null

    const headLen = Math.min(HEAD_BYTES, s.size)
    const headBuf = Buffer.alloc(headLen)
    await fd.read(headBuf, 0, headLen, 0)

    let tailBuf: Buffer
    if (s.size <= HEAD_BYTES) {
      // Small file — head already covers everything.
      tailBuf = headBuf
    } else {
      const tailLen = Math.min(TAIL_BYTES, s.size)
      const tailStart = Math.max(0, s.size - tailLen)
      tailBuf = Buffer.alloc(tailLen)
      await fd.read(tailBuf, 0, tailLen, tailStart)
    }

    return {
      head: headBuf.toString('utf8'),
      tail: tailBuf.toString('utf8'),
      mtime: s.mtime.getTime(),
      size: s.size,
    }
  } catch {
    return null
  } finally {
    await fd?.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Field extraction — regex scans over head/tail text
// ---------------------------------------------------------------------------

/**
 * Extract a JSON string field value by name from any line in `text`.
 * Matches `"<field>":"<value>"` with minimal escape handling — good
 * enough for the fields we care about (titles, prompts, paths) which
 * rarely contain backslashes. Returns the FIRST match.
 */
function extractJsonStringField(text: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const match = text.match(re)
  if (!match) return undefined
  // Unescape a handful of common escape sequences. Anything exotic
  // falls through — we're showing a summary in a list, not preserving
  // bytes for execution.
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
}

/** Same as extractJsonStringField but returns the LAST match — used
 *  for fields like `lastPrompt` / `customTitle` that get re-appended
 *  near the end of the file on every session save. */
function extractLastJsonStringField(text: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g')
  let last: string | undefined
  for (const m of text.matchAll(re)) last = m[1]
  if (last === undefined) return undefined
  return last
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
}

/**
 * Pull the first user prompt out of a session head. Looks for a
 * TranscriptMessage with type=user and message.content that's either
 * a string or a TextBlock. Falls back to undefined if nothing found.
 *
 * The head-scan approach is shared with CC's own extractFirstPromptFromHead
 * (utils/sessionStoragePortable.ts) — we just do it in a way that
 * doesn't require CC's full parser.
 */
function extractFirstUserPrompt(head: string): string | undefined {
  // Walk lines looking for a "type":"user" line that also contains a
  // "text" field. Skip sidechain sessions (they're tool-chain internals).
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue
    if (!line.includes('"type":"user"')) continue
    if (line.includes('"isSidechain":true')) continue
    // Prefer `text` (content-block shape) over content (string shape).
    const text =
      extractJsonStringField(line, 'text') ??
      extractJsonStringField(line, 'content')
    if (text && !text.startsWith('<')) {
      // Cap at 200 chars for display — long prompts get truncated.
      return text.length > 200 ? text.slice(0, 200).trimEnd() + '…' : text
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Top-level API
// ---------------------------------------------------------------------------

/** Filename sanity check — only UUID-shaped files are real sessions. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * List sessions for a given cwd, newest first. Limit defaults to 20.
 *
 * Returns an empty array when the project directory doesn't exist yet
 * (e.g. the user has never opened CC in this cwd). Skips files with
 * empty / unparseable metadata — matches CC's "no summary = not
 * listable" rule.
 */
export async function listSessionsForCwd(
  cwd: string,
  options: ListSessionsOptions = {},
): Promise<SessionInfo[]> {
  const limit = options.limit ?? 20
  const projectDir = await getProjectDirForCwd(cwd)

  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    return []
  }

  type Candidate = { sessionId: string; filePath: string; mtime: number }
  const candidates: Candidate[] = []

  // stat pass — cheap, lets us sort by mtime BEFORE doing the expensive
  // head/tail reads.
  await Promise.all(
    names.map(async name => {
      if (!name.endsWith('.jsonl')) return
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!UUID_RE.test(sessionId)) return
      const filePath = join(projectDir, name)
      try {
        const s = await stat(filePath)
        candidates.push({
          sessionId,
          filePath,
          mtime: s.mtime.getTime(),
        })
      } catch {
        // File vanished between readdir and stat — ignore.
      }
    }),
  )

  // Sort newest first so we can early-exit once we've filled `limit`.
  candidates.sort((a, b) => b.mtime - a.mtime)

  const sessions: SessionInfo[] = []
  for (const c of candidates) {
    if (sessions.length >= limit) break
    const info = await parseSession(c)
    if (info) sessions.push(info)
  }
  return sessions
}

async function parseSession({
  sessionId,
  filePath,
  mtime,
}: {
  sessionId: string
  filePath: string
  mtime: number
}): Promise<SessionInfo | null> {
  const lite = await readSessionLite(filePath)
  if (!lite) return null

  // Sidechain (agent-side-chain) sessions are internal tool runs —
  // skip them from the user-facing list.
  const firstLine = lite.head.split('\n', 1)[0] ?? ''
  if (
    firstLine.includes('"isSidechain":true') ||
    firstLine.includes('"isSidechain": true')
  ) {
    return null
  }

  const customTitle =
    extractLastJsonStringField(lite.tail, 'customTitle') ??
    extractLastJsonStringField(lite.tail, 'aiTitle') ??
    extractLastJsonStringField(lite.head, 'customTitle')

  const lastPrompt = extractLastJsonStringField(lite.tail, 'lastPrompt')
  const firstPrompt = extractFirstUserPrompt(lite.head)

  const summary = customTitle ?? lastPrompt ?? firstPrompt
  if (!summary) return null

  const gitBranch =
    extractJsonStringField(lite.head, 'gitBranch') ??
    extractLastJsonStringField(lite.tail, 'gitBranch')

  const cwd = extractJsonStringField(lite.head, 'cwd')

  const firstTimestamp = extractJsonStringField(lite.head, 'timestamp')
  let createdAt: number | undefined
  if (firstTimestamp) {
    const parsed = Date.parse(firstTimestamp)
    if (!Number.isNaN(parsed)) createdAt = parsed
  }

  return {
    sessionId,
    summary,
    lastModified: mtime,
    fileSize: lite.size,
    customTitle,
    firstPrompt,
    gitBranch,
    cwd,
    createdAt,
  }
}
