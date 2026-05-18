import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/ui/Feed'
import { SafeInlineCode } from '@renderer/features/rendered-content/SafeInlineCode'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { extractAssistantInProgress } from '@shared/parsers/extractAssistant'
import { assistantUuidsWithText, extractAssistantByUuid } from '@renderer/lib/copyAssistant'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { dispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, Workspace } from '@renderer/workspace/workspaceStore'

// ReaderView — single-message read mode for a focused session.
//
// Renders ONLY the most recent assistant text (markdown, no tool
// chrome, no composer, no streaming card scaffolding). Live-updates
// while the agent is still typing by switching to the streaming
// extractor; falls back to the JSONL-derived final text otherwise.
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

type ReaderAssistantMessage = {
  id: string
  text: string
  live: boolean
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
    .filter(sessionId => workspace.state.sessions[sessionId]?.kind !== 'terminal')
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
  const runtime = workspace.getRuntime(sessionId)
  const meta = workspace.state.sessions[sessionId]
  const provider = (meta?.kind === 'codex') ? 'codex' : 'claude'
  const workspaceRoot = meta?.cwd ?? null
  const reader = workspace.readerMode
  const focusedSessionId = reader && sessionIds.includes(reader.focusedSessionId)
    ? reader.focusedSessionId
    : sessionIds[0] ?? sessionId

  // Semantic-channel live text for this session. Preferred over the
  // screen extractor: when proxy is on this is decrypted Anthropic
  // text and arrives as markdown-ready prose; when proxy is off the
  // channel STILL fires (source='screen'), so we get screen text
  // without calling the extractor directly. Returns null when no
  // turn is currently streaming.
  const semanticLive = runtime.semantic.currentTurn
  const hasLiveActivity = runtime.sessionStatus === 'running'

  const messages = useMemo<ReaderAssistantMessage[]>(() => {
    const historical = assistantUuidsWithText(runtime.entries)
      .map(uuid => {
        const text = extractAssistantByUuid(runtime.entries, uuid)
        if (!text) return null
        return { id: uuid, text, live: false }
      })
      .filter((message): message is ReaderAssistantMessage => message !== null)

    if (hasLiveActivity) {
      // Prefer the semantic channel; fall back to the direct screen
      // extractor when no semantic event has arrived yet. The screen
      // fallback catches the edge case where a session was spawned
      // through an older code path that doesn't emit semantic events
      // yet — shouldn't happen in production but keeps the reader
      // from going blank during migrations.
      const semanticText = semanticLive?.text?.trim() ?? ''
      const live = semanticText
        || (runtime.recentScreen
          ? extractAssistantInProgress(runtime.recentScreen, provider)?.trim() ?? ''
          : '')
      if (live) {
        const newest = historical[historical.length - 1]
        if (!newest || newest.text !== live) {
          historical.push({ id: '__live__', text: live, live: true })
        }
      }
    }

    return historical
  }, [
    hasLiveActivity,
    runtime.entries,
    runtime.recentScreen,
    semanticLive?.text,
    provider,
  ])

  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const selectedMessageIdRef = useRef<string | null>(null)

  useEffect(() => {
    selectedMessageIdRef.current = selectedMessageId
  }, [selectedMessageId])

  useEffect(() => {
    setSelectedMessageId(messages[messages.length - 1]?.id ?? null)
  }, [sessionId])

  useEffect(() => {
    const previous = selectedMessageIdRef.current
    if (messages.length === 0) {
      setSelectedMessageId(null)
      return
    }
    if (!previous) {
      setSelectedMessageId(messages[messages.length - 1]!.id)
      return
    }
    if (messages.some(message => message.id === previous)) return
    // Whatever we were pointing at (a real uuid that's gone, or the
    // transient '__live__' sentinel whose text was just archived
    // into a historical entry) — snap to the newest message. These
    // two cases used to be split, but they both land here.
    setSelectedMessageId(messages[messages.length - 1]!.id)
  }, [messages])

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
  //   messages recomputes on every semantic text delta (a new
  //   `__live__` entry is pushed per frame). Closing over
  //   `selectOlder`/`selectNewer` callbacks in the effect below
  //   would then re-register the document listener on every delta —
  //   not a crash, but a lot of `addEventListener`/`removeEventListener`
  //   churn during streaming. Reading from refs lets the effect
  //   mount-once and still see the latest selection.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex

  const selectOlder = useCallback(() => {
    const idx = selectedIndexRef.current
    if (idx <= 0) return
    setSelectedMessageId(messagesRef.current[idx - 1]!.id)
  }, [])
  const selectNewer = useCallback(() => {
    const idx = selectedIndexRef.current
    const list = messagesRef.current
    if (idx < 0 || idx >= list.length - 1) return
    setSelectedMessageId(list[idx + 1]!.id)
  }, [])

  // Auto-scroll to bottom while content grows during streaming. Only
  // pin to the bottom if the user hasn't manually scrolled away — same
  // sticky-bottom heuristic as the Feed component but simpler because
  // there's only one growing block, not a list of entries.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    if (!stickToBottom || !selectedMessage?.live) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }, [selectedMessage?.live, text, stickToBottom])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = 0
    lastScrollTopRef.current = 0
    setStickToBottom(Boolean(selectedMessage?.live))
  }, [selectedMessageId, sessionId, selectedMessage?.live])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  if (!text) {
    return (
      <div className="flex-1 min-h-0 min-w-0 flex items-center justify-center text-muted text-[12px] font-code">
        no assistant message yet
      </div>
    )
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
        <article className="
          prose-theme
          mx-auto max-w-3xl px-8 py-10
          text-ink text-[15px] leading-[1.7]
        ">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {text}
          </ReactMarkdown>
        </article>
      </div>
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
            className={`px-2 py-1 text-[11px] font-code border ${
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
            className={`px-2 py-1 text-[11px] font-code border ${
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
                  className={`px-2 py-1 text-[11px] font-code border whitespace-nowrap ${
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
