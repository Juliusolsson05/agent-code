// The Hermes pane's conversation, drawn as a chat (#1482).
//
// Mounted by TileLeaf in place of AgentFeed when the provider is a
// chat-surface provider (CHAT_SURFACE_PROVIDER_KINDS). Everything around it
// stays TileLeaf's: the header, the composer (drafts, queue, slash input,
// dictation), the condition outlet (Hermes' approval/question cards render
// there, directly above the composer, conditions/views.tsx) and the readiness
// line. WHY only the body is swapped: the owner asked for a Telegram-like chat
// in an agent window, and every behaviour of an agent window except how the
// conversation LOOKS already exists and is tested.
//
// Input: the ledger's feed items (TileLeaf's `feedModel.ledgerFeedPlan`), so
// ownership between live and committed rows is decided once, upstream
// (chatProjection.ts header).

import { useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { MARKDOWN_COMPONENTS } from '@renderer/features/feed/ui/markdown/MarkdownComponents'
import { withVisibleControls } from '@shared/text/visibleControls'

import { projectChat, type ChatItem } from './chatProjection'

const REMARK_PLUGINS = [remarkGfm]

// "Near the bottom" for follow-the-conversation: the reader has not scrolled
// up to read older messages. Matches the feed's sticky-bottom slack.
const STICKY_SLACK_PX = 48
// Same trigger distance as Feed's older-history load (Feed.tsx loadOlderNearTop).
const LOAD_OLDER_WITHIN_PX = 160

/**
 * The pane controls TileLeaf hands every agent surface. The chat honours the
 * same ones AgentFeed does, because the commands that drive them (Jump to
 * Latest, Auto-follow, Copy Assistant Message, scrolling up through a long
 * conversation) stay enabled for Hermes panes; round-1 review x1 #2 / x2 #1-2
 * found them silently inert here, older history included.
 */
export type HermesChatControls = {
  hasOlderHistory?: boolean
  onLoadOlderHistory?: () => Promise<void>
  scrollToLatestRequest?: number
  tailMode?: boolean
  pickerSelectedUuid?: string | null
  onUserEngagement?: () => void
}

export function HermesChatFeed({
  sessionId,
  items,
  connectionName,
  hasOlderHistory = false,
  onLoadOlderHistory,
  scrollToLatestRequest = 0,
  tailMode = false,
  pickerSelectedUuid = null,
  onUserEngagement,
}: {
  sessionId: string
  items: readonly FeedRenderItem[]
  /** The Settings connection this pane talks to, for the empty state. */
  connectionName: string | null
} & HermesChatControls) {
  const chat = useMemo(() => projectChat(items), [items])
  const scroller = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  const loadingOlder = useRef(false)

  useEffect(() => {
    const node = scroller.current
    // Follow new messages only while the reader is at the bottom (or the
    // pane is tailing): jumping a reader who scrolled up to an older answer
    // is the one thing a chat must never do.
    if (node && (following.current || tailMode)) node.scrollTop = node.scrollHeight
  }, [chat, tailMode])

  useEffect(() => {
    // Jump to Latest: a monotonic request counter (0 = never asked).
    if (scrollToLatestRequest === 0) return
    const node = scroller.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    following.current = true
  }, [scrollToLatestRequest])

  useEffect(() => {
    if (!pickerSelectedUuid) return
    scroller.current
      ?.querySelector(`[data-entry-uuid="${CSS.escape(pickerSelectedUuid)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [pickerSelectedUuid])

  const loadOlderNearTop = (node: HTMLDivElement) => {
    if (node.scrollTop >= LOAD_OLDER_WITHIN_PX || !hasOlderHistory || tailMode || loadingOlder.current || !onLoadOlderHistory) return
    loadingOlder.current = true
    const beforeHeight = node.scrollHeight
    const beforeTop = node.scrollTop
    void onLoadOlderHistory()
      .then(() => {
        // Prepending rows must not move what the reader is looking at.
        requestAnimationFrame(() => {
          const next = scroller.current
          if (next) next.scrollTop = beforeTop + Math.max(0, next.scrollHeight - beforeHeight)
        })
      })
      .finally(() => {
        loadingOlder.current = false
      })
  }

  return (
    <div
      ref={scroller}
      data-hermes-chat={sessionId}
      // Quotable text for "Reply to Selection", like the feed.
      data-quote-scope={sessionId}
      onScroll={(event) => {
        const node = event.currentTarget
        if (tailMode) {
          node.scrollTop = node.scrollHeight
          following.current = true
          return
        }
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICKY_SLACK_PX
        loadOlderNearTop(node)
      }}
      onPointerDown={onUserEngagement}
      className="h-full min-h-0 overflow-y-auto px-3 py-3"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {hasOlderHistory && (
          <div className="py-1 text-center font-code text-[11px] text-muted" data-chat-role="older">Scroll up for earlier messages</div>
        )}
        {chat.map((item) => (
          <ChatRow key={item.key} item={item} connectionName={connectionName} selected={item.kind === 'assistant' && item.uuid !== undefined && item.uuid === pickerSelectedUuid} />
        ))}
      </div>
    </div>
  )
}

function ChatRow({ item, connectionName, selected }: { item: ChatItem; connectionName: string | null; selected: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end" data-chat-role="user">
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-slab bg-user-bg px-3 py-2 text-[13px] leading-[1.55] text-ink">
            {/* A skill command is persisted as Hermes' expansion of it; show
                what the user actually ran. */}
            {item.skill ? <span className="font-code text-[12px] text-ink-dim">/{item.skill}</span> : withVisibleControls(item.text)}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="flex justify-start" data-chat-role="assistant" data-entry-uuid={item.uuid}>
          <div
            className={`prose-theme max-w-[88%] break-words rounded-slab bg-surface px-3 py-2 text-[13px] leading-[1.6] text-ink ${selected ? 'ring-1 ring-accent' : ''}`}
            aria-current={selected ? 'true' : undefined}
          >
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
              {item.text}
            </ReactMarkdown>
            {item.streaming && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-ink-dim align-middle" />}
          </div>
        </div>
      )
    case 'reasoning':
      return (
        <details className="max-w-[88%] text-[12px] text-ink-dim" data-chat-role="reasoning">
          <summary className="cursor-pointer select-none text-muted">{item.streaming ? 'Thinking…' : 'Reasoning'}</summary>
          <div className="mt-1 whitespace-pre-wrap border-l border-border pl-2">{withVisibleControls(item.text)}</div>
        </details>
      )
    case 'tool':
      return <ToolChip item={item} />
    case 'notice':
      return (
        <div className="whitespace-pre-wrap break-words px-1 font-code text-[11px] text-muted" data-chat-role="notice">
          {withVisibleControls(item.text)}
        </div>
      )
    case 'typing':
      return (
        <div className="flex items-center gap-2 px-1 text-[12px] text-muted" data-chat-role="typing" aria-live="polite">
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim [animation-delay:300ms]" />
          </span>
          {item.label}
        </div>
      )
    case 'empty':
      return (
        <div className="py-10 text-center text-[13px] text-muted" data-chat-role="empty">
          <div className="mb-1 text-[22px]" aria-hidden>☤</div>
          Message your Hermes agent{connectionName ? ` on ${connectionName}` : ''}. Its slash commands (/new, /usage, a /skill) work here too.
        </div>
      )
  }
}

function ToolChip({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const tone = item.status === 'error' ? 'border-danger/60 text-danger' : item.status === 'running' ? 'border-accent/60' : 'border-border'
  return (
    <details className={`max-w-[88%] rounded-chip border ${tone} bg-canvas px-2 py-1 text-[12px]`} data-chat-role="tool" data-tool-status={item.status}>
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-ink-dim">
        <span aria-hidden>{item.status === 'running' ? '◌' : item.status === 'error' ? '✕' : '✓'}</span>
        <span className="font-code text-ink">{item.name}</span>
        {item.label && <span className="min-w-0 truncate font-code text-muted">{withVisibleControls(item.label)}</span>}
      </summary>
      <div className="mt-1 flex flex-col gap-1">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink-dim">
          {JSON.stringify(item.input, null, 2)}
        </pre>
        {item.result !== null && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink">
            {withVisibleControls(item.result)}
          </pre>
        )}
        {item.result === null && item.status !== 'running' && (
          <span className="text-[11px] text-muted">Output is kept on your Hermes server.</span>
        )}
      </div>
    </details>
  )
}
