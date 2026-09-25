import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@renderer/components/ui/empty-state'
import { Kbd, KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'

import type { Conversation, ConversationScope } from '@shared/conversations/types'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
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
  // The provider filter buttons follow enablement (#1102 "everywhere");
  // sessions of a disabled provider stay in the list itself — only the
  // shortcut buttons hide. A selected-but-now-disabled kind is dropped so
  // the filter cannot silently narrow results to a hidden provider.
  const enabledKinds = useEnabledAgentProviderKinds()
  useEffect(() => {
    setProviders(prev => prev.filter(kind => enabledKinds.has(kind)))
  }, [enabledKinds])
  const [includeChildren, setIncludeChildren] = useState(false)
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
    setIncludeChildren(false)
    setResumeError(null)
    // (Initial focus moved to DialogContent's onOpenAutoFocus — the rAF here
    // raced Radix's own mount focus.)
  }, [open, focusSearch])

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
      //
      // `newConversation` is what says that out loud (#1090 review). Every
      // other caller of `replaceSession` continues the SAME agent, so the
      // successor inherits the pane's orchestration parentage; this one pulls
      // a stranger's conversation in, and inheriting parentage here would file
      // it as somebody's orchestration child — reported to that parent as its
      // worker's answer, and killed by `close_run`.
      await workspace.replaceSession(row.cwd, { resumeSessionId: row.nativeId, kind: row.provider, newConversation: true })
    } else {
      // Fresh launch with nothing to replace: a new tab in the row's cwd.
      await workspace.newTab(row.cwd, row.nativeId, row.provider)
    }
  }, [onClose, workspace])

  // The shared list keys (plan K5/S20). Keyed by conversation so a
  // loadMore append — or a live index refresh — never slides the highlight;
  // reset to the top whenever the list's HEAD changes (a new query, filter or
  // scope), exactly as the hand-rolled version did, but not on appends.
  //
  // A focused control owns its own Enter (#867), enforced inside the hook:
  // the scope and provider chips are ordinary tabbable buttons, and without
  // the rule Tab to "everywhere" + Enter RESUMED the highlighted conversation,
  // replacing what was running in the focused pane.
  const headId = response?.rows[0]?.nativeId ?? null
  const rowKeys = useMemo(() => rows.map(row => `${row.provider}:${row.nativeId}`), [rows])
  const nav = useListNavigation({
    count: rows.length,
    keys: rowKeys,
    resetKey: `${open}|${headId}|${query}|${scope}|${providers.join(',')}|${includeChildren}`,
    onActivate: index => {
      const row = rows[index]
      if (row) void resume(row)
    },
    idPrefix: 'conversation',
  })
  const selected = nav.index
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!nav.onKeyDown(e)) return
    // Page in more rows as the keyboard highlight nears the end (the scroll
    // handler below covers the mouse wheel).
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'End' || (e.ctrlKey && e.key === 'n')) {
      if (nav.index >= rows.length - 6) loadMore()
    }
  }, [nav, rows.length, loadMore])

  const previewTarget: PreviewTarget | null = useMemo(() => {
    const row = rows[selected]
    return row && row.available && row.cwd ? { kind: row.provider, cwd: row.cwd, providerSessionId: row.nativeId } : null
  }, [rows, selected])

  const toggleProvider = (kind: AgentProviderKind) =>
    setProviders(prev => (prev.includes(kind) ? prev.filter(p => p !== kind) : [...prev, kind]))

  const banner = error ?? resumeError

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        ref={modalRef}
        size="xl"
        className="top-[8vh] max-h-[84vh] translate-y-0 flex flex-col overflow-hidden"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={event => {
          // Search Conversations… opens in the search box, Resume Session… on
          // the list — each is the focus OWNER of the highlight in its mode
          // (the input as a combobox, the list as a listbox; focus-owner
          // invariant, useListNavigation).
          event.preventDefault()
          if (focusSearch) inputRef.current?.focus()
          else listRef.current?.focus()
        }}
      >
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
            // Combobox pattern: DOM focus stays here while the arrows move the
            // highlight, so THIS element must carry aria-activedescendant.
            role="combobox"
            aria-label="Search conversations"
            aria-expanded
            aria-controls="conversations-listbox"
            aria-activedescendant={nav.activeId}
            // outline-none with the caret as the focus signal: the search
            // box is the header's only text field and the palette's idiom
            // (plan T4 exception for a borderless primary search field).
            className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
          />
          {/* The lowercase "esc" text became the shared chip (plan H1). */}
          <Kbd binding="Escape" />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted">
          <div role="group" aria-label="Scope" className="flex overflow-hidden rounded-slab border border-border">
            {SCOPES.map(s => (
              <button key={s.id} type="button" aria-pressed={scope === s.id} onClick={() => setScope(s.id)} className={`px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring ${scope === s.id ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{s.label}</button>
            ))}
          </div>
          <div role="group" aria-label="Providers" className="flex gap-1">
            {AGENT_PROVIDER_KINDS.filter(kind => enabledKinds.has(kind)).map(kind => (
              <button key={kind} type="button" aria-pressed={providers.includes(kind)} onClick={() => toggleProvider(kind)} className={`rounded-control border border-border px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${providers.includes(kind) ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{kind}</button>
            ))}
          </div>
          {response && (
            <button type="button" aria-pressed={includeChildren} onClick={() => setIncludeChildren(v => !v)} className="ml-auto rounded-control border border-border px-2 py-0.5 outline-none hover:bg-row-hover-bg focus-visible:ring-1 focus-visible:ring-focus-ring">
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
          </span>
          {/* The prose " · ↑↓ ↵ resume" became chips (plan H3). */}
          <KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Enter'], label: 'resume' }]} className="text-[10px]" />
        </div>
        {banner && <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">{banner}</div>}
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            id="conversations-listbox"
            // A Tab stop (plan K4, was -1): Shift+Tab from the chips must be
            // able to reach the list, which owns the highlight when focused.
            tabIndex={0}
            role="listbox"
            aria-label="Conversations"
            aria-activedescendant={nav.activeId}
            className="min-h-0 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
            style={{ width: listWidth, flexShrink: 0 }}
            onScroll={e => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore() }}
          >
            {needsPane ? (
              <EmptyState>Focus a pane to list its repository, or switch the scope to everywhere.</EmptyState>
            ) : rows.length === 0 && !loading && !error ? (
              <EmptyState role="status">{query.trim() ? `No conversations match “${query.trim()}”.` : 'No conversations recorded for this scope.'}</EmptyState>
            ) : rows.map((row, i) => (
              <ConversationRow key={`${row.provider}:${row.nativeId}`} row={row} index={i} selected={i === selected} itemProps={nav.getItemProps(i)} />
            ))}
          </div>
          {/* Keyboard-resizable (plan N11): it was mouse-only. A focusable
              separator; ←/→ move it 24px, the same clamp as the drag. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversation list"
            aria-valuenow={listWidth}
            aria-valuemin={360}
            aria-valuemax={800}
            tabIndex={0}
            onMouseDown={splitter.onMouseDown}
            onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              event.stopPropagation()
              setListWidth(width => Math.max(360, Math.min(800, width + (event.key === 'ArrowLeft' ? -24 : 24))))
            }}
            className={`w-1 flex-shrink-0 cursor-col-resize outline-none focus-visible:bg-focus-ring ${splitter.dragging ? 'bg-accent' : 'bg-border hover:bg-border-hi'}`}
          />
          <div className="min-w-0 flex-1 border-l border-border">
            <SessionPreviewPane target={previewTarget} turnCount={rows[selected]?.promptCount ?? null} />
          </div>
        </div>
        {splitter.cursorLock}
      </DialogContent>
    </Dialog>
  )
}
