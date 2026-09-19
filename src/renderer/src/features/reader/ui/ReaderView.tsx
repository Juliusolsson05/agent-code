import { UsageLimitNoticeView } from '@providers/shared/renderer/protocols/usage-limit/UsageLimitNoticeView'
import { useUsageLimitActions } from '@renderer/features/usage-limit/useUsageLimitActions'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { SafeInlineCode } from '@renderer/features/rendered-content/SafeInlineCode'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { DEFAULT_PROVIDER, isAgentProviderKind, isAgentSessionKind } from '@shared/types/providerKind'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import {
  readerMessagesFromFeedItems,
  type ReaderMessage,
} from '@renderer/features/reader/model/readerMessages'
import {
  nextReaderSelection,
  sameReaderList,
} from '@renderer/features/reader/model/readerSelection'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { useSessionRuntime } from '@renderer/workspace/useSessionRuntime'
import { dispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, Workspace } from '@renderer/workspace/workspaceStore'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'

// ReaderView — single-message read mode for a focused session.
//
// Renders one assistant message at a time (markdown, no tool chrome, no
// composer), paging through exactly the assistant prose the session's Feed
// paints: committed transcript text plus the ledger's live semantic text
// while a turn streams. See features/reader/model/readerMessages.ts for why
// that is the only source — Reader never reads the terminal screen (#855).
//
// The point: when the user has 5 panes open and just wants to read
// the plan one specific agent wrote, dropping into Reader Mode gives
// them a clean doc-style view without scrolling past tool calls.
//
// Pills along the top mirror SpotlightView so the user can switch
// which session they're reading without leaving Reader Mode.

const REMARK_PLUGINS = [remarkGfm]

// Markdown renderer pieces — mirrored from Feed.tsx so the typography
// in Reader matches an assistant message in the normal feed exactly.
//
// Keeping local copies (instead of importing MARKDOWN_COMPONENTS from
// Feed) because Feed doesn't export them and pulling them out right
// now would collide with the in-flight features/ refactor. When that
// refactor lands we should consolidate this into a shared
// assistantMarkdown.tsx module that Feed also consumes — tracked as
// a follow-up on the Reader plan.
function MarkdownPre({ children }: { children?: ReactNode }) {
  // Strip the default <pre> wrapper — MarkdownCode below renders
  // fenced blocks via CodeBlock directly, so we don't want the
  // browser's default <pre> styling nested around our component.
  return <>{children}</>
}

function MarkdownCode({
  className,
  children,
}: {
  className?: string
  children?: ReactNode
}) {
  const { sessionId, workspaceRoot } = useContext(CodeRenderContext)
  const text = String(children ?? '').replace(/\n$/, '')
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? null

  // Inline code: no language AND no newlines → plain <code>, styled
  // by the prose theme (accent color, no background chip).
  const isInline = !language && !text.includes('\n')
  if (isInline) {
    return <SafeInlineCode>{children}</SafeInlineCode>
  }

  return (
    <CodeBlock
      code={text}
      language={language}
      workspaceRoot={workspaceRoot}
      codeId={`${sessionId}:${text.slice(0, 24)}`}
      engine="monaco"
      allowAutoDetect={!language}
    />
  )
}

const MARKDOWN_COMPONENTS: import('react-markdown').Options['components'] = {
  pre: MarkdownPre,
  code: MarkdownCode,
  a: SafeMarkdownLink,
}

type Props = {
  workspace: Workspace
}

export function ReaderView({ workspace }: Props) {
  const reader = workspace.readerMode
  if (!reader) return null
  const tab = workspace.state.tabs.find(item => item.id === reader.tabId)
  if (!tab) return null

  const sessionIds = (workspace.dispatchMode
    ? dispatchSessionIdsForTab(workspace.state, tab.id)
    : resolveTabSessions(workspace.state, tab.id))
    // WHY Reader filters terminal sessions even though Dispatch can render
    // them: Reader is a transcript surface. Terminal sessions render raw PTY
    // scrollback through xterm.js and do not have assistant messages to
    // extract. Keeping the filter here protects restored/stale reader state in
    // addition to the command-palette guard that prevents new terminal entry.
    .filter(sessionId => isAgentSessionKind(workspace.state.sessions[sessionId]?.kind))
  if (sessionIds.length === 0) return null

  const focusedSessionId = sessionIds.includes(reader.focusedSessionId)
    ? reader.focusedSessionId
    : sessionIds[0]

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col bg-canvas">
      <ReaderBody
        workspace={workspace}
        sessionId={focusedSessionId}
        sessionIds={sessionIds}
      />
    </div>
  )
}

