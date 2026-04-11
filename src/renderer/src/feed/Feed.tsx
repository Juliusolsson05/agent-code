import { memo, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
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

// Plugin sets are defined at module scope because react-markdown v10 caches
// parse results keyed on plugin identity — passing fresh array literals on
// every parent render busts the cache and costs real frames.
//
// The two sets differ in ONE plugin:
//
//   COMPLETED_REMARK: just `remark-gfm`. Completed assistant text from the
//   JSONL is real markdown source with proper paragraph breaks, so
//   standard markdown rules apply.
//
//   STREAMING_REMARK: `remark-gfm` + `remark-breaks`. The streaming source
//   is CC's screen buffer — plain text stripped of ANSI. CC's Ink already
//   converted markdown syntax (** _ ` ```) to terminal attributes and
//   discarded the characters by the time it hits our buffer, so there's
//   no real markdown to parse. But single newlines are load-bearing in
//   the streaming text (each line is a genuine line, not a soft wrap),
//   and standard markdown collapses single newlines into soft wraps that
//   flow together as one paragraph. `remark-breaks` turns each hard
//   newline into a <br>, preserving the visual line layout. Without it,
//   a multi-line response like "There are 19 entries:\n  body.txt\n
//   claude-501\n…" would collapse into one blob.
//
// Rendering streaming through react-markdown instead of a raw <pre> also
// makes the typography match completed messages exactly: same font, size,
// line-height, paragraph rhythm. When the JSONL entry lands and the
// structured version takes over, the visual jump is minimal — just
// richer formatting on top of the same base layout.
const COMPLETED_REMARK = [remarkGfm]
const STREAMING_REMARK = [remarkGfm, remarkBreaks]
// rehype-highlight config:
//   detect: true  — when a fence has no language (```…```), lowlight
//                   auto-detects the language. Without this, unlabeled
//                   fences stay plain text. CC models commonly emit
//                   unlabeled fences for shell output and short snippets,
//                   so this is load-bearing for the common case.
//   languages: undefined — use the `common` set (~40 languages). Covers
//                   every mainstream language; the full set would triple
//                   the bundle for marginal benefit.
//
// Plugin instance is frozen at module scope (with the options baked in)
// because react-markdown v10 caches parse results keyed on plugin
// identity — passing [rehypeHighlight, options] at the call site would
// create a fresh options object every render and bust the cache.
const REHYPE_PLUGINS: import('react-markdown').Options['rehypePlugins'] = [
  [rehypeHighlight, { detect: true }],
]

type Props = {
  entries: Entry[]
  /** Plain-text screen snapshot. Used for baseline comparison. */
  streamingScreen?: string | null
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown. Used for the actual streaming card render. */
  streamingScreenMarkdown?: string | null
  streamingBaseline?: string | null
  showSystemEvents: boolean
}

// -----------------------------------------------------------------------------
// Memoization strategy — the whole reason this file is fast enough to type in
// -----------------------------------------------------------------------------
//
// Parsing markdown through unified (remark-parse → remark-gfm → rehype-
// highlight → highlight.js) is EXPENSIVE. A single assistant message with
// a handful of code blocks easily takes 5-15ms per ReactMarkdown call,
// and a scrolled-back feed can contain dozens of them. Without memoization,
// every keystroke in the composer input (which is a sibling component
// living inside the same TileLeaf) triggers a TileLeaf re-render, which
// re-renders <Feed>, which re-parses every single markdown block from
// scratch. That's 100ms+ of blocking work between the browser input event
// and the next paint — the input literally cannot update until the
// markdown finishes, and typing becomes unusable.
//
// The fix is a two-layer memo:
//
//   1. `Feed` itself is memoized. When the parent re-renders for a reason
//      unrelated to feed content (user typing, focus toggle, split resize,
//      picker visibility change), Feed sees the same `entries` reference,
//      same `streamingScreen`, etc., and React.memo's default shallow
//      compare bails the entire subtree out. Zero markdown work happens.
//
//   2. Every row component (`EntryRow`, `ConversationRow`, `TextProse`,
//      `ToolUseRow`, `ToolResultRow`) is individually memoized. Even when
//      Feed DOES need to re-render (new entry lands, streaming frame
//      ticks), existing rows receive the exact same entry/block/text
//      reference they had last time and skip. Only the genuinely new
//      row does parse work. This matters because entries are appended,
//      not replaced — we spread `[...current.entries, newOne]`, so the
//      array reference is fresh but every existing element is stable.
//
// TextProse/StreamingProse are the hottest leaf; memoizing them by the
// `text` string is the single biggest win because ReactMarkdown itself
// has no memo and re-parses on every call.
//
// What is NOT memoized on purpose: the StreamingRow. It WANTS to re-run
// on every screen frame — that's literally the streaming preview. But
// even there, `StreamingProse` is memoed by the extracted text string,
// so identical consecutive frames (which are common — CC re-renders its
// screen buffer without the content changing) are free.

export const Feed = memo(FeedImpl)

function FeedImpl({
  entries,
  streamingScreen,
  streamingScreenMarkdown,
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
        <StreamingRow
          screen={streamingScreen}
          screenMarkdown={streamingScreenMarkdown ?? streamingScreen}
          baseline={streamingBaseline ?? null}
        />
      )}
      <div ref={endRef} />
    </div>
  )
}

