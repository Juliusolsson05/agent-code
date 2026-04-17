import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'

import { listSessionsForCwd } from '../providers/claude/runtime/sessionList.js'
import { getProjectDirForCwd } from '../shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '../providers/codex/runtime/projectDir.js'

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
//   - Linear scan over JSONL files is fine at cc-shell scale; we cap
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
  kind: 'claude' | 'codex'
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
  prompts: SessionIndexPrompt[]
}

/** Keyed by provider session id. Codex session ids are globally
 *  unique (uuid); Claude session ids are uuids too. No collisions
 *  across providers in practice, but we prefix to be safe. */
const promptCache = new Map<string, CacheEntry>()

function cacheKey(kind: 'claude' | 'codex', id: string): string {
  return `${kind}:${id}`
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

/** Read the whole transcript and extract user prompts in chronological
 *  order. Returned newest-first. Caches by mtime so repeated calls
 *  for an unchanged file skip disk + parse.
 *
 *  We do a full file read instead of a reverse tail — JSONL transcripts
 *  are small (usually <1 MB) and the filters we apply need context
 *  from multiple lines (adjacent-dupe suppression, compact boundary
 *  detection). A proper reverse reader is future work if the full read
 *  starts to hurt. */
async function extractPromptsFromFile(
  kind: 'claude' | 'codex',
  sessionId: string,
  file: string,
): Promise<SessionIndexPrompt[]> {
  const cached = promptCache.get(cacheKey(kind, sessionId))
  let mtime: number
  try {
    const st = await stat(file)
    mtime = st.mtime.getTime()
  } catch {
    return []
  }
  if (cached && cached.mtime === mtime) return cached.prompts

  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    return []
  }

  const prompts =
    kind === 'claude'
      ? extractClaudePrompts(text)
      : extractCodexPrompts(text)

  promptCache.set(cacheKey(kind, sessionId), { mtime, prompts })
  return prompts
}

/** Parse Claude JSONL and extract user prompts. Mirrors the filtering
 *  in renderer/.../latestUserPrompts.ts:
 *   - only role=user conversation entries
 *   - skip compact-summary entries
 *   - skip isMeta entries
 *   - skip text starting with '<' (CC injects <command-message>,
 *     <command-name>, <local-command-stdout> wrappers for its own
 *     system prompts)
 *   - dedupe adjacent duplicates (CC occasionally double-records)
 *
 *  Returns newest-first. */
function extractClaudePrompts(jsonl: string): SessionIndexPrompt[] {
  const chronological: SessionIndexPrompt[] = []
  const lines = jsonl.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof obj.type === 'string' ? obj.type : ''
    if (type !== 'user') continue

    // Skip compact summary markers and meta entries.
    if (obj.isCompactSummary === true) continue
    if (obj.isMeta === true) continue
    // Require permissionMode — Claude tags real user prompts with it;
    // synthetic injections don't carry it. Same guard as the existing
    // latestUserPrompts helper.
    if (obj.permissionMode === undefined) continue

    const message = obj.message as Record<string, unknown> | undefined
    if (!message) continue
    if (message.role !== 'user') continue

    const text = extractClaudeUserText(message.content)
    if (!text) continue
    if (text.startsWith('<')) continue
    if (
      chronological.length > 0 &&
      chronological[chronological.length - 1]?.text === text
    ) {
      continue
    }
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    chronological.push({
      text,
      ts: Number.isFinite(ts) ? ts : null,
    })
  }
  return chronological.reverse()
}

function extractClaudeUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      return (b.text as string).trim()
    }
  }
  return ''
}

/** Parse Codex rollout JSONL and extract user prompts. User messages
 *  in Codex are response_item entries with role='user' containing
 *  input_text / input_image content items. Also catches user_message
 *  event_msg entries as a belt-and-braces fallback for older rollouts.
 *
 *  Returns newest-first. */