function ReaderBody({
  workspace,
  sessionId,
  sessionIds,
}: {
  workspace: Workspace
  sessionId: SessionId
  sessionIds: SessionId[]
}) {
  const runtime = useSessionRuntime(workspace, sessionId)
  const usageLimitActions = useUsageLimitActions(workspace, sessionId, runtime.sessionRunId)
  const meta = workspace.state.sessions[sessionId]
  // The pane's real provider, never a `=== 'codex' ? 'codex' : 'claude'`
  // negation (that collapsed opencode to Claude). It selects the provider
  // capabilities the ledger uses to correlate committed tool carriers, which
  // decides whether an entry paints. Terminal / unknown kinds are filtered out
  // by ReaderView above; the default only covers pre-kind persisted sessions.
  const provider = isAgentProviderKind(meta?.kind) ? meta.kind : DEFAULT_PROVIDER
  const workspaceRoot = meta?.cwd ?? null
  const reader = workspace.readerMode
  const focusedSessionId = reader && sessionIds.includes(reader.focusedSessionId)
    ? reader.focusedSessionId
    : sessionIds[0] ?? sessionId

  // The same ledger plan the session's Feed paints, with the same arguments
  // TileLeaf passes. WHY a second instance instead of sharing Feed's: Feed's
  // plan lives inside the (hidden but still mounted, #752) TileLeaf and is not
  // in the store; lifting it would be a cross-cutting refactor for one
  // consumer. The cost is real but bounded: while Reader is open, every
  // semantic delta for this one session is walked twice (Feed's hidden
  // instance and this one), each an O(entries) pass. That is still far below
  // what it replaced — an O(n²) entry rescan plus a screen parse on every
  // screen frame.
  //
  // WHY no `sessionStatus === 'running'` gate any more: liveness comes from the
  // ledger (text still growing in the open semantic turn, see
  // ReaderMessage.live). The old gate was what opened the screen-scrape path
  // for every running turn that had no open text block — tool calls, waiting
  // on background agents — which is the whole of #855.
  const ledgerFeedPlan = useLedgerFeedItems(runtime, provider, sessionId, {
    toolUseIndex: runtime.toolUseIndex,
    toolResultIndex: runtime.toolResultIndex,
    version: runtime.toolIndexVersion,
  })
  // Keyed on the items array alone. useLedgerFeedItems memoises its plan on
  // the runtime slices the ledger reads (entries, semantic turns, ghosts,
  // stream phase), so screen frames and other unrelated runtime ticks keep the
  // same array and do not rebuild Reader's message list; a semantic delta or a
  // stream-phase change does.
  const messages = useMemo<ReaderMessage[]>(
    () => readerMessagesFromFeedItems(ledgerFeedPlan.items),
    [ledgerFeedPlan.items],
  )

  // Selection state carries the message list and session it was computed
  // against, so a list change can be reconciled DURING render (React's
  // "adjusting state when a prop changes" pattern) instead of in an effect.
  // WHY not an effect: an effect runs after a commit in which the old id is
  // already missing, and `selectedIndex` below falls back to the newest
  // message for that frame — every live -> committed handoff flashed the live
  // end of the conversation before snapping back. A render-phase update is
  // applied before anything paints.
  //
  // `scrollResetToken` changes only when the reader lands on a DIFFERENT
  // message (see ReaderSelection.moved): user navigation, a session switch,
  // following the agent onto a new page. A message growing, finishing, or being
  // handed to its committed twin keeps the user's scroll position.
  //
  // `stickToBottom` is declared here, ahead of the selection, because it is
  // also the "is the reader following the agent" input to the selection rule:
  // it is set when the reader lands on a growing message, cleared when they
  // scroll up or land on a finished one, and it survives the pinned message
  // finishing. Only a following reader is carried onto new pages.
  const [stickToBottom, setStickToBottom] = useState(true)
  const [selection, setSelection] = useState<{
    messages: readonly ReaderMessage[]
    sessionId: SessionId
    id: string | null
    scrollResetToken: number
  }>(() => ({
    messages,
    sessionId,
    id: messages[messages.length - 1]?.id ?? null,
    scrollResetToken: 0,
  }))
  const sessionChanged = selection.sessionId !== sessionId
  // WHY the write is skipped only for an identical list, not for an unchanged
  // selection: a render-phase update re-renders immediately, so writing on
  // every new `messages` IDENTITY would never settle if a caller handed Reader
  // an unstable-but-identical list (a test fixture whose getRuntime built a
  // fresh runtime per call hit "Too many re-renders"). But the rule also needs
  // `selection.messages` to be the list the reader last saw: the previous
  // version skipped the write whenever the selection did not change, and a
  // reader who paged back and then watched ten answers arrive was later placed
  // by "distance from the end" in a list ten answers out of date. So every
  // real change is recorded, and only a content-identical list is ignored.
  if (sessionChanged || (selection.messages !== messages && !sameReaderList(selection.messages, messages))) {
    const next = sessionChanged
      // A different session's list has no relation to the old selection.
      ? { id: messages[messages.length - 1]?.id ?? null, moved: true }
      : nextReaderSelection(selection.messages, selection.id, messages, stickToBottom)
    setSelection({
      messages,
      sessionId,
      id: next.id,
      scrollResetToken: next.moved ? selection.scrollResetToken + 1 : selection.scrollResetToken,
    })
  }
  const selectedMessageId = selection.id
  const scrollResetToken = selection.scrollResetToken

  const selectedIndex = useMemo(() => {
    if (messages.length === 0) return -1
    if (!selectedMessageId) return messages.length - 1
    const index = messages.findIndex(message => message.id === selectedMessageId)
    return index >= 0 ? index : messages.length - 1
  }, [messages, selectedMessageId])

  const selectedMessage = selectedIndex >= 0 ? messages[selectedIndex] : null
  const canSelectOlder = selectedIndex > 0
  const canSelectNewer = selectedIndex >= 0 && selectedIndex < messages.length - 1
  const text = selectedMessage?.text ?? null

  // WHY selection is read through refs inside the keydown handler
  // instead of closing over `messages`/`selectedIndex` directly:
  //   messages recomputes on every semantic text delta (the live
  //   block's text grows per frame). Closing over
  //   `selectOlder`/`selectNewer` callbacks in the effect below
  //   would then re-register the document listener on every delta —
  //   not a crash, but a lot of `addEventListener`/`removeEventListener`
  //   churn during streaming. Reading from refs lets the effect
  //   mount-once and still see the latest selection.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  // Explicit navigation is always a move to a different message, so it resets
  // the scroll like any other landing. It also records the list the id was
  // chosen from: the selection rule looks the selected id up in
  // `selection.messages`, which may lag (see above) and might not contain it.
  const selectMessage = useCallback((id: string) => {
    setSelection(current => ({
      ...current,
      messages: messagesRef.current,
      id,
      scrollResetToken: current.scrollResetToken + 1,
    }))
  }, [])
  const selectOlder = useCallback(() => {
    const idx = selectedIndexRef.current
    if (idx <= 0) return
    selectMessage(messagesRef.current[idx - 1]!.id)
  }, [selectMessage])
  const selectNewer = useCallback(() => {
    const idx = selectedIndexRef.current
    const list = messagesRef.current
    if (idx < 0 || idx >= list.length - 1) return
    selectMessage(list[idx + 1]!.id)
  }, [selectMessage])

  // Auto-scroll to bottom while content grows during streaming. Only
  // pin to the bottom if the user hasn't manually scrolled away — same
  // sticky-bottom heuristic as the Feed component but simpler because
  // there's only one growing block, not a list of entries.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const lastScrollTopRef = useRef(0)
  const selectedMessageRef = useRef(selectedMessage)
  selectedMessageRef.current = selectedMessage
  useEffect(() => {
    if (!stickToBottom || !selectedMessage?.live) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }, [selectedMessage?.live, text, stickToBottom])

  // Start a newly landed message from the top — and ONLY a newly landed one.
  // WHY keyed on the token and not on `selectedMessageId` / `live` (what this
  // effect used to key on): with ledger-sourced messages the id changes when a
  // finished message is handed to its committed entry, and `live` flips when a
  // block finishes streaming. Both happen under a reader who is mid-paragraph,
  // and resetting there scrolled them back to the top twice for one message.
  // `stickToBottom` restarts only for a message that is still growing.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = 0
    lastScrollTopRef.current = 0
    setStickToBottom(Boolean(selectedMessageRef.current?.live))
  }, [scrollResetToken])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Reader owns history navigation only while it is the frontmost
      // application surface. A dialog can open above this inline takeover;
      // because both use document-level capture listeners, propagation order
      // cannot protect the dialog from Reader. The mounted interaction-owner
      // marker is the shared synchronous source of truth for that priority.
      if (hasAppInteractionOwner()) return
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        selectOlder()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        selectNewer()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [selectNewer, selectOlder])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    if (!selectedMessage?.live) {
      lastScrollTopRef.current = el.scrollTop
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const scrollingUp = el.scrollTop < lastScrollTopRef.current
    // 32px threshold — lets the user scroll up by a small amount
    // without immediately re-pinning, but also catches "I scrolled
    // to within a few pixels of the bottom and want auto-follow back."
    setStickToBottom(scrollingUp && distanceFromBottom > 0 ? false : distanceFromBottom < 32)
    lastScrollTopRef.current = el.scrollTop
  }

  return (
    <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
      <ReaderHeader
        workspace={workspace}
        sessionIds={sessionIds}
        focusedSessionId={focusedSessionId}
        messageCount={messages.length}
        selectedIndex={selectedIndex}
        canSelectOlder={canSelectOlder}
        canSelectNewer={canSelectNewer}
        onSelectOlder={selectOlder}
        onSelectNewer={selectNewer}
      />
      {text ? (
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="flex-1 min-h-0 min-w-0 overflow-auto"
        >
          {/* Centered narrow column for readability. max-w-3xl keeps line
              length around 80ch which is the usual sweet spot for prose.
              prose-theme is load-bearing: it's the CSS class in styles.css
              that styles h1/h2/p/ul/li/strong/em/inline-code etc. Without
              it, ReactMarkdown still emits the right tags but the browser
              defaults render everything as a flat white paragraph run. */}
          {/* data-quote-scope: declares this subtree as quotable text for
              "Reply to Selection". Stamped on the <article> and not the
              scroller so the reader header (session tabs, pager) stays out
              of scope. `sessionId` — not the grid's focused session — is
              correct here: Reader Mode maintains its own selection via
              setReaderModeSession, and the quote must land in the session
              the user is actually reading. */}
          <article
            data-quote-scope={selectedMessage?.notice ? undefined : sessionId}
            className="
              prose-theme
              mx-auto max-w-3xl px-8 py-10
              text-ink text-[15px] leading-[1.7]
            "
          >
            {selectedMessage?.notice ? (
              <UsageLimitNoticeView notice={selectedMessage.notice.notice} sessionRunId={selectedMessage.notice.sessionRunId} actions={usageLimitActions} />
            ) : <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              components={MARKDOWN_COMPONENTS}
            >
              {text}
            </ReactMarkdown>}
          </article>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 flex items-center justify-center text-muted text-[12px] font-code">
          no assistant message yet
        </div>
      )}
      {/* Pane toast, rendered here as well as in TileLeaf.
          WHY: Reader Mode takes over the screen — the workspace and its
          TileLeaf stay mounted but hidden (display:none, #752), so the
          toast TileLeaf normally paints never reaches the screen. That
          left "Reply to Selection" with no feedback whatsoever in Reader
          Mode: the draft is written to a composer the reader does not
          show, the palette closes, and nothing visibly happens. Any
          command that mutates a session from inside the reader has the
          same problem, so this belongs to the reader frame rather than to
          the quoting feature. */}
      <PaneToast message={runtime.paneToast} />
    </CodeRenderContext.Provider>
  )
}

