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

// remarkPlugins/rehypePlugins are stable references — defining them at
// module scope avoids React re-rendering ReactMarkdown's internal cache
// on every parent render. (react-markdown v10 specifically warns about this.)
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

type Props = {
  entries: Entry[]
  /** If non-null, render a streaming-preview card at the end of the feed. */
  streamingScreen?: string | null
  /** Baseline snapshot captured at submit time. See the comment on
   *  `streamingBaseline` in App.tsx for why. */
  streamingBaseline?: string | null
}

export function Feed({ entries, streamingScreen, streamingBaseline }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [entries.length, streamingScreen])

  if (entries.length === 0 && !streamingScreen) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="font-display italic text-muted text-[15px] tracking-wide">
          waiting for Claude Code to start writing entries…
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[820px] mx-auto px-7 pt-8 pb-6 flex flex-col gap-5">
      {entries.map((e, i) => (
        <EntryRow key={(e as Entry).uuid ?? `i${i}`} entry={e} />
      ))}
      {streamingScreen != null && (
        <StreamingCard screen={streamingScreen} baseline={streamingBaseline ?? null} />
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

  if (typeof content === 'string') {
    return (
      <article className="flex flex-col gap-1.5" data-fresh="1">
        <RoleLabel role={role} />
        <div className="flex flex-col gap-2">
          <TextBubble text={content} role={role} />
        </div>
      </article>
    )
  }

  if (!Array.isArray(content)) return null

  return (
    <article className="flex flex-col gap-1.5" data-fresh="1">
      <RoleLabel role={role} />
      <div className="flex flex-col gap-2">
        {content.map((block, i) => (
          <Block key={i} block={block} role={role} />
        ))}
      </div>
    </article>
  )
}

function RoleLabel({ role }: { role: 'user' | 'assistant' }) {
  // Role label sits above the bubble. Uses the theme's display font
  // (serif in Noir/Paper/Ember, mono in Phosphor) so it reads as part
  // of the typographic system, not a generic UI chrome sans-serif.
  const label = role === 'assistant' ? 'Claude' : 'You'
  const color = role === 'assistant' ? 'text-role-assistant' : 'text-role-user'
  return (
    <div
      className={`
        font-display ${color}
        text-[11px] font-semibold uppercase
        tracking-[0.15em] leading-none
      `}
    >
      {label}
    </div>
  )
}

function Block({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  switch (block.type) {
    case 'text':
      return <TextBubble text={(block as { text: string }).text} role={role} />
    case 'thinking':
      return (
        <details
          className="
            rounded-lg px-4 py-2.5
            bg-surface border border-border
            text-muted text-[12px]
          "
        >
          <summary className="cursor-pointer uppercase tracking-wider text-[10px] font-semibold select-none">
            thinking
          </summary>
          <pre
            className="
              mt-2.5 font-code text-[11.5px] leading-relaxed
              text-ink-dim whitespace-pre-wrap break-words
              max-h-[480px] overflow-auto
            "
          >
            {(block as { thinking: string }).thinking}
          </pre>
        </details>
      )
    case 'tool_use':
      return <ToolUseCard block={block as ToolUseBlock} />
    case 'tool_result':
      return <ToolResultCard block={block as ToolResultBlock} />
    default:
      return (
        <details className="rounded-lg px-4 py-2.5 bg-surface border border-border text-muted text-[12px]">
          <summary className="cursor-pointer uppercase tracking-wider text-[10px] font-semibold select-none">
            {block.type}
          </summary>
          <pre className="mt-2.5 font-code text-[11.5px] whitespace-pre-wrap break-words max-h-[480px] overflow-auto">
            {safeStringify(block)}
          </pre>
        </details>
      )
  }
}

function TextBubble({
  text,
  role,
}: {
  text: string
  role: 'user' | 'assistant'
}) {
  if (!text) return null
  // User bubbles have a left accent bar + tinted background so the eye
  // lands on them as "input". Assistant bubbles are the surface color
  // with a subtle border, letting the content dominate the visual
  // rhythm of the page. This is the readable-long-conversation pattern
  // that works across all four themes because it uses tokens.
  const roleClasses =
    role === 'user'
      ? 'border-l-2 border-role-user bg-surface pl-4 pr-4 py-3'
      : 'bg-transparent px-0 py-1'
  return (
    <div
      className={`
        prose-theme rounded-md
        ${roleClasses}
        text-[14px] leading-[1.65] text-ink
      `}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ToolUseCard({ block }: { block: ToolUseBlock }) {
  return (
    <div
      className="
        rounded-lg px-4 py-3
        bg-tool-bg border border-tool-border
      "
    >
      <div className="flex items-center gap-2.5 text-[11px] font-semibold">
        <ToolIcon />
        <span className="font-code text-ink tracking-tight">{block.name}</span>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer uppercase tracking-wider text-[9px] font-bold text-muted select-none">
          input
        </summary>
        <pre
          className="
            mt-2 px-3 py-2.5
            rounded-md bg-code-bg border border-code-border
            font-code text-[11.5px] leading-relaxed
            whitespace-pre-wrap break-words
            max-h-[320px] overflow-auto
            text-ink-dim
          "
        >
          {safeStringify(block.input)}
        </pre>
      </details>
    </div>
  )
}

function ToolResultCard({ block }: { block: ToolResultBlock }) {
  const text =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map(c => (typeof c === 'string' ? c : c.text ?? safeStringify(c)))
            .join('\n')
        : safeStringify(block.content)
  const isError = block.is_error === true
  return (
    <div
      className={`
        rounded-lg px-4 py-3 border
        ${isError ? 'bg-[color:var(--theme-danger)]/10 border-danger' : 'bg-result-bg border-result-border'}
      `}
    >
      <div className="flex items-center gap-2.5 text-[11px] font-semibold">
        <span className={`${isError ? 'text-danger' : 'text-muted'}`}>
          {isError ? '✕' : '↳'}
        </span>
        <span className="font-code tracking-tight text-ink-dim">result</span>
      </div>
      <pre
        className="
          mt-2 px-3 py-2.5
          rounded-md bg-code-bg border border-code-border
          font-code text-[11.5px] leading-relaxed
          whitespace-pre-wrap break-words
          max-h-[480px] overflow-auto
          text-ink-dim
        "
      >
        {text}
      </pre>
    </div>
  )
}

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
    <div className="text-[10px] font-code text-muted tracking-wide py-0.5 pl-0.5 opacity-70">
      · {label}
    </div>
  )
}

function attachmentLabel(entry: Entry): string {
  const a = (entry as { attachment?: Record<string, unknown> }).attachment ?? {}
  if (a.hookEvent) return `hook: ${(a.hookName as string) ?? (a.hookEvent as string)}`
  if (a.type) return `attachment: ${a.type as string}`
  return 'attachment'
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function StreamingCard({
  screen,
  baseline,
}: {
  screen: string
  baseline: string | null
}) {
  const text = extractAssistantInProgress(screen)
  const isStale = baseline != null && text === baseline
  const display = !text || isStale ? 'thinking…' : text

  return (
    <article className="flex flex-col gap-1.5 opacity-95" data-fresh="1">
      <div className="flex items-center gap-2 font-display text-[11px] font-semibold uppercase tracking-[0.15em] text-role-assistant">
        Claude
        <span className="streaming-dot text-accent text-[10px]">●</span>
      </div>
      <pre
        className="
          font-code text-[12.5px] leading-[1.6]
          bg-surface border border-border
          rounded-lg px-4 py-3
          whitespace-pre
          overflow-x-auto
          max-h-[480px] overflow-y-auto
          text-ink
        "
      >
        {display}
      </pre>
    </article>
  )
}

function ToolIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="text-muted"
      aria-hidden="true"
    >
      <path d="M6.5 2L2 6.5l5 5c.5.5 1.4.5 2 0 .6-.6.6-1.5 0-2L3.5 4" />
      <path d="M11 5l4 4-3 3-4-4" />
    </svg>
  )
}
