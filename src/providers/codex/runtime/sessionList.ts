import { readdir, stat, open } from 'fs/promises'
import { join } from 'path'

import { getCodexSessionsDir } from '@providers/codex/runtime/projectDir.js'
import { performanceService } from '@main/performance/PerformanceService.js'

// Codex session lister — walks ~/.codex/sessions/YYYY/MM/DD/ for
// rollout-*.jsonl files and extracts summary metadata for the resume
// picker. Parallel to sessionList.ts (Claude's lister) but reads a
// different directory structure and different JSONL field names.
//
// Codex rollout files are named:
//   rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
//
// The first line of each file is a session_meta entry with the UUID,
// cwd, timestamp, and git info. User messages appear as response_item
// entries with role="user".

export type CodexSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  cwd?: string
  gitBranch?: string
  createdAt?: number
}

export type ListCodexSessionsOptions = {
  limit?: number
}

// 16 KB for head, 32 KB for tail — same budget as Claude's lister.
const HEAD_BYTES = 16 * 1024
const TAIL_BYTES = 32 * 1024

// Rollout filename pattern: rollout-<timestamp>-<uuid>.jsonl
const ROLLOUT_RE = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * List codex sessions, newest first. Walks the date-bucketed
 * sessions directory recursively, reads HEAD + TAIL of each
 * rollout file, and extracts metadata.
 *
 * Unlike Claude's lister which is scoped to a single cwd, this
 * returns ALL sessions (codex doesn't partition by cwd). The
 * caller can filter by cwd if needed.
 */
export async function listCodexSessions(
  options: ListCodexSessionsOptions = {},
): Promise<CodexSessionInfo[]> {
  const span = performanceService.span('providers.codex.listSessions', {
    limit: options.limit ?? 20,
  })
  const limit = options.limit ?? 20
  const sessionsDir = getCodexSessionsDir()

  // Collect all rollout files recursively from the date tree.
  const files: Array<{ path: string; mtime: number; sessionId: string }> = []
  try {
    await walkForRollouts(sessionsDir, files)
  } catch {
    // Sessions dir doesn't exist yet — no codex sessions recorded.
    span.end({ result: 'missing-sessions-dir' })
    return []
  }

  // Sort newest first so we can early-exit once we've filled `limit`.
  files.sort((a, b) => b.mtime - a.mtime)

  const sessions: CodexSessionInfo[] = []
  for (const f of files) {
    if (sessions.length >= limit) break
    const info = await parseCodexSession(f)
    if (info) sessions.push(info)
  }
  span.end({
    result: 'listed',
    candidates: files.length,
    sessions: sessions.length,
  })
  return sessions
}

/**
 * Recursively walk the date tree and collect rollout files.
 * Codex stores sessions as:
 *   sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * We walk up to 3 levels of date directories + the leaf files.
 */
async function walkForRollouts(
  dir: string,
  out: Array<{ path: string; mtime: number; sessionId: string }>,
  depth = 0,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.isDirectory() && depth < 3) {
        await walkForRollouts(full, out, depth + 1)
      } else if (s.isFile()) {
        const match = ROLLOUT_RE.exec(name)
        if (match) {
          out.push({
            path: full,
            mtime: s.mtime.getTime(),
            sessionId: match[2],
          })
        }
      }
    } catch {
      // Skip unreadable entries.
    }
  }
}

/**
 * Extract metadata from a single rollout file's HEAD + TAIL.
 */
async function parseCodexSession(
  file: { path: string; mtime: number; sessionId: string },
): Promise<CodexSessionInfo | null> {
  let fd
  try {
    fd = await open(file.path, 'r')
    const s = await fd.stat()
    if (s.size === 0) return null

    const headLen = Math.min(HEAD_BYTES, s.size)
    const headBuf = Buffer.alloc(headLen)
    await fd.read(headBuf, 0, headLen, 0)
    const head = headBuf.toString('utf8')

    // Extract fields from the session_meta line (first line).
    const cwd = extractField(head, 'cwd')
    const branch = extractField(head, 'branch')
    const timestamp = extractField(head, 'timestamp')
    let createdAt: number | undefined
    if (timestamp) {
      const parsed = Date.parse(timestamp)
      if (!Number.isNaN(parsed)) createdAt = parsed
    }

    // For the summary: find the first user message text.
    // Codex user messages are response_item entries with
    // role="user" and content containing input_text blocks.
    let summary = extractField(head, 'text')
    if (summary && summary.length > 200) {
      summary = summary.slice(0, 200).trimEnd() + '…'
    }
    if (!summary) summary = file.sessionId.slice(0, 8)

    return {
      sessionId: file.sessionId,
      summary,
      lastModified: file.mtime,
      fileSize: s.size,
      cwd: cwd ?? undefined,
      gitBranch: branch ?? undefined,
      createdAt,
    }
  } catch {
    return null
  } finally {
    await fd?.close().catch(() => {})
  }
}

/**
 * Extract a JSON string field value by name from any line in `text`.
 * Same approach as Claude's sessionList.ts — fast regex scan, no
 * full JSON parse.
 */
function extractField(text: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const match = text.match(re)
  if (!match) return null
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
}