function ReaderHeader({
  workspace,
  sessionIds,
  focusedSessionId,
  messageCount,
  selectedIndex,
  canSelectOlder,
  canSelectNewer,
  onSelectOlder,
  onSelectNewer,
}: {
  workspace: Workspace
  sessionIds: SessionId[]
  focusedSessionId: SessionId
  messageCount: number
  selectedIndex: number
  canSelectOlder: boolean
  canSelectNewer: boolean
  onSelectOlder: () => void
  onSelectNewer: () => void
}) {
  const position = selectedIndex >= 0 ? `${selectedIndex + 1} / ${messageCount}` : '0 / 0'

  return (
    <div className="flex-shrink-0 border-b border-border bg-surface px-2 py-1">
      <div className="flex items-center gap-2">
        <span className="px-2 text-[10px] uppercase tracking-wider text-muted select-none">
          Reader
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onSelectOlder}
            disabled={!canSelectOlder}
            className={`rounded-control px-2 py-1 text-[11px] font-code border ${
              canSelectOlder
                ? 'bg-canvas text-ink-dim border-border hover:border-border-hi hover:text-ink'
                : 'bg-canvas text-muted border-border opacity-50 cursor-default'
            }`}
            aria-label="Show older assistant message"
          >
            ↑ Older
          </button>
          <button
            type="button"
            onClick={onSelectNewer}
            disabled={!canSelectNewer}
            className={`rounded-control px-2 py-1 text-[11px] font-code border ${
              canSelectNewer
                ? 'bg-canvas text-ink-dim border-border hover:border-border-hi hover:text-ink'
                : 'bg-canvas text-muted border-border opacity-50 cursor-default'
            }`}
            aria-label="Show newer assistant message"
          >
            ↓ Newer
          </button>
          <span className="px-2 text-[10px] font-code uppercase tracking-wider text-muted select-none">
            {position}
          </span>
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex items-center gap-1">
            {sessionIds.map(sessionId => {
              const meta = workspace.state.sessions[sessionId]
              const label = meta?.title || shortLabel(meta?.cwd ?? sessionId)
              const active = sessionId === focusedSessionId
              return (
                <button
                  key={sessionId}
                  type="button"
                  onClick={() => workspace.setReaderModeSession(sessionId)}
                  className={`rounded-control px-2 py-1 text-[11px] font-code border whitespace-nowrap ${
                    active
                      ? 'bg-accent text-accent-fg border-accent'
                      : 'bg-canvas text-ink-dim border-border hover:border-border-hi hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function shortLabel(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}
