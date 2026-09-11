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
// Prompt extraction moved to src/main/conversations/prompts/promptFolder.ts
// (the conversation picker rebuild, #874). This module keeps discovery and
// search until Task 23 deletes it; the re-exports keep its tests and callers
// compiling unchanged in the meantime.
// ---------------------------------------------------------------------------

import {
  extractPromptsFromFile,
  type FoldedPrompt,
} from '@main/conversations/prompts/promptFolder.js'

export type SessionIndexPrompt = FoldedPrompt
export {
  __resetPromptFolderCacheForTests as __resetSessionIndexCacheForTests,
  __promptFolderCacheEntryForTests as __sessionIndexCacheEntryForTests,
  __promptFolderCacheSizeForTests as __sessionIndexCacheSizeForTests,
  extractPromptsFromFile,
} from '@main/conversations/prompts/promptFolder.js'

// Search used to fold every transcript on disk per query (2,150 files, one
// of them 148 MB). Results are recency-ranked and capped at 20, so bounding
// the candidates to the most recently modified per provider is the same
// answer for any query a user types while working. The bound is per
// provider, applied AFTER the cwd filter for Claude (whose cwd is known
// from discovery), so a burst of Codex rollouts in other projects cannot
// crowd this project's Claude sessions out of the search. Sessions older
// than the bound are not searchable — the price of never freezing on a
// keystroke; raise the bound (and the cache) rather than remove it.
export const SEARCH_CANDIDATES_PER_PROVIDER = 400

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
    const { prompts: folded, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
      promptsPerSession,
    )
    // The folder now reports wrapper-prefixed prompts; this legacy modal keeps
    // hiding them until it is deleted (#874).
    const prompts = folded.filter(p => !p.text.startsWith('<'))
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
    const { prompts: folded, cwd: parsedCwd } = await extractPromptsFromFile(
      c.kind,
      c.providerSessionId,
      c.file,
      'all',
    )
    const prompts = folded.filter(p => !p.text.startsWith('<'))
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
