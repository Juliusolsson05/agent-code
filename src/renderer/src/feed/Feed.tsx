import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

import { extractAssistantInProgress } from '../../../core/parsers/streamingScreen'
import {
  isConversationEntry,
  type ContentBlock,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../../core/types/transcript'

// -----------------------------------------------------------------------------
// Feed — Claude Code TUI-style inline rendering.
//
// Design rules (discussed with the user):
//   1. No bubbles. No cards. No role labels. Messages flow inline like a
//      terminal session — each block gets a single-char marker in the
//      accent color, content wraps with a hanging indent beside it.
//   2. User text → `❯`. Assistant text → `⏺`. Tool results and CC's
//      sub-items → `⎿`. Same markers CC's own TUI uses.
//   3. System entries (permission-mode, file-history-snapshot, hook
//      attachments) are hidden by default and only render when the
//      user opts in via settings.
//   4. Sharp everything — no border-radius, no shadows, no pills. The
//      visual rhythm comes entirely from the marker + hanging indent.
//
// Hanging indent implementation:
//   <div flex gap-3>
//     <span w-3 text-accent>⏺</span>
//     <div flex-1 min-w-0>...content wraps here...</div>
//   </div>
//
// Because the marker column is a fixed width and the content column is
// flex-1, long lines wrap under the content column only — they don't
// creep back under the marker. Standard hanging-indent pattern.
// -----------------------------------------------------------------------------

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

type Props = {
  entries: Entry[]
  streamingScreen?: string | null
  streamingBaseline?: string | null
  showSystemEvents: boolean
}

export function Feed({
  entries,
  streamingScreen,
  streamingBaseline,
  showSystemEvents,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [entries.length, streamingScreen])

  // Visible entries = all entries if system events are shown, otherwise
  // skip attachment / permission-mode / file-history-snapshot.
  const visible = showSystemEvents
    ? entries
    : entries.filter(e => isConversationEntry(e))

  if (visible.length === 0 && !streamingScreen) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted text-[12px]">
          waiting for Claude Code…
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[880px] mx-auto px-8 pt-6 pb-8 flex flex-col gap-4">
      {visible.map((e, i) => (
        <EntryRow key={(e as Entry).uuid ?? `i${i}`} entry={e} />
      ))}
      {streamingScreen != null && (
        <StreamingRow screen={streamingScreen} baseline={streamingBaseline ?? null} />
      )}
      <div ref={endRef} />
    </div>
  )
}

function EntryRow({ entry }: { entry: Entry }) {
  if (isConversationEntry(entry)) {
    return <ConversationRow entry={entry} />
  }
  return <SystemRow entry={entry} />
}

function ConversationRow({ entry }: { entry: ConversationEntry }) {
  const role = entry.message.role
  const content = entry.message.content

  // Simple string content — render as a single marker + text line.
  if (typeof content === 'string') {
    return (
      <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
        <TextProse text={content} />
      </MarkerRow>
    )
  }

  if (!Array.isArray(content)) return null

  // Multi-block content — render each block with its own layout.
  // Role only matters for the FIRST text block (to decide ❯ vs ⏺);
  // tool_use and tool_result blocks carry their own semantics.
  return (
    <div className="flex flex-col gap-2">
      {content.map((block, i) => (
        <Block key={i} block={block} role={role} />
      ))}
    </div>
  )
}

/* ---------- Marker layout primitives ---------- */

/**
 * The core layout: a fixed-width marker column + flex-1 content column
 * that enforces hanging indent. Used by every rendered block.
 */
