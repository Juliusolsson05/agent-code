import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Conversation, ConversationScope } from '@shared/conversations/types'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { SessionPreviewPane } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import type { PreviewTarget } from '@renderer/features/session-preview/ui/SessionPreviewPane'
import { useConversationList } from '@renderer/features/conversations/useConversationList'
import { ConversationRow } from '@renderer/features/conversations/ui/ConversationRow'

// The Conversations picker: the one surface behind Resume Session… and
// Search Conversations… (docs/decomposition/conversations.md, Stage 4).
//
// It decides nothing about identity, scope membership or order; those come
// from main. It owns: which filters are on, which row is highlighted, and
// what happens on Enter. Resume uses the ROW's cwd and provider, never the
// focused pane's: the picker lists other worktrees and other providers on
// purpose, and resuming a Codex worktree session as a Claude session in the
// main checkout was the old surface's silent failure.

type Props = { open: boolean; focusSearch: boolean; workspace: Workspace; onClose: () => void }

const SCOPES: Array<{ id: ConversationScope; label: string }> = [
  { id: 'cwd', label: 'this folder' },
  { id: 'repository', label: 'repository' },
  { id: 'everywhere', label: 'everywhere' },
]

export function ConversationsPicker({ open, focusSearch, workspace, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ConversationScope>('repository')
  const [providers, setProviders] = useState<AgentProviderKind[]>([])
  const [includeChildren, setIncludeChildren] = useState(false)
  const [selected, setSelected] = useState(0)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  // Width-based and in-memory only: the picker is transient, so a drag does
  // not need to survive a close (same policy as the path picker).
  const [listWidth, setListWidth] = useState(520)
  const splitter = useResizableSplitter({
    onDrag: clientX => {
      const rect = modalRef.current?.getBoundingClientRect()
      if (rect) setListWidth(Math.max(360, Math.min(800, clientX - rect.left)))
    },
  })

  // The commanded pane's cwd seeds the family. Dispatch Mode has its own
  // focused row, so activeTab.focusedSessionId would point at the stale grid
  // pane underneath the command center.
  const commandSessionId = commandTargetSessionId(workspace)
  const cwd = commandSessionId ? workspace.state.sessions[commandSessionId]?.cwd ?? null : null
  const { response, loading, error, needsPane, loadMore } = useConversationList({ open, cwd, scope, providers, includeChildren, query })
  const rows = response?.rows ?? []

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setIncludeChildren(false)
    setResumeError(null)
    requestAnimationFrame(() => {
      if (focusSearch) inputRef.current?.focus()
      else listRef.current?.focus()
    })
  }, [open, focusSearch])
  // Reset the highlight when the list's head changes (a new query, filter or
  // scope), but not when loadMore appends rows below it.
  const headId = response?.rows[0]?.nativeId ?? null
  useEffect(() => { setSelected(0) }, [headId, query, scope, providers, includeChildren])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-conversation-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const resume = useCallback(async (row: Conversation) => {
    if (!row.available) {
      // The index remembers the thread but its transcript file is gone; the
      // row is listed for the record, and resuming it would only open a pane
      // that fails on a missing file.
      setResumeError(`Can't resume ${row.label}: its transcript file is missing. The row is listed for the record.`)
      return
    }
    if (!row.cwd) {
      // A transcript that never recorded a cwd (a bridge-session stub) has
      // nowhere to resume in; the row is listed so it can be seen, not used.
      setResumeError(`Can't resume ${row.nativeId.slice(0, 8)}: the transcript records no working directory.`)
      return
    }
    onClose()
    if (workspace.activeTab) {
      // In-place swap: the pane stays where it is, what runs in it changes.
      await workspace.replaceSession(row.cwd, { resumeSessionId: row.nativeId, kind: row.provider })
    } else {
      // Fresh launch with nothing to replace: a new tab in the row's cwd.
      await workspace.newTab(row.cwd, row.nativeId, row.provider)
    }
  }, [onClose, workspace])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(i => Math.min(rows.length - 1, i + 1))
      if (selected >= rows.length - 5) loadMore()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[selected]
      if (row) void resume(row)
    }
  }, [rows, selected, resume, loadMore])

  const previewTarget: PreviewTarget | null = useMemo(() => {
    const row = rows[selected]
    return row && row.available && row.cwd ? { kind: row.provider, cwd: row.cwd, providerSessionId: row.nativeId } : null
  }, [rows, selected])

  const toggleProvider = (kind: AgentProviderKind) =>
    setProviders(prev => (prev.includes(kind) ? prev.filter(p => p !== kind) : [...prev, kind]))

  const banner = error ?? resumeError

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent ref={modalRef} className="w-[min(1240px,96vw)] top-[8vh] max-h-[84vh] translate-y-0 flex flex-col overflow-hidden" onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Conversations</DialogTitle>
        <DialogDescription className="sr-only">Find a past conversation across this repository's worktrees and every provider, preview it, and resume it.</DialogDescription>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-accent select-none">❯</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search conversations by title, name or prompt…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted"
          />
          <span className="text-[10px] uppercase tracking-wider text-muted select-none">esc</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted">
          <div role="group" aria-label="Scope" className="flex overflow-hidden rounded-slab border border-border">
            {SCOPES.map(s => (
              <button key={s.id} type="button" aria-pressed={scope === s.id} onClick={() => setScope(s.id)} className={`px-2 py-0.5 ${scope === s.id ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{s.label}</button>
            ))}
          </div>
          <div role="group" aria-label="Providers" className="flex gap-1">
            {AGENT_PROVIDER_KINDS.map(kind => (
              <button key={kind} type="button" aria-pressed={providers.includes(kind)} onClick={() => toggleProvider(kind)} className={`rounded-slab border border-border px-2 py-0.5 ${providers.includes(kind) ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{kind}</button>
            ))}
          </div>
          {response && (
            <button type="button" aria-pressed={includeChildren} onClick={() => setIncludeChildren(v => !v)} className="ml-auto rounded-slab border border-border px-2 py-0.5 hover:bg-row-hover-bg">
              {includeChildren ? `showing ${response.hiddenChildren} children` : `${response.hiddenChildren} hidden`}
            </button>
          )}
          <span className="font-code opacity-80">
            {loading
              ? 'loading…'
              : response
                ? query.trim()
                  ? `${response.rows.length}${response.nextCursor ? '+' : ''} matches of ${response.total}`
                  : `${response.total} conversations`
                : ''}
            {' · ↑↓ ↵ resume'}
          </span>
        </div>
        {banner && <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">{banner}</div>}
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            tabIndex={-1}
            role="listbox"
            aria-label="Conversations"
            className="min-h-0 overflow-y-auto outline-none"
            style={{ width: listWidth, flexShrink: 0 }}
            onScroll={e => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore() }}
          >
            {needsPane ? (
              <div className="py-12 text-center text-[12px] text-muted">Focus a pane to list its repository, or switch the scope to everywhere.</div>
            ) : rows.length === 0 && !loading && !error ? (
              <div className="py-12 text-center text-[12px] text-muted">{query.trim() ? `No conversations match "${query.trim()}".` : 'No conversations recorded for this scope.'}</div>
            ) : rows.map((row, i) => (
              <ConversationRow key={`${row.provider}:${row.nativeId}`} row={row} index={i} selected={i === selected} onHover={() => setSelected(i)} onSelect={() => void resume(row)} />
            ))}
          </div>
          <div onMouseDown={splitter.onMouseDown} className={`w-1 flex-shrink-0 cursor-col-resize ${splitter.dragging ? 'bg-accent' : 'bg-border hover:bg-border-hi'}`} />
          <div className="min-w-0 flex-1 border-l border-border">
            <SessionPreviewPane target={previewTarget} turnCount={rows[selected]?.promptCount ?? null} />
          </div>
        </div>
        {splitter.cursorLock}
      </DialogContent>
    </Dialog>
  )
}
