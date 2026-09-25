import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { focusedControlOwnsEnter } from '@renderer/components/ui/dialog-actions'

import type { Conversation, ConversationScope } from '@shared/conversations/types'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { SESSION_START_FAILED_MESSAGE } from '@shared/types/session'
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
  const { response, loading, error, needsPane, loadMore, stale } = useConversationList({ open, cwd, scope, providers, includeChildren, query })
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
  //
  // `providers` is keyed by CONTENT (steering q27, #1297): the enablement
  // effect above rebuilds the array on every store update, and the old
  // identity dependency threw the user's highlight back to row 0 whenever
  // enablement refreshed (a setup check finishing, a toggle in another
  // window), so Enter resumed a conversation the user had not chosen. Pinned
  // by 'keeps the highlight when an enablement refresh…'.
  //
  // WHY during render and not in an effect: CI (#1266's run) showed the
  // effect-based reset landing AFTER a key press. That ordering came from the
  // test's act() batching; in the app, React flushes pending passive effects
  // before it applies a discrete key event, and a MutationObserver probe
  // found no painted frame with a stale highlight. Resetting while rendering
  // (React's "adjust state when a prop changes") removes the dependence on
  // that React internal: the first paint of a new head already highlights
  // row 0.
  //
  // `stale` is in the key too (#1297 review C1): the reset must happen again
  // when the fresh page LANDS, not only when the parameters change. Anything
  // that moved the highlight in between pointed at an old row; a new page
  // that keeps the same head would otherwise keep that index, and Enter
  // resumed whatever replaced it. loadMore only appends to a fresh list, so
  // it never flips `stale` and paging keeps the highlight. Today the pointer
  // is the one thing that could move it (the key guard below stops keys, and
  // the row's onHover ignores a stale list); this reset is the backstop for
  // any path added later, not the only guard.
  const headId = response?.rows[0]?.nativeId ?? null
  const highlightResetKey = JSON.stringify([headId, query, scope, providers.join(','), includeChildren, stale])
  const [lastHighlightResetKey, setLastHighlightResetKey] = useState(highlightResetKey)
  if (highlightResetKey !== lastHighlightResetKey) {
    setLastHighlightResetKey(highlightResetKey)
    setSelected(0)
  }
  // An inline resume error names the row it was about; moving the highlight
  // makes it stale (#1262 review B).
  useEffect(() => { setResumeError(null) }, [selected])
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
    // The pane the swap is aimed at, read BEFORE the picker closes: it is the
    // one place a failure can still be reported once the picker is gone.
    const targetSessionId = commandTargetSessionId(workspace)
    if (workspace.activeTab && !targetSessionId) {
      // Nothing to swap into; closing would only hide a no-op.
      setResumeError(`Can't resume ${row.label} here: no agent pane is selected.`)
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
      //
      // WHY every outcome is reported on the pane (#1241): the picker has
      // already closed, and the callers fire this with `void`, so a spawn
      // failure (e.g. the provider's CLI removed since the transcript was
      // written) was an unhandled rejection and an `undefined` (no command
      // target, missing meta, a refused commit) was silence. The pane just
      // stayed as it was. builtInMcpReload reports the same call this way.
      try {
        const replaced = await workspace.replaceSession(row.cwd, { resumeSessionId: row.nativeId, kind: row.provider, newConversation: true })
        if (!replaced) workspace.showPaneToast(targetSessionId!, `Couldn't resume ${row.label} in this pane.`)
      } catch {
        // WHY a fixed sentence and never the rejection's text (steering q22,
        // #1262 review B): the spawn rejection is Electron's wrapper around the
        // raw provider exception, which can carry environment values, proxy
        // URLs or scoped MCP tokens. Main's recovery path and the reload path
        // (#1252) show this same safe message for the same failure.
        workspace.showPaneToast(targetSessionId!, `Couldn't resume ${row.label}: ${SESSION_START_FAILED_MESSAGE}`)
      }
    } else {
      // Fresh launch with nothing to replace: a new tab in the row's cwd.
      // newTab already toasts its own failure and rethrows; the catch only
      // keeps this `void`-fired resume from ending in an unhandled rejection
      // (#1262 review A).
      await workspace.newTab(row.cwd, row.nativeId, row.provider).catch(() => undefined)
    }
  }, [onClose, workspace])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // While the rows on screen answer an OLDER query, scope or filter, the
    // keyboard must not act on them (#1297 review A): Enter resumed a row the
    // new scope excludes, and an arrow press moved the highlight onto a row
    // the arriving page then replaced, so Enter resumed a conversation the
    // user never highlighted. The debounce plus the request is ~120 ms+; the
    // reset to row 0 (below) already happened when the parameters changed,
    // so the new page arrives highlighted at its own head. A mouse click on
    // a visible row is still a deliberate choice and stays allowed.
    if (stale && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.key === 'Enter' && !focusedControlOwnsEnter(e.target)))) {
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(i => Math.min(rows.length - 1, i + 1))
      if (selected >= rows.length - 5) loadMore()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      // A focused control owns its own Enter (#867). This handler sits on
      // `DialogContent`, and the scope and provider chips below are ordinary
      // tabbable buttons inside it — so without this, Tab to the "everywhere"
      // chip and Enter did not toggle the chip: it RESUMED the highlighted
      // conversation, replacing what was running in the focused pane. The
      // #867 audit called this picker safe because it has no footer; the rule
      // is about the focused CONTROL, not the footer slot.
      if (focusedControlOwnsEnter(e.target)) return
      e.preventDefault()
      const row = rows[selected]
      if (row) void resume(row)
    }
  }, [rows, selected, resume, loadMore, stale])

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
            {AGENT_PROVIDER_KINDS.filter(kind => enabledKinds.has(kind)).map(kind => (
              <button key={kind} type="button" aria-pressed={providers.includes(kind)} onClick={() => toggleProvider(kind)} className={`rounded-slab border border-border px-2 py-0.5 ${providers.includes(kind) ? 'bg-row-selected-bg text-row-selected-fg' : 'hover:bg-row-hover-bg'}`}>{kind}</button>
            ))}
          </div>
          {response && (
            <button type="button" aria-pressed={includeChildren} onClick={() => setIncludeChildren(v => !v)} className="ml-auto rounded-slab border border-border px-2 py-0.5 hover:bg-row-hover-bg">
              {includeChildren ? `showing ${response.hiddenChildren} children` : `${response.hiddenChildren} hidden`}
            </button>
          )}
          <span className="font-code opacity-80">
            {/* Stale rows are on screen and the keyboard ignores them until the
                new page lands (#1297 round 2): say so at once, including the
                debounce before the request starts. */}
            {loading || stale
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
              <ConversationRow key={`${row.provider}:${row.nativeId}`} row={row} index={i} selected={i === selected} onHover={() => { if (!stale) setSelected(i) }} onSelect={() => void resume(row)} />
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