function extractCodexPrompts(jsonl: string): SessionIndexPrompt[] {
  const chronological: SessionIndexPrompt[] = []
  const lines = jsonl.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    let text = ''
    let ts: number | null = null
    // Prefer response_item messages — those are the canonical user
    // turns. event_msg user_message is a fallback for older formats.
    const type = typeof obj.type === 'string' ? obj.type : ''
    const payload = obj.payload as Record<string, unknown> | undefined

    if (type === 'response_item') {
      const item = payload ?? (obj as Record<string, unknown>)
      const itemType = typeof item.type === 'string' ? item.type : ''
      const role = typeof item.role === 'string' ? item.role : ''
      if (itemType !== 'message' || role !== 'user') continue
      text = flattenCodexContent(item.content)
    } else if (type === 'event_msg') {
      const msgType = typeof payload?.type === 'string' ? payload.type : ''
      if (msgType !== 'user_message') continue
      const maybeText = payload?.message
      if (typeof maybeText === 'string') text = maybeText.trim()
    } else if (type === 'message' && (obj.role === 'user')) {
      // Older shape: bare message item at top level.
      text = flattenCodexContent(obj.content)
    } else {
      continue
    }

    text = text.trim()
    if (!text) continue
    // Codex doesn't inject '<foo>'-wrapped synthetic prompts the way
    // Claude does, but harmless to apply the same guard for symmetry.
    if (text.startsWith('<')) continue
    if (
      chronological.length > 0 &&
      chronological[chronological.length - 1]?.text === text
    ) {
      continue
    }

    const tsField = obj.timestamp ?? payload?.timestamp
    if (typeof tsField === 'string') {
      const parsed = Date.parse(tsField)
      if (Number.isFinite(parsed)) ts = parsed
    }

    chronological.push({ text, ts })
  }
  return chronological.reverse()
}

function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const t = obj.type as string | undefined
    if ((t === 'input_text' || t === 'text') && typeof obj.text === 'string') {
      parts.push(obj.text as string)
    } else if (t === 'input_image') {
      parts.push('[image]')
    }
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Cwd resolution (Claude)
// ---------------------------------------------------------------------------

/** Claude's listSessionsForCwd populates `cwd` for us. For the
 *  all-sessions discovery path we need to read a small HEAD of the
 *  file to pull the cwd out of the first entry. Keep the read minimal
 *  (4 KB is plenty for the first metadata line). */
async function resolveClaudeCwd(file: string): Promise<string> {
  try {
    const head = await readFile(file, { encoding: 'utf-8', flag: 'r' }).then(
      s => s.slice(0, 4096),
    )
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) {
      return m[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
  } catch {
    // fall through
  }
  return ''
}

/** Codex session_meta lives on the first rollout line. We read a
 *  small HEAD and regex-extract cwd — same technique as sessionList. */
async function resolveCodexCwd(file: string): Promise<string> {
  try {
    const text = await readFile(file, 'utf-8')
    const firstLine = text.slice(0, text.indexOf('\n', 0) + 1 || 4096)
    const m = firstLine.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  } catch {
    // fall through
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
  const limit = options.limit ?? 10
  const promptsPerSession = options.promptsPerSession ?? 4
  const cwd = options.cwd ?? null

  const claude = await discoverClaudeSessions(cwd)
  const codexFiles = await discoverCodexSessions()

  // Unify into one discovery list with provider tagged.
  const candidates: Array<{
    kind: 'claude' | 'codex'
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
    const prompts = await extractPromptsFromFile(c.kind, c.providerSessionId, c.file)
    // Sessions with no user prompts are still useful in the list —
    // they show the provider + time even without recognisable text.
    // Keep them but put them behind sessions that have at least one
    // prompt. Cheap post-filter: prioritize non-empty first, filler
    // second.
    const resolvedCwd = c.cwd || (c.kind === 'claude'
      ? await resolveClaudeCwd(c.file)
      : await resolveCodexCwd(c.file))
    // Apply cwd filter now if requested and we couldn't earlier.
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
  return results
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

  const limit = options.limit ?? 20
  const promptsPerSession = options.promptsPerSession ?? 8
  const cwd = options.cwd ?? null

  const claude = await discoverClaudeSessions(cwd)
  const codex = await discoverCodexSessions()
  const candidates: Array<{
    kind: 'claude' | 'codex'
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

  for (const c of candidates) {
    const prompts = await extractPromptsFromFile(c.kind, c.providerSessionId, c.file)
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

    const resolvedCwd = c.cwd || (c.kind === 'claude'
      ? await resolveClaudeCwd(c.file)
      : await resolveCodexCwd(c.file))
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

  return scored.slice(0, limit).map(s => s.entry)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
