import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../../../state/hooks'
import { collectLeaves } from '../../../workspace/tile-tree/treeOps'
import type { SessionId, Tab } from '../../../workspace/types'
import type { Workspace } from '../../../workspace/workspaceStore'
import type { Entry } from '../../../../../shared/types/transcript'

// AgentActivityModal — overview of every visible pane grouped by tab
// with a last-activity indicator per row.
//
// WHY this exists:
//   During a long working session the user ends up with many tabs
//   and split panes, only a few of which are still relevant. The
//   existing UI doesn't surface "when was this one last doing
//   something" — you have to click each tab in turn. This modal
//   gives a single triage view: kind, cwd, tab, last-active
//   timestamp, with row-level Focus / Close / Bury actions so the
//   user can clean up stale panes without leaving the modal.
//
// Activity derivation:
//   No new tracking — we piggyback on existing transcript data.
//   For each agent session we look at `runtime.entries` (already in
//   memory for every mounted session) and take the newest entry's
//   timestamp. For terminal sessions there's no transcript, so we
//   fall back to sessionStatus only.
//
//   The "live" detection uses `runtime.sessionStatus === 'running'`
//   plus `streamPhase !== 'idle'` so a currently-working agent
//   shows as active-now regardless of whether its latest
//   transcript entry has landed yet.

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

type Row = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  tabIndex: number
  kind: 'claude' | 'codex' | 'terminal'
  cwd: string
  cwdBase: string
  isFocused: boolean
  isLive: boolean
  lastActiveAt: number | null
  statusLabel: string | null
  statusTone: 'active' | 'idle' | 'exited' | 'terminal'
}

// Relative-time renderer copy-pasted from PromptSearchModal.tsx. We
// didn't extract to a shared util because the other component is the
// only other caller right now — when a third surface wants it, hoist.
function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'in the future'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

function absoluteTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Read the newest timestamp from an entries array. Entries are stored
// in chronological order (oldest → newest), so we iterate from the
// tail until we find one with a parseable timestamp. Not every entry
// carries one — meta/system markers often don't — hence the scan
// instead of grabbing entries[entries.length - 1] blindly.
function extractLatestEntryTs(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = (entries[i] as { timestamp?: unknown }).timestamp
    if (typeof raw !== 'string') continue
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function cwdBasename(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function providerGlyph(kind: 'claude' | 'codex' | 'terminal'): string {
  if (kind === 'claude') return '⏺'
  if (kind === 'codex') return '›'
  return '$'
}

export function AgentActivityModal({ open, workspace, onClose }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [nowTick, setNowTick] = useState(0)
  const inputRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Used by the bury action — we need to open the note-prompt modal
  // targeting a specific session id without touching whatever pane
  // is currently focused. openBuryPrompt takes a sessionId directly,
  // which is exactly the handle we have here.
  const openBuryPrompt = useAppStore(s => s.openBuryPrompt)

  // Re-render on a timer so relative-time strings ("3m ago") don't
  // get visually stale while the modal is open. 10s is fine-grained
  // enough to feel live without churning the DOM excessively.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(t => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  const rows = useMemo<Row[]>(() => {
    // Intentional read of nowTick — forces recompute so "active-now"
    // agents that finish between ticks flip to idle with the timer,
    // not only on store-update. Cheap, guarded by `open`.
    void nowTick

    const built: Row[] = []
    workspace.state.tabs.forEach((tab: Tab, tabIndex: number) => {
      const leaves = collectLeaves(tab.root)
      for (const sessionId of leaves) {
        const meta = workspace.state.sessions[sessionId]
        if (!meta) continue
        const kind = (meta.kind ?? 'claude') as 'claude' | 'codex' | 'terminal'
        const runtime = workspace.runtimes[sessionId]

        let lastActiveAt: number | null = null
        let isLive = false
        let statusLabel: string | null = null
        let statusTone: Row['statusTone'] = 'idle'

        if (kind === 'terminal') {
          // No transcript for terminals. If we've observed a PTY exit
          // we surface that explicitly; otherwise just label them.
          statusLabel = runtime?.exited != null ? 'Exited' : 'Terminal'
          statusTone = runtime?.exited != null ? 'exited' : 'terminal'
        } else if (runtime) {
          // Live = the adapter has an in-flight turn right now.
          // streamPhase is the canonical "what is the agent doing"
          // signal (see workspaceState.ts StreamPhase docstring).
          const running = runtime.sessionStatus === 'running'
          const streaming = runtime.streamPhase && runtime.streamPhase !== 'idle'
          isLive = Boolean(running || streaming)

          lastActiveAt = extractLatestEntryTs(runtime.entries)
          // A live turn may not have landed its first timestamped
          // entry yet. Fall back to turnStartedAt so the row still
          // sorts near-now instead of at "never active".
          if (lastActiveAt == null && runtime.turnStartedAt != null) {
            lastActiveAt = runtime.turnStartedAt
          }

          if (runtime.sessionStatus === 'exited') {
            statusLabel = 'Exited'
            statusTone = 'exited'
          } else if (isLive) {
            statusLabel = 'Active now'
            statusTone = 'active'
          } else {
            statusLabel = null
            statusTone = 'idle'
          }
        } else {
          // Runtime hasn't mounted yet (rare — happens briefly right
          // after spawn). Show the pane but leave activity unknown.
          statusLabel = 'Starting…'
          statusTone = 'idle'
        }

        built.push({
          sessionId,
          tabId: tab.id,
          tabTitle: tab.title,
          tabIndex,
          kind,
          cwd: meta.cwd,
          cwdBase: cwdBasename(meta.cwd),
          isFocused: tab.focusedSessionId === sessionId,
          isLive,
          lastActiveAt,
          statusLabel,
          statusTone,
        })
      }
    })

    // Sort order: live sessions first (regardless of timestamp) so
    // the user sees what's working, then everything else by
    // most-recent-activity descending. Stale sessions naturally
    // sink to the bottom where they're easiest to mass-close with
    // End+↑+Delete.
    built.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1
      const at = a.lastActiveAt ?? 0
      const bt = b.lastActiveAt ?? 0
      if (at !== bt) return bt - at
      // Tie-breaker: group same-tab rows together to aid scanning.
      if (a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex
      return 0
    })
    return built
  }, [workspace.state.tabs, workspace.state.sessions, workspace.state.activeTabId, workspace.runtimes, nowTick])

  // Keep selection valid when rows change (close shrinks the list,
  // open reopens with a possibly-different length). Math.min clamps
  // cleanly to the last row or to 0 when empty.
  useEffect(() => {
    setSelectedIdx(i => Math.min(Math.max(0, rows.length - 1), Math.max(0, i)))
  }, [rows.length])

  // Reset selection on open so the user always lands on the first row.
  useEffect(() => {
    if (open) {
      setSelectedIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Autoscroll selected row into view when keyboard-nav changes it.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLDivElement>(
      `[data-row-idx="${selectedIdx}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, rows.length])

  const focusRow = useCallback(
    (row: Row) => {
      workspace.focusSessionInTab(row.tabId, row.sessionId)
      onClose()
    },
    [onClose, workspace],
  )

  const closeRow = useCallback(
    async (row: Row) => {
      // Don't close the modal — user likely wants to close several
      // stale panes in a row. The row will disappear on next render
      // via the rows useMemo watching workspace.state.
      await workspace.closeSession(row.sessionId)
    },
    [workspace],
  )

  const buryRow = useCallback(
    (row: Row) => {
      // Agent sessions only — bury keeps the process alive so the
      // user can revive from the Revive Buried Pane command. Codex
      // and Claude both support this; terminal doesn't (no notion
      // of a resumable conversation).
      if (row.kind === 'terminal') return
      // Close our modal before the bury-note prompt opens so the
      // two dialogs don't stack visually. buryFocused(note, id)
      // already accepts an explicit target id, so the note prompt
      // does the right thing even after we close here.
      onClose()
      openBuryPrompt(row.sessionId)
    },
    [onClose, openBuryPrompt],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (rows.length === 0) return
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        setSelectedIdx(i => Math.min(rows.length - 1, i + 1))
        return
      }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault()
        setSelectedIdx(i => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setSelectedIdx(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        setSelectedIdx(Math.max(0, rows.length - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[selectedIdx]
        if (row) focusRow(row)
        return
      }
      // Backspace/Delete = close the selected pane. Preferred over a
      // single-key binding because both are consistent with
      // "remove" semantics in list UIs across the rest of the app.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        const row = rows[selectedIdx]
        if (row) void closeRow(row)
        return
      }
      // Lowercase b = bury. Uppercase treated the same — the user
      // may hold shift out of muscle memory, shouldn't punish them.
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        const row = rows[selectedIdx]
        if (row) buryRow(row)
        return
      }
    },
    [rows, selectedIdx, onClose, focusRow, closeRow, buryRow],
  )

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent Activity"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[min(760px,92vw)] max-h-[82vh] overflow-hidden bg-surface border border-border-hi flex flex-col">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] text-ink">Agent Activity</div>
              <div className="mt-1 text-[11px] text-muted">
                {rows.length === 0
                  ? 'No panes open.'
                  : `${rows.length} pane${rows.length === 1 ? '' : 's'} across ${new Set(rows.map(r => r.tabId)).size} tab${new Set(rows.map(r => r.tabId)).size === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Enter focus · Del close · B bury · Esc dismiss
            </div>
          </div>
        </div>

        <div
          ref={inputRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="flex-1 min-h-0 overflow-y-auto outline-none"
        >
          <div ref={listRef}>
            {rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-muted">
                Nothing to triage.
              </div>
            ) : (
              rows.map((row, idx) => {
                const selected = idx === selectedIdx
                return (
                  <div
                    key={row.sessionId}
                    data-row-idx={idx}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => focusRow(row)}
                    className={`
                      group flex items-start gap-3
                      px-4 py-2.5 border-b border-border last:border-b-0
                      cursor-pointer
                      ${selected ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-surface-hi'}
                    `}
                  >
                    {/* Provider glyph + kind */}
                    <div className="flex-shrink-0 w-[72px] flex items-center gap-2">
                      <span className={row.isLive ? 'text-accent' : 'text-muted'}>
                        {providerGlyph(row.kind)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wider text-muted">
                        {row.kind}
                      </span>
                    </div>

                    {/* Main column: cwd + tab */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[12px] font-code text-ink truncate">
                        <span className="truncate">{row.cwdBase}</span>
                        {row.isFocused && (
                          <span className="text-[9px] uppercase tracking-wider text-accent flex-shrink-0">
                            focused
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        tab {row.tabIndex + 1} · {row.tabTitle} · {row.cwd}
                      </div>
                    </div>

                    {/* Activity column */}
                    <div className="flex-shrink-0 w-[140px] text-right">
                      {row.statusLabel && (
                        <div
                          className={
                            row.statusTone === 'active'
                              ? 'text-[11px] text-accent'
                              : row.statusTone === 'exited'
                                ? 'text-[11px] text-red-300'
                                : 'text-[11px] text-muted'
                          }
                        >
                          {row.statusLabel}
                        </div>
                      )}
                      {row.lastActiveAt != null && !row.isLive && (
                        <>
                          <div className="text-[11px] text-ink-dim">
                            {relativeTime(row.lastActiveAt)}
                          </div>
                          <div className="text-[10px] text-muted">
                            {absoluteTime(row.lastActiveAt)}
                          </div>
                        </>
                      )}
                      {row.lastActiveAt == null && row.kind !== 'terminal' && !row.isLive && (
                        <div className="text-[10px] text-muted">no activity yet</div>
                      )}
                    </div>

                    {/* Actions — visible on selected row or on hover. */}
                    <div
                      className={`
                        flex-shrink-0 flex items-center gap-1
                        ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                        transition-opacity
                      `}
                      onClick={e => e.stopPropagation()}
                    >
                      {row.kind !== 'terminal' && (
                        <button
                          type="button"
                          onClick={() => buryRow(row)}
                          className="px-2 py-0.5 text-[10px] border border-border text-ink-dim hover:border-border-hi hover:text-ink"
                          title="Bury (b)"
                        >
                          bury
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void closeRow(row)}
                        className="px-2 py-0.5 text-[10px] border border-red-600/40 text-red-300 hover:border-red-500 hover:bg-red-500/10"
                        title="Close (del)"
                      >
                        close
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-border px-4 py-2 flex items-center justify-between gap-3">
          <div className="text-[10px] text-muted">
            Live agents pinned to top. Stale panes sort to the bottom for easy cleanup.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
