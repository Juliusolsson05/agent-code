import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SessionIndexEntry, SessionIndexPrompt } from '@preload/index'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { relativeTime } from '@renderer/lib/relativeTime'
import { cwdBasename, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'

// PromptSearchModal — cross-session prompt search.
//
// WHY this exists:
//   Session names are useless for recognizing conversations. This modal
//   lists the 10 most-recently-active sessions by default, each with
//   their last 4 user prompts attached, so the user can find a session
//   visually by prompt text. Typing into the search box switches to
//   substring-match mode across every session on disk, with matching
//   prompts ranked by quality × recency.
//
// Data flow: window.api.listRecentSessionsWithPrompts on mount → list.
// window.api.searchSessionPrompts on query change (debounced) →
// filtered list. Both handled in src/main/sessionIndex.ts with
// mtime-based caching so repeat calls don't re-parse unchanged files.
//
// Resume semantics:
//   Selecting a session RESUMES it in the currently focused pane
//   (`workspace.replaceSession`). The pane's tile position stays
//   put; only its backing session swaps. This matches how the
//   built-in resume picker works.
//
//   WHY the session's own cwd (not the active pane's cwd): our
//   modal shows sessions from every cwd on disk, so the selected
//   session might be from a different project than the one you're
//   currently in. Resuming under the wrong cwd means the model
//   can't see the files it was working on. The built-in resume
//   picker only lists per-cwd sessions so this doesn't matter
//   there; for us it does.
//
//   Fallback: if there's no active tab/pane (rare — app just
//   launched, no sessions), open a new tab in the session's cwd
//   so the user still gets what they clicked on.

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

// Debounce for search-input → IPC. Small enough that it feels instant
// on a fast machine; large enough to avoid re-querying mid-word.
const SEARCH_DEBOUNCE_MS = 150

// Truncation limits — prevent a pasted wall-of-text prompt from
// blowing out the card. Users can always click into the session to
// see the full prompt.
const PROMPT_PREVIEW_MAX_CHARS = 180

function truncatePreview(text: string): string {
  const firstLine = text.split('\n').find(l => l.trim()) ?? text
  if (firstLine.length <= PROMPT_PREVIEW_MAX_CHARS) return firstLine
  return firstLine.slice(0, PROMPT_PREVIEW_MAX_CHARS) + '…'
}

export function PromptSearchModal({ open, workspace, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<SessionIndexEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [resuming, setResuming] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Scope results to the visibly commanded pane's cwd. Searching
  // across every workspace on disk surfaces sessions from unrelated
  // projects that the user can't meaningfully use from the current
  // tab (resuming a session recorded in /foo while the pane is
  // rooted in /bar leaves the model looking at the wrong
  // filesystem). Dispatch Mode has its own focused row, so using
  // activeTab.focusedSessionId here would search the stale grid pane
  // underneath the command center.
  const commandSessionId = commandTargetSessionId(workspace)
  const activeCwd =
    commandSessionId
      ? (workspace.state.sessions[commandSessionId]?.cwd ?? null)
      : null

  // Reset state each time the modal opens — we want a fresh list
  // and a cleared query. Fetching fires unconditionally; the index
  // cache inside main makes this cheap when the data hasn't changed.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIdx(0)
    setError(null)
    setLoading(true)
    window.api
      .listRecentSessionsWithPrompts({
        limit: 10,
        promptsPerSession: 4,
        cwd: activeCwd,
      })
      .then(rows => {
        setSessions(rows)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    // Focus the input shortly after open so typing lands in it.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, activeCwd])

  // Debounced search effect. Re-runs whenever `query` changes; the
  // trailing cleanup cancels a pending IPC call if the user keeps
  // typing. An empty query falls back to the recent-list endpoint.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      const promise = trimmed
        ? window.api.searchSessionPrompts({
            query: trimmed,
            limit: 20,
            promptsPerSession: 8,
            cwd: activeCwd,
          })
        : window.api.listRecentSessionsWithPrompts({
            limit: 10,
            promptsPerSession: 4,
            cwd: activeCwd,
          })
      promise
        .then(rows => {
          setSessions(rows)
          setSelectedIdx(0)
          setLoading(false)
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, open])

  const resume = useCallback(
    async (entry: SessionIndexEntry) => {
      // Need the session's own cwd to resume under the right
      // filesystem context (see module docstring). Empty cwd means
      // the transcript head didn't carry it — rare but possible on
      // corrupted or truncated files; surface a small error.
      if (!entry.cwd) {
        setError(
          `Can't resume ${entry.providerSessionId.slice(0, 8)} — no cwd recorded in transcript.`,
        )
        return
      }
      setResuming(entry.providerSessionId)
      try {
        if (workspace.activeTab) {
          // In-place swap: keep the pane where it is, change what's
          // running in it. Matches the built-in resume picker's
          // behaviour — you came to find a conversation, you end up
          // AT that conversation, not next to a fresh pane.
          await workspace.replaceSession(entry.cwd, {
            resumeSessionId: entry.providerSessionId,
            kind: entry.kind,
          })
        } else {
          // No active pane to replace (fresh app launch with empty
          // workspace) — fall back to a new tab so the user still
          // lands on what they clicked.
          await workspace.newTab(entry.cwd, entry.providerSessionId, entry.kind)
        }
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setResuming(null)
      }
    },
    [workspace, onClose],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx(i => Math.min(sessions.length - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx(i => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const entry = sessions[selectedIdx]
        if (entry) void resume(entry)
      }
    },
    [sessions, selectedIdx, onClose, resume],
  )

  // Scroll the selected card into view on keyboard nav.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLDivElement>(
      `[data-session-idx="${selectedIdx}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const headerTitle = useMemo(() => {
    if (query.trim()) {
      return `Searching ${sessions.length === 0 ? 'no' : sessions.length} ${sessions.length === 1 ? 'match' : 'matches'}`
    }
    return 'Recent Conversations'
  }, [query, sessions.length])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center bg-black/40 pt-[8vh]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-[min(820px,94vw)] max-h-[82vh] flex flex-col overflow-hidden bg-surface border border-border-hi"
        onKeyDown={onKeyDown}
      >
        {/* Search input */}
        <div className="border-b border-border px-4 py-3 flex items-center gap-3">
          <span className="text-accent text-[13px] font-semibold select-none">
            ❯
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by prompt text (e.g. 'codex proxy 426')…"
            className="flex-1 bg-transparent outline-none border-none text-[14px] text-ink placeholder:text-muted"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
          <span className="text-[10px] uppercase tracking-wider text-muted select-none">
            esc
          </span>
        </div>

        {/* Header row */}
        <div className="border-b border-border px-4 py-2 flex items-center justify-between text-[11px] text-muted">
          <span>{loading ? 'Loading…' : headerTitle}</span>
          <span className="font-code opacity-80">
            ↑↓ navigate · ↵ resume · esc close
          </span>
        </div>

        {/* Error band */}
        {error ? (
          <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
            {error}
          </div>
        ) : null}

        {/* Results list */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {sessions.length === 0 && !loading ? (
            <div className="py-12 text-center text-[12px] text-muted">
              {query.trim()
                ? `No conversations match "${query.trim()}". Try fewer words.`
                : 'No conversations recorded yet.'}
            </div>
          ) : (
            sessions.map((entry, idx) => (
              <SessionCard
                key={`${entry.kind}:${entry.providerSessionId}`}
                entry={entry}
                selected={idx === selectedIdx}
                resuming={resuming === entry.providerSessionId}
                queryLower={query.trim().toLowerCase()}
                onHover={() => setSelectedIdx(idx)}
                onSelect={() => void resume(entry)}
                dataIdx={idx}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function SessionCard({
  entry,
  selected,
  resuming,
  queryLower,
  onHover,
  onSelect,
  dataIdx,
}: {
  entry: SessionIndexEntry
  selected: boolean
  resuming: boolean
  queryLower: string
  onHover: () => void
  onSelect: () => void
  dataIdx: number
}) {
  const glyph = providerGlyph(entry.kind)
  const base = cwdBasename(entry.cwd) || entry.cwd || '(no cwd)'

  return (
    <div
      data-session-idx={dataIdx}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={
        'border-b border-border px-4 py-3 cursor-pointer transition-colors ' +
        (selected ? 'bg-surface-hi' : 'hover:bg-canvas/60')
      }
    >
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-accent font-semibold select-none w-4 text-center">
          {glyph}
        </span>
        <span className="text-ink font-semibold">{entry.kind}</span>
        <span className="text-muted">·</span>
        <span className="text-ink-dim truncate">{base}</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{relativeTime(entry.lastModified)}</span>
        {entry.matchCount > 0 ? (
          <>
            <span className="text-muted">·</span>
            <span className="text-accent text-[11px]">
              {entry.matchCount} match{entry.matchCount === 1 ? '' : 'es'}
            </span>
          </>
        ) : null}
        {resuming ? (
          <span className="ml-auto text-[11px] text-muted">resuming…</span>
        ) : null}
      </div>

      {entry.recentUserPrompts.length === 0 ? (
        <div className="mt-2 text-[11px] italic text-muted">
          (no user prompts yet)
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {entry.recentUserPrompts.map((prompt, i) => (
            <PromptLine key={i} prompt={prompt} queryLower={queryLower} />
          ))}
        </div>
      )}
    </div>
  )
}

function PromptLine({
  prompt,
  queryLower,
}: {
  prompt: SessionIndexPrompt
  queryLower: string
}) {
  const preview = truncatePreview(prompt.text)
  const matched =
    queryLower.length > 0 && preview.toLowerCase().includes(queryLower)

  // Highlight the match span inline when searching. Single-occurrence
  // highlight is enough for the preview row; if the query matches
  // multiple places in the same prompt we still only mark the first.
  // The full match set is visible on the card because matched prompts
  // rank to the top of the card's prompt list.
  let rendered: React.ReactNode = preview
  if (matched && queryLower) {
    const lower = preview.toLowerCase()
    const start = lower.indexOf(queryLower)
    if (start >= 0) {
      rendered = (
        <>
          {preview.slice(0, start)}
          <span className="bg-accent/25 text-accent">
            {preview.slice(start, start + queryLower.length)}
          </span>
          {preview.slice(start + queryLower.length)}
        </>
      )
    }
  }

  return (
    <div className="flex items-start gap-2 text-[12px] leading-[1.5]">
      <span className="text-muted select-none">›</span>
      <span className="text-ink-dim" style={{ overflowWrap: 'anywhere' }}>
        {rendered}
      </span>
    </div>
  )
}
