import { readdir, readFile, stat } from 'fs/promises'
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
  /** Cwd captured during the same JSONL pass that extracted prompts.
   *  Cheap — we're reading every line anyway — and avoids a second
   *  file read. Falls back to '' when no entry in the file carried
   *  a cwd field; the caller then tries a directory-name reverse. */
  cwd: string
}

/** Keyed by provider session id. Codex session ids are globally
 *  unique (uuid); Claude session ids are uuids too. No collisions
 *  across providers in practice, but we prefix to be safe. */
const promptCache = new Map<string, CacheEntry>()

function cacheKey(kind: 'claude' | 'codex', id: string): string {
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
): Promise<{ prompts: SessionIndexPrompt[]; cwd: string }> {
  const span = performanceService.span('sessionIndex.extractPrompts', {
    kind,
    sessionId,
    file,
  })
  const cached = promptCache.get(cacheKey(kind, sessionId))
  let mtime: number
  try {
    const st = await stat(file)
    mtime = st.mtime.getTime()
  } catch {
    span.end({ result: 'stat-failed' })
    return { prompts: [], cwd: '' }
  }
  if (cached && cached.mtime === mtime) {
    span.end({ result: 'cache-hit', prompts: cached.prompts.length })
    return { prompts: cached.prompts, cwd: cached.cwd }
  }

  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    span.end({ result: 'read-failed' })
    return { prompts: [], cwd: '' }
  }

  const parsed =
    kind === 'claude'
      ? extractClaudePromptsAndCwd(text)
      : extractCodexPromptsAndCwd(text)

  promptCache.set(cacheKey(kind, sessionId), {
    mtime,
    prompts: parsed.prompts,
    cwd: parsed.cwd,
  })
  span.end({
    result: 'parsed',
    bytes: text.length,
    prompts: parsed.prompts.length,
    hasCwd: parsed.cwd.length > 0,
  })
  return parsed
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
function extractClaudePromptsAndCwd(
  jsonl: string,
): { prompts: SessionIndexPrompt[]; cwd: string } {
  const chronological: SessionIndexPrompt[] = []
  let cwd = ''
  const lines = jsonl.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    const obj = parseJsonRecord(line)
    if (!obj) continue

    // Capture cwd from the first entry that carries one. Claude
    // stamps cwd on conversation entries (user / assistant) but NOT
    // on permission-mode or hook_success attachment entries — and
    // the first few real entries can be pushed past the top of the
    // file by huge hook_success injections (multi-KB of skill
    // bootstrap content). Scanning the full file is the only
    // reliable way to find cwd for those sessions.
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
      cwd = obj.cwd
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

    const message = asRecord(obj.message)
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
  return { prompts: chronological.reverse(), cwd }
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

/** Parse Codex rollout JSONL and extract user prompts. User messages
 *  in Codex are response_item entries with role='user' containing
 *  input_text / input_image content items. Also catches user_message
 *  event_msg entries as a belt-and-braces fallback for older rollouts.
 *
 *  Returns newest-first. */
function extractCodexPromptsAndCwd(
  jsonl: string,
): { prompts: SessionIndexPrompt[]; cwd: string } {
  const chronological: SessionIndexPrompt[] = []
  let cwd = ''
  const lines = jsonl.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    const obj = parseJsonRecord(line)
    if (!obj) continue

    // Codex puts cwd on the session_meta entry (first rollout line)
    // at `payload.cwd`. Older schemas sometimes stored it at the
    // top level. Grab whichever shape we find first and stop looking.
    if (!cwd) {
      const topCwd = obj.cwd
      if (typeof topCwd === 'string' && topCwd.length > 0) cwd = topCwd
      else {
        const metaPayload = asRecord(obj.payload)
        const payloadCwd = metaPayload?.cwd
        if (typeof payloadCwd === 'string' && payloadCwd.length > 0) cwd = payloadCwd
      }
    }

    let text = ''
    let ts: number | null = null
    // Prefer response_item messages — those are the canonical user
    // turns. event_msg user_message is a fallback for older formats.
    const type = typeof obj.type === 'string' ? obj.type : ''
    const payload = asRecord(obj.payload)

    if (type === 'response_item') {
      const item = payload ?? obj
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
  return { prompts: chronological.reverse(), cwd }
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
    const { prompts, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
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
    const { prompts, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
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
