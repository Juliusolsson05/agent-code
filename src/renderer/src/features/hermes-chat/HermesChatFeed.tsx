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

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { TextProse } from '@renderer/features/feed/ui/markdown'
import { withVisibleControls } from '@shared/text/visibleControls'

import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'

import { formatToolResult, groupActivity, projectChat, splitReasoning, stabilizeChat, summarizeActivity, type ChatItem, type ChatRowItem, type ChatStep } from './chatProjection'

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

// WHY memo (the owner, 2026-10-14: "the Hermes composer is painstakingly
// slow"): the composer's draft lives in the session runtime, so EVERY
// keystroke re-renders TileLeaf, and TileLeaf re-rendered this whole chat
// with it. Every prop here is stable across a keystroke (items is memoized
// by the ledger, the callbacks are useCallback in TileLeaf, the rest are
// primitives), so memo turns a keystroke into zero work for the
// conversation. HermesChatFeed.typing.renderer.test.tsx counts it: before
// this, 5 keystrokes on a 60-turn chat cost 300 markdown parses.
export const HermesChatFeed = memo(function HermesChatFeed({
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
  // Spotlight (and editor fullscreen, Reader, Settings) keep the lane's copy
  // of this pane mounted under display:none while a second live copy shows
  // (MainSurface + RetainedWorkspaceSurface, #752). The hidden copy must do
  // NOTHING per token: it keeps the last items it showed and catches up once,
  // when it is revealed. AgentFeed has the same guard (Feed.tsx
  // workspaceVisible). Without it every streamed token rendered the whole
  // conversation twice in Spotlight (owner report, #1499).
  const visible = useAgentTerminalOwnerVisible()
  const shownItems = useRef(items)
  if (visible) shownItems.current = items
  const source = shownItems.current
  const previousChat = useRef<ChatItem[] | null>(null)
  const previousRows = useRef<ChatRowItem[] | null>(null)
  const chat = useMemo(() => {
    const next = stabilizeChat(previousChat.current, projectChat(source))
    previousChat.current = next
    const rows = groupActivity(next, previousRows.current)
    previousRows.current = rows
    return rows
  }, [source])
  const scroller = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  const loadingOlder = useRef(false)
  const touchStartY = useRef<number | null>(null)

  useEffect(() => {
    const node = scroller.current
    // Follow new messages only while the reader is at the bottom (or the
    // pane is tailing): jumping a reader who scrolled up to an older answer
    // is the one thing a chat must never do.
    // Hidden under display:none, scrollHeight is 0 and a pin is meaningless;
    // `visible` in the deps re-pins on reveal, so a pane that grew while
    // Spotlight was open comes back at the bottom (it used to stay at the top).
    if (!visible) return
    if (node && (following.current || tailMode)) node.scrollTop = node.scrollHeight
  }, [chat, tailMode, visible])

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
      // At scrollTop 0 an upward wheel or a downward finger drag moves
      // nothing, so no scroll event fires; after a failed page ("Scroll up
      // again to retry") or a page that added no height, paging would be
      // stuck. Same rule as Feed (#1413), round-2 review x1 #3.
      onWheel={(event) => {
        if (event.deltaY < 0 && event.currentTarget.scrollTop <= 0) loadOlderNearTop(event.currentTarget)
      }}
      onTouchStart={(event) => {
        touchStartY.current = event.touches[0]?.clientY ?? null
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY
        if (touchStartY.current === null || y === undefined) return
        if (y > touchStartY.current && event.currentTarget.scrollTop <= 0) {
          touchStartY.current = null
          loadOlderNearTop(event.currentTarget)
        }
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
})

// Memoized as well: while a reply streams, `items` changes on every token
// and projectChat rebuilds the list, but a row whose content did not change
// renders the same; TextProse below memoizes the expensive part on the text.
const ChatRow = memo(function ChatRow({ item, connectionName, selected }: { item: ChatRowItem; connectionName: string | null; selected: boolean }) {
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} skill={item.skill} />
    case 'assistant':
      return (
        <div className="flex justify-start" data-chat-role="assistant" data-entry-uuid={item.uuid}>
          {/* Replies are plain text on the pane, NOT a filled bubble (owner,
              2026-10-14): in the dark themes the old `bg-surface` bubble was
              nearly the same grey as the user's `bg-user-bg`, so prompts and
              answers read as one wall of boxes. Only the user's prompt is
              tinted, which is how the coding feed beside it reads too. The
              picker selection still draws its ring around the reply. */}
          <div
            className={`min-w-0 max-w-full break-words rounded-slab px-1 py-1 text-[13px] leading-[1.6] text-ink ${selected ? 'ring-1 ring-accent' : ''}`}
            aria-current={selected ? 'true' : undefined}
          >
            {/* The feed's own prose renderer: memoized on the text string (a
                bubble that did not change is never re-parsed, even while
                another one streams) and bounded (an oversized reply becomes
                paged plain text instead of an unbounded synchronous parse,
                the fat-freeze lesson in Prose.tsx). The committed plugin set
                for both live and final text: Hermes streams real markdown,
                not a screen buffer, so StreamingProse's remark-breaks would
                change how a finished reply renders mid-stream. */}
            <TextProse text={item.text} />
            {item.streaming && <span aria-hidden className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-ink-dim align-middle" />}
          </div>
        </div>
      )
    case 'activity':
      return <ActivityRow steps={item.steps} />
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
})

// A prompt longer than this folds to LONG_PROMPT_LINES lines behind "Show
// more". WHY (the owner's real conversation, debug bundle 2026-10-14T16-26-49):
// they pasted a whole Hermes setup guide as one prompt, and the bubble filled
// more than a screen, pushing the reply out of view. A chat reader wants the
// question at a glance and the answer below it; the full text is one click
// away. Measured in characters as well as lines because a pasted paragraph is
// often a single very long line.
const LONG_PROMPT_LINES = 8
const LONG_PROMPT_CHARS = 700

function UserBubble({ text, skill }: { text: string; skill: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const long = skill === null && (text.length > LONG_PROMPT_CHARS || text.split('\n').length > LONG_PROMPT_LINES)
  return (
    <div className="flex justify-end" data-chat-role="user">
      <div className="flex max-w-[80%] flex-col items-end gap-1 rounded-slab bg-user-bg px-3 py-2">
        <div
          className={`w-full whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-ink ${long && !expanded ? 'line-clamp-8' : ''}`}
          data-prompt-folded={long && !expanded ? 'true' : undefined}
        >
          {/* A skill command is persisted as Hermes' expansion of it; show
              what the user actually ran. */}
          {skill ? <span className="font-code text-[12px] text-ink-dim">/{skill}</span> : withVisibleControls(text)}
        </div>
        {long && (
          <button type="button" className="font-code text-[11px] text-muted hover:text-ink" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}

function ReasoningRow({ item }: { item: Extract<ChatItem, { kind: 'reasoning' }> }) {
  const { headings, prose } = useMemo(() => splitReasoning(item.text), [item.text])
  return (
    <div className="flex min-w-0 flex-col gap-1" data-chat-role="reasoning">
      <LazyDetails
        className="text-[12px] text-ink-dim"
        data-chat-role="reasoning-detail"
        summary={
          <span className="min-w-0 truncate text-muted">
            {item.streaming ? 'Thinking…' : headings.length > 0 ? headings[headings.length - 1] : 'Reasoning'}
          </span>
        }
      >
        {/* Markdown, like every other bubble: 81 of 136 reasoning rows in
            the owner's bundle showed raw `**` as plain text. */}
        <div className="mt-1 border-l border-border pl-2"><TextProse text={item.text} /></div>
      </LazyDetails>
      {prose && (
        // The agent's progress update, visible (splitReasoning says why).
        <div className="text-[12px] italic leading-[1.55] text-ink-dim" data-chat-role="progress">
          <TextProse text={prose} />
        </div>
      )}
    </div>
  )
}

/**
 * A <details> whose body is only MOUNTED while it is open.
 *
 * WHY (the owner's debug bundle 2026-10-14T16-26-49, #1499): a real Hermes
 * conversation had 206 tool chips and 136 reasoning blocks; their bodies
 * (181 KB of tool input JSON, 213 KB of reasoning) stayed in the DOM inside
 * CLOSED <details>, 3,917 elements in total, and every Hermes send froze the
 * window for 2–5.7 s (performance monitor). A closed body is never seen, so
 * it is not built; opening one builds just that one.
 */
function LazyDetails({ summary, children, className, closedClassName = '', openClassName = '', ...rest }: { summary: ReactNode; children: ReactNode; className: string; closedClassName?: string; openClassName?: string; 'data-chat-role': string; 'data-tool-status'?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className={[className, open ? openClassName : closedClassName].filter(Boolean).join(' ')} {...rest} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer select-none items-center gap-1.5">{summary}</summary>
      {open && children}
    </details>
  )
}

/**
 * One run of the agent's work, folded to a single quiet line (groupActivity
 * says why). No border, no pill: it is metadata between two messages, and it
 * must read as quieter than both. Opening it lists every step, each with its
 * own lazily-built detail, so the 2,000-element closed-body problem (#1499)
 * stays solved at both levels.
 */
function ActivityRow({ steps }: { steps: ChatStep[] }) {
  const { status, tools, headline, thoughts, progress } = useMemo(() => summarizeActivity(steps), [steps])
  const counts = [tools, thoughts > 0 ? `${thoughts} thought${thoughts === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
  return (
    <div className="flex min-w-0 flex-col gap-1" data-chat-role="activity" data-activity-status={status}>
      <LazyDetails
        className="min-w-0 text-[12px] text-muted"
        openClassName="rounded-slab border border-border px-2 py-1.5"
        data-chat-role="activity-detail"
        summary={
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={status === 'error' ? 'text-danger' : status === 'running' ? 'animate-pulse text-accent' : ''}>
              {status === 'running' ? '◌' : status === 'error' ? '✕' : '✓'}
            </span>
            <span className="shrink-0 font-code text-ink-dim">{counts}</span>
            {headline && <span className="min-w-0 truncate">{withVisibleControls(headline)}</span>}
          </span>
        }
      >
        <div className="mt-1.5 flex flex-col gap-1">
          {steps.map((step) => (step.kind === 'tool' ? <ToolLine key={step.key} item={step} /> : <ReasoningRow key={step.key} item={step} />))}
        </div>
      </LazyDetails>
      {progress && (
        // The agent's latest progress note, kept visible (summarizeActivity).
        <div className="pl-[18px] text-[12px] italic leading-[1.55] text-ink-dim" data-chat-role="progress">
          <TextProse text={progress} />
        </div>
      )}
    </div>
  )
}

function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  return (
    <LazyDetails
      className="min-w-0 text-[12px]"
      data-chat-role="tool"
      data-tool-status={item.status}
      summary={
        <span className="flex min-w-0 items-center gap-1.5 text-ink-dim">
          <span aria-hidden className={item.status === 'error' ? 'text-danger' : ''}>{item.status === 'running' ? '◌' : item.status === 'error' ? '✕' : '✓'}</span>
          <span className="font-code text-ink">{item.name}</span>
          {item.label && <span className="min-w-0 truncate font-code text-muted">{withVisibleControls(item.label)}</span>}
        </span>
      }
    >
      <ToolBody item={item} />
    </LazyDetails>
  )
}

function ToolBody({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const input = useMemo(() => JSON.stringify(item.input, null, 2), [item.input])
  const result = useMemo(() => (item.result === null ? null : withVisibleControls(formatToolResult(item.result))), [item.result])
  return (
    <div className="mt-1 flex flex-col gap-1">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink-dim">
        {input}
      </pre>
      {result !== null && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink">
          {result}
        </pre>
      )}
      {item.result === null && item.status !== 'running' && (
        <span className="text-[11px] text-muted">Output is kept on your Hermes server.</span>
      )}
    </div>
  )
}
