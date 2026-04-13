import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { extractAssistantInProgress } from '../../../../../shared/parsers/extractAssistant'
import { extractLastAssistantText } from '../../../copyAssistant'
import { collectLeaves } from '../../../tiles/treeOps'
import type { SessionId, Workspace } from '../../../tiles/workspaceStore'

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

type Props = {
  workspace: Workspace
}

export function ReaderView({ workspace }: Props) {
  const reader = workspace.readerMode
  const activeTab = workspace.activeTab
  if (!reader || !activeTab || activeTab.id !== reader.tabId) return null

  const sessionIds = collectLeaves(activeTab.root)
  if (sessionIds.length === 0) return null

  const focusedSessionId = sessionIds.includes(reader.focusedSessionId)
    ? reader.focusedSessionId
    : sessionIds[0]

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col bg-canvas">
      <ReaderHeader
        workspace={workspace}
        sessionIds={sessionIds}
        focusedSessionId={focusedSessionId}
      />
      <ReaderBody workspace={workspace} sessionId={focusedSessionId} />
    </div>
  )
}

function ReaderHeader({
  workspace,
  sessionIds,
  focusedSessionId,
}: {
  workspace: Workspace
  sessionIds: SessionId[]
  focusedSessionId: SessionId
}) {
  return (
    <div className="flex-shrink-0 border-b border-border bg-surface px-2 py-1">
      <div className="flex items-center gap-1 overflow-x-auto">
        <span className="px-2 text-[10px] uppercase tracking-wider text-muted select-none">
          Reader
        </span>
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
  )
}

function ReaderBody({
  workspace,
  sessionId,
}: {
  workspace: Workspace
  sessionId: SessionId
}) {
  const runtime = workspace.getRuntime(sessionId)
  const meta = workspace.state.sessions[sessionId]
  const provider = (meta?.kind === 'codex') ? 'codex' : 'claude'

  // Live text resolver.
  //
  //   - While the assistant is actively typing (`awaitingAssistant`)
  //     and the streaming extractor returns something, show that —
  //     it updates ~60Hz and matches what the user sees in the feed.
  //   - Otherwise, show the most recent COMPLETED assistant message
  //     from the JSONL-backed entries list. This is the fallback for
  //     idle sessions and the source-of-truth once the turn finishes.
  //
  // Computing both each render is cheap; the bigger render cost is
  // ReactMarkdown, so we memo the chosen text and only re-parse when
  // it actually changes.
  const text = useMemo<string | null>(() => {
    if (runtime.awaitingAssistant && runtime.recentScreen) {
      const live = extractAssistantInProgress(runtime.recentScreen, provider)
      if (live && live.trim()) return live
    }
    return extractLastAssistantText(runtime.entries, provider)
  }, [runtime.awaitingAssistant, runtime.recentScreen, runtime.entries, provider])

  // Auto-scroll to bottom while content grows during streaming. Only
  // pin to the bottom if the user hasn't manually scrolled away — same
  // sticky-bottom heuristic as the Feed component but simpler because
  // there's only one growing block, not a list of entries.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  useEffect(() => {
    if (!stickToBottom) return
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [text, stickToBottom])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 32px threshold — lets the user scroll up by a small amount
    // without immediately re-pinning, but also catches "I scrolled
    // to within a few pixels of the bottom and want auto-follow back."
    setStickToBottom(distanceFromBottom < 32)
  }

  if (!text) {
    return (
      <div className="flex-1 min-h-0 min-w-0 flex items-center justify-center text-muted text-[12px] font-code">
        no assistant message yet
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="flex-1 min-h-0 min-w-0 overflow-auto"
    >
      {/* Centered narrow column for readability. max-w-3xl keeps line
          length around 80ch which is the usual sweet spot for prose. */}
      <article className="
        mx-auto max-w-3xl px-8 py-10
        text-ink text-[15px] leading-[1.7]
      ">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
      </article>
    </div>
  )
}

function shortLabel(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}