function MarkerRow({
  marker,
  tone = 'accent',
  children,
  indent = 0,
}: {
  marker: string
  tone?: 'accent' | 'muted' | 'ink'
  children: React.ReactNode
  indent?: number
}) {
  const toneClass =
    tone === 'accent' ? 'text-accent' : tone === 'muted' ? 'text-muted' : 'text-ink-dim'
  return (
    <div
      className="flex gap-2.5"
      style={indent ? { paddingLeft: `${indent * 22}px` } : undefined}
    >
      <span
        className={`${toneClass} flex-shrink-0 w-3 text-[13px] leading-[1.65] select-none`}
        aria-hidden="true"
      >
        {marker}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

/* ---------- Block dispatcher ---------- */

function Block({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  switch (block.type) {
    case 'text':
      return (
        <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
          <TextProse text={(block as { text: string }).text} />
        </MarkerRow>
      )
    case 'thinking':
      // Thinking is usually noise — dim + collapsed behind a disclosure,
      // with the ⏺ marker so it sits in the assistant column rhythm.
      return (
        <MarkerRow marker="⏺" tone="muted">
          <details className="text-muted text-[12px]">
            <summary className="cursor-pointer select-none">thinking</summary>
            <pre className="mt-1.5 whitespace-pre-wrap break-words text-ink-dim text-[11.5px] leading-relaxed opacity-80">
              {(block as { thinking: string }).thinking}
            </pre>
          </details>
        </MarkerRow>
      )
    case 'tool_use':
      return <ToolUseRow block={block as ToolUseBlock} />
    case 'tool_result':
      return <ToolResultRow block={block as ToolResultBlock} />
    default:
      return (
        <MarkerRow marker="⏺" tone="muted">
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.type}
          </div>
        </MarkerRow>
      )
  }
}

/* ---------- Text prose ---------- */

function TextProse({ text }: { text: string }) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* ---------- Tool use: "⏺ Bash  ⎿ $ command" ---------- */

function ToolUseRow({ block }: { block: ToolUseBlock }) {
  // Extract the command / description for Bash-like tools. For tools
  // without a `command` field we fall back to stringified input.
  const input = block.input as Record<string, unknown> | undefined
  const headline = typeof input?.command === 'string'
    ? input.command
    : typeof input?.description === 'string'
      ? input.description
      : typeof input?.path === 'string'
        ? input.path
        : null

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
}

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

function ToolResultRow({ block }: { block: ToolResultBlock }) {
  const text =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map(c => (typeof c === 'string' ? c : c.text ?? ''))
            .join('\n')
        : String(block.content)

  const isError = block.is_error === true
  const trimmed = text.replace(/\s+$/, '')

  return (
    <MarkerRow marker="⎿" tone={isError ? 'muted' : 'muted'}>
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          max-h-[360px] overflow-auto
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {trimmed}
      </pre>
    </MarkerRow>
  )
}

/* ---------- System row (hidden by default; shown when toggled on) ---------- */

function SystemRow({ entry }: { entry: Entry }) {
  const label =
    entry.type === 'attachment'
      ? attachmentLabel(entry)
      : entry.type === 'permission-mode'
        ? `permission mode: ${(entry as { permissionMode?: string }).permissionMode ?? '?'}`
        : entry.type === 'file-history-snapshot'
          ? 'file history snapshot'
          : entry.type
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] text-muted leading-[1.65] opacity-60">
        {label}
      </div>
    </MarkerRow>
  )
}

function attachmentLabel(entry: Entry): string {
  const a = (entry as { attachment?: Record<string, unknown> }).attachment ?? {}
  if (a.hookEvent) return `hook: ${(a.hookName as string) ?? (a.hookEvent as string)}`
  if (a.type) return `attachment: ${a.type as string}`
  return 'attachment'
}

/* ---------- Streaming row (transient preview) ---------- */

function StreamingRow({
  screen,
  baseline,
}: {
  screen: string
  baseline: string | null
}) {
  const text = extractAssistantInProgress(screen)
  const isStale = baseline != null && text === baseline
  const display = !text || isStale ? null : text

  return (
    <MarkerRow marker="⏺">
      {display ? (
        <pre className="font-code text-[13px] leading-[1.6] text-ink whitespace-pre-wrap break-words m-0">
          {display}
        </pre>
      ) : (
        <div className="flex items-center gap-2 text-muted text-[12px]">
          <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
          <span>thinking…</span>
        </div>
      )}
    </MarkerRow>
  )
}
