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

type Props = {
  entries: Entry[]
  /**
   * If non-null, render a streaming-preview card at the end of the feed.
   * Pass the current PTY screen buffer text — we strip CC's chrome before
   * displaying. The card disappears the moment a real assistant entry
   * arrives in `entries`.
   */
  streamingScreen?: string | null
}

export function Feed({ entries, streamingScreen }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [entries.length, streamingScreen])

  if (entries.length === 0 && !streamingScreen) {
    return (
      <div className="feed feed-empty">
        <div className="feed-empty-text">
          waiting for Claude Code to start writing entries…
        </div>
      </div>
    )
  }

  return (
    <div className="feed">
      {entries.map((e, i) => (
        <EntryRow key={(e as Entry).uuid ?? `i${i}`} entry={e} />
      ))}
      {streamingScreen != null && <StreamingCard screen={streamingScreen} />}
      <div ref={endRef} />
    </div>
  )
}

function StreamingCard({ screen }: { screen: string }) {
  // Use extractAssistantInProgress (not extractStreamingText) so the
  // streaming card shows ONLY the most recent assistant text — not the
  // welcome banner, the user's prompt, the conversation history, or the
  // bottom chrome. The cleaner output also makes the swap to the
  // structured entry (when the JSONL turn lands) much less jarring
  // because both renderings show the same content.
  const text = extractAssistantInProgress(screen)
  return (
    <article className="entry entry-assistant entry-streaming">
      <div className="role-label role-label-assistant">
        Claude <span className="streaming-dot">●</span>
      </div>
      <div className="entry-body">
        <pre className="block block-streaming">{text || 'thinking…'}</pre>
      </div>
    </article>
  )
}

function EntryRow({ entry }: { entry: Entry }) {
  if (isConversationEntry(entry)) {
    return <ConversationRow entry={entry} />
  }
  // System / metadata entries — render as a compact one-liner.
  return <SystemRow entry={entry} />
}

function ConversationRow({ entry }: { entry: ConversationEntry }) {
  const role = entry.message.role
  const content = entry.message.content

  // String content (older / simpler format)
  if (typeof content === 'string') {
    return (
      <article className={`entry entry-${role}`}>
        <RoleLabel role={role} />
        <div className="entry-body">
          <TextBubble text={content} />
        </div>
      </article>
    )
  }

  if (!Array.isArray(content)) return null

  return (
    <article className={`entry entry-${role}`}>
      <RoleLabel role={role} />
      <div className="entry-body">
        {content.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </article>
  )
}

function RoleLabel({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div className={`role-label role-label-${role}`}>
      {role === 'assistant' ? 'Claude' : 'You'}
    </div>
  )
}

function Block({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <TextBubble text={(block as { text: string }).text} />
    case 'thinking':
      return (
        <details className="block block-thinking">
          <summary>thinking</summary>
          <pre className="block-pre">{(block as { thinking: string }).thinking}</pre>
        </details>
      )
    case 'tool_use':
      return <ToolUseCard block={block as ToolUseBlock} />
    case 'tool_result':
      return <ToolResultCard block={block as ToolResultBlock} />
    default:
      return (
        <details className="block block-unknown">
          <summary>{block.type}</summary>
          <pre className="block-pre">{safeStringify(block)}</pre>
        </details>
      )
  }
}

// remarkPlugins/rehypePlugins are stable references — defining them at
// module scope avoids React re-rendering ReactMarkdown's internal cache on
// every parent render. (react-markdown v10 specifically warns about this.)
const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

function TextBubble({ text }: { text: string }) {
  if (!text) return null
  // ReactMarkdown handles paragraphs, headings, lists, inline code, fenced
  // code blocks, tables, blockquotes, etc. rehype-highlight runs highlight.js
  // over fenced blocks at parse time so syntax colors come from a CSS theme
  // (imported once in main.tsx) — no client-side language detection cost.
  // GFM gives us tables / strikethrough / autolinks which assistants
  // commonly emit.
  return (
    <div className="block block-text">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ToolUseCard({ block }: { block: ToolUseBlock }) {
  return (
    <div className="block block-tool-use">
      <div className="tool-row">
        <span className="tool-icon">⚙</span>
        <span className="tool-name">{block.name}</span>
      </div>
      <details>
        <summary>input</summary>
        <pre className="block-pre">{safeStringify(block.input)}</pre>
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
    <div className={`block block-tool-result ${isError ? 'is-error' : ''}`}>
      <div className="tool-row">
        <span className="tool-icon">{isError ? '✕' : '↳'}</span>
        <span className="tool-name">result</span>
      </div>
      <pre className="block-pre">{text}</pre>
    </div>
  )
}

function SystemRow({ entry }: { entry: Entry }) {
  // Compact one-line representation; show the type discriminator.
  const label =
    entry.type === 'attachment'
      ? attachmentLabel(entry)
      : entry.type === 'permission-mode'
        ? `permission mode: ${(entry as { permissionMode?: string }).permissionMode ?? '?'}`
        : entry.type === 'file-history-snapshot'
          ? 'file history snapshot'
          : entry.type
  return <div className="system-row">{label}</div>
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