// Memoized: entry objects are stable across store updates (we append,
// never mutate), so shallow compare by entry reference skips re-render
// for every row that didn't itself change.
const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  if (isConversationEntry(entry)) {
    return <ConversationRow entry={entry} />
  }
  return <SystemRow entry={entry} />
})

const ConversationRow = memo(function ConversationRow({
  entry,
}: {
  entry: ConversationEntry
}) {
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
})

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

// Memoized: blocks inside an assistant/user message are stable objects —
// the entry never mutates, so block identity is a perfect memo key.
const Block = memo(function Block({
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
})

/* ---------- Text prose ---------- */

// Memoized: `text` is a plain string, so shallow compare is exact
// equality. This is the single biggest win in the file — markdown
// parsing is the expensive part, and by memoing on the text string we
// skip the unified pipeline entirely for every row that didn't change.
const TextProse = memo(function TextProse({ text }: { text: string }) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown remarkPlugins={COMPLETED_REMARK} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * Same visual surface as TextProse, but uses the streaming plugin set
 * (remark-breaks added) so hard newlines from the screen buffer survive
 * as <br> in the rendered output. See the comment on STREAMING_REMARK
 * above for the full reasoning.
 *
 * Memoized by text string too: CC's screen re-renders fire at ~60Hz
 * and the extracted assistant text is usually identical between frames
 * (CC is redrawing chrome, not changing content). Memoing here turns
 * those redundant frames into free ones.
 */
const StreamingProse = memo(function StreamingProse({
  text,
}: {
  text: string
}) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown remarkPlugins={STREAMING_REMARK} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/* ---------- Tool use: "⏺ Bash  ⎿ $ command" ---------- */

const ToolUseRow = memo(function ToolUseRow({ block }: { block: ToolUseBlock }) {
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
})

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

const ToolResultRow = memo(function ToolResultRow({
  block,
}: {
  block: ToolResultBlock
}) {
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
})

/* ---------- System row (hidden by default; shown when toggled on) ---------- */

const SystemRow = memo(function SystemRow({ entry }: { entry: Entry }) {
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
})

function attachmentLabel(entry: Entry): string {
  const a = (entry as { attachment?: Record<string, unknown> }).attachment ?? {}
  if (a.hookEvent) return `hook: ${(a.hookName as string) ?? (a.hookEvent as string)}`
  if (a.type) return `attachment: ${a.type as string}`
  return 'attachment'
}

/* ---------- Streaming row (transient preview) ---------- */

function StreamingRow({
  screen,
  screenMarkdown,
  baseline,
}: {
  screen: string
  screenMarkdown: string
  baseline: string | null
}) {
  // Staleness detection runs on PLAIN text. The parser walks the
  // chrome-stripped plain screen to find the last `⏺` block (which is
  // what we compare against the baseline). We can't use the markdown
  // version for this — the injected `**`/`*` markers shift the
  // characters around and would flip comparison results on every
  // transition. See streamingBaseline in App.tsx.
  const plainExtract = extractAssistantInProgress(screen)
  const isStale = baseline != null && plainExtract === baseline

  // Render uses the MARKDOWN version. Same extraction logic, same
  // chrome strip — but the resulting text carries bold/italic markers
  // reconstructed from cell attributes, so react-markdown can render
  // them as real formatting. This is the whole point of the dual-
  // snapshot approach in ClaudeSession.
  const mdExtract = extractAssistantInProgress(screenMarkdown)
  const show = plainExtract && !isStale

  const display = show
    ? mdExtract
        .split('\n')
        .map(l => l.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
    : ''

  return (
    <MarkerRow marker="⏺">
      {display ? (
        <StreamingProse text={display} />
      ) : (
        <div className="flex items-center gap-2 text-muted text-[12px] py-0.5">
          <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
          <span>thinking…</span>
        </div>
      )}
    </MarkerRow>
  )
}
