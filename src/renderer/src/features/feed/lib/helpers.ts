import {
  isConversationEntry,
  type CompactSummaryEntry,
  type ContentBlock,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'
import { asRecord } from '@shared/lib/asRecord'

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string'
  )
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result' && typeof block.tool_use_id === 'string'
}

// -----------------------------------------------------------------------------
// Feed pure helpers — no React, no state, no side effects.
// -----------------------------------------------------------------------------

/** Build tool_use_id → ToolUseBlock lookup from an entries list. Used
 *  as the fallback when Feed isn't being handed incremental indices
 *  by the workspace store (tests, future surfaces). The index is
 *  cheap to build (single pass) and the resulting Map is handed to
 *  result rows via ToolUseIndexContext. */
export function buildToolUseIndex(entries: Entry[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const e of entries) {
    if (!isConversationEntry(e)) continue
    const content = e.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (isToolUseBlock(b)) {
        map.set(b.id, b)
      }
    }
  }
  return map
}

/**
 * Reverse index: tool_use_id -> the paired tool_result block. Built
 * alongside the forward index but scoped separately so the two maps
 * can be memoized independently. Agents sometimes emit a result
 * without a preceding use (rare — synthetic error paths), those get
 * indexed by their own tool_use_id regardless.
 */
export function buildToolResultIndex(entries: Entry[]): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>()
  for (const e of entries) {
    if (!isConversationEntry(e)) continue
    const content = e.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (isToolResultBlock(b)) {
        map.set(b.tool_use_id, b)
      }
    }
  }
  return map
}

/** Extract the command string from a Bash / exec_command tool_use
 *  block, normalizing across providers. Claude passes the command
 *  as `input.command: string`. Codex passes `input.cmd` which may
 *  be a string OR a pre-split array (for the actual argv form). */
export function extractToolCommand(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (!input) return null
  if (typeof input.command === 'string') return input.command
  if (typeof input.cmd === 'string') return input.cmd
  if (Array.isArray(input.cmd)) return input.cmd.filter(s => typeof s === 'string').join(' ')
  return null
}

/** Flatten a tool_result's content to a plain string — both providers
 *  use either a string or an array of `{type:'text',text:string}`. */
export function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map(item => typeof item === 'string' ? item
                 : typeof item.text === 'string' ? item.text
                 : '')
      .join('\n')
  }
  return ''
}

// Max lines + chars for the inline bash command display. The two
// caps cut different failure modes: very long single-line pipelines
// (the char cap) and multi-line heredocs (the line cap). Matches
// Claude Code's own TUI truncation so the hover preview feels
// consistent across surfaces.
const MAX_COMMAND_DISPLAY_LINES = 2
const MAX_COMMAND_DISPLAY_CHARS = 160

/** Truncate a bash command string for the tool-band header. Applies
 *  the LINES cap first, then the CHARS cap against whatever's left,
 *  and suffixes `…` if anything was dropped. Keeping both caps means
 *  a heredoc collapses to its first two lines AND a one-liner hex
 *  dump is truncated mid-line — both happen often enough in practice
 *  that one cap alone isn't enough. */
export function truncateBashCommand(cmd: string): string {
  const lines = cmd.split('\n')
  const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES
  const needsCharTruncation = cmd.length > MAX_COMMAND_DISPLAY_CHARS
  if (!needsLineTruncation && !needsCharTruncation) return cmd
  let truncated = cmd
  if (needsLineTruncation) {
    truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n')
  }
  if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
    truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS)
  }
  return truncated.trimEnd() + '…'
}

/** Strip the "<digits>\t" prefix from every line so the user sees
 *  the raw source. If a line doesn't match the pattern we keep it
 *  verbatim — defensive against future format tweaks. Used before
 *  we hand Read-tool content to a code renderer that does its own
 *  line numbering; otherwise the markers would double up. */
export function stripLineNumberPrefix(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+\t/, ''))
    .join('\n')
}

/** Build a stable React key for an Entry + its index. Prefers the
 *  entry's uuid; falls back to a type+index composite so entries
 *  without a uuid (synthetic system rows) still get a unique key. */
export function debugKeyForEntry(entry: Entry, index: number): string {
  const uuid = entry.uuid
  return uuid ?? `${entry.type}:${index}`
}

/** One-line summary for the feed-debug RENDER layer. Prefers the
 *  first text block's content; falls back to the first block's type
 *  name when no text is present (tool_use, image, etc.). */
export function debugLabelForEntry(entry: Entry): string {
  if (isConversationEntry(entry)) {
    const message = entry.message
    const content = Array.isArray(message.content) ? message.content : []
    const first = asRecord(content[0])
    if (first?.type === 'text' && typeof first.text === 'string') {
      return `${entry.type}: ${first.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`
    }
    if (typeof first?.type === 'string') {
      return `${entry.type}: ${String(first.type)}`
    }
  }
  return entry.type
}

/** Count ``` fence markers in a string. Used to decide whether the
 *  streaming text currently has an odd number of fences (i.e. is
 *  mid-fence and should split into prose + code halves). */
export function countFenceMarkers(text: string): number {
  const matches = text.match(/```/g)
  return matches ? matches.length : 0
}

/** Split streaming text at the LAST ``` marker when the total count
 *  is odd (i.e. the fence hasn't closed yet). Returns the prose
 *  before the open fence, the partial code content after it, and
 *  the detected language (empty trimmed info-string → null).
 *  Returns null when the text has no fence or an even count
 *  (fully-closed fences go through normal markdown rendering). */
export function splitStreamingCodeFence(text: string): {
  prose: string
  code: string
  language: string | null
} | null {
  const lastFence = text.lastIndexOf('```')
  if (lastFence === -1) return null
  if (countFenceMarkers(text) % 2 === 0) return null

  const openingLine = text.slice(lastFence).split('\n', 1)[0] ?? ''
  const language = openingLine.slice(3).trim() || null
  const code = text.slice(lastFence + openingLine.length)
    .replace(/^\n/, '')
  return {
    prose: text.slice(0, lastFence).trimEnd(),
    code,
    language,
  }
}

// ---------------------------------------------------------------------------
// Image / content block helpers
// ---------------------------------------------------------------------------

/** Produce a data: URL for an image content block. Returns null if
 *  the source is missing or not a base64 payload. Gates on
 *  `source.type === 'base64'` because Anthropic's spec allows both
 *  "base64" (inline data) and "url" shapes; only the base64 shape
 *  has the `data` field we need to embed. mediaType defaults to
 *  'image/png' when the block omits it — that's the most common
 *  case for CC-pasted screenshots. */
export function imageDataUrl(block: ContentBlock): string | null {
  const rec = asRecord(asRecord(block)?.source)
  if (!rec) return null
  if (rec.type !== 'base64') return null
  const mediaType = typeof rec.media_type === 'string' ? rec.media_type : 'image/png'
  const data = typeof rec.data === 'string' ? rec.data : null
  if (!data) return null
  return `data:${mediaType};base64,${data}`
}

/** Extract the human text of a compact-summary entry. Both `text`
 *  and `thinking` blocks contribute — summaries often start with a
 *  thinking block that captures the planning step before the final
 *  text. We join with a blank line between blocks so the two
 *  render as separate paragraphs. */
export function compactSummaryText(entry: CompactSummaryEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const item = block as ContentBlock & { text?: string; thinking?: string }
      if (item.type === 'text' && typeof item.text === 'string') return item.text
      if (item.type === 'thinking' && typeof item.thinking === 'string') return item.thinking
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Truncate the compact-summary body for the inline preview. Two
 *  caps run in order:
 *
 *    1. Line cap (>24): collapse to the first 24 lines. Summaries
 *       can legitimately be long with a tight line budget — a wall
 *       of 200 one-word lines is still >2400 chars but reads as
 *       "too long" long before the char cap fires.
 *    2. Char cap (>2400): truncate the already-line-capped text at
 *       2400 chars, trimming trailing whitespace.
 *
 *  Either truncation appends `\n\n[summary truncated]` as an inline
 *  signal. The full summary is always available on the expanded
 *  compact boundary. */
export function truncateCompactSummary(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 24) {
    return `${lines.slice(0, 24).join('\n')}\n\n[summary truncated]`
  }
  if (text.length > 2400) {
    return `${text.slice(0, 2400).trimEnd()}\n\n[summary truncated]`
  }
  return text
}

/** Label attachment-type entries for the system row. Handles three
 *  shapes:
 *    - hook attachments: `a.hookEvent` drives the label (prefer
 *      `hookName` if present, else the event name).
 *    - typed attachments: `a.type` directly.
 *    - fallback: literal "attachment".
 *
 *  The hook label uses a "hook: <name>" prefix because the system
 *  row is a one-line summary and the event name alone ("PreToolUse")
 *  is opaque — prefixing makes it obvious this came from a hook. */
export function attachmentLabel(entry: Entry): string {
  const a = asRecord(asRecord(entry)?.attachment) ?? {}
  if (a.hookEvent) return `hook: ${String(a.hookName ?? a.hookEvent)}`
  if (a.type) return `attachment: ${String(a.type)}`
  return 'attachment'
}

// ---------------------------------------------------------------------------
// Bash classification for semantic collapsed activity
// ---------------------------------------------------------------------------
//
// WHY anchored to command position, not plain \b:
//   Earlier version used /\b(ls|tree|du)\b/ — that matched inside
//   argv, so `pipx install tree-sitter` classified as "list" and
//   `sudo ls` or `cat foo-tree.txt` matched too. We only want to
//   fire when the name is the *program being invoked*, i.e. at the
//   start of the command or at a pipeline/boundary separator
//   (`;`, `|`, `||`, `&&`), optionally preceded by env-var
//   assignments (`FOO=bar`) or `sudo`.
//
// The regex below captures: (start | separator) (env-var prefix?)
// (sudo?) (one of the names) (followed by end or whitespace).
// `git grep` is handled as its own leading-position pattern.

const COMMAND_START = /(?:^|[;|&]\s*)(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:sudo\s+)?/i

function atCommandPosition(command: string, names: readonly string[]): boolean {
  const alternation = names.map(n => n.replace(/\s+/g, '\\s+')).join('|')
  const re = new RegExp(`${COMMAND_START.source}(?:${alternation})(?=\\s|$)`, 'i')
  return re.test(command)
}

export function looksLikeSearchCommand(command: string): boolean {
  return atCommandPosition(command, ['rg', 'grep', 'find', 'fd', 'ag', 'ack', 'git grep'])
}

export function looksLikeReadCommand(command: string): boolean {
  return atCommandPosition(command, ['cat', 'less', 'more', 'head', 'tail', 'sed', 'awk', 'wc'])
}

export function looksLikeListCommand(command: string): boolean {
  return atCommandPosition(command, ['ls', 'tree', 'du'])
}

export function classifySemanticToolActivity(block: SemanticLiveTurn['blocks'][number]): {
  collapsible: boolean
  category: 'search' | 'read' | 'list' | 'bash' | null
  hint: string | null
} {
  const toolName = block.toolName ?? ''
  const parsed = block.parsedInput ?? {}
  const pathLike =
    typeof parsed.file_path === 'string'
      ? parsed.file_path
      : typeof parsed.path === 'string'
        ? parsed.path
        : null

  // Don't collapse a block whose result has already arrived with
  // real content (or that errored). The collapse was designed for
  // low-signal churn — "2 reads, 1 search" is a useful compaction
  // while the tools are in-flight or while their stub-success
  // results are noise. But once a Read / Grep / Bash block carries
  // real output or an error the user cares about, collapsing it
  // into "worked: 3 reads" silently hides the content. Route
  // finished-with-output blocks through the non-collapsible branch
  // so they render as their own SemanticLiveBlockRow.
  if (block.resultIsError || (block.resultContent && block.resultContent.trim().length > 0)) {
    return { collapsible: false, category: null, hint: null }
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    const pattern =
      typeof parsed.pattern === 'string'
        ? parsed.pattern
        : typeof parsed.glob === 'string'
          ? parsed.glob
          : null
    return {
      collapsible: true,
      category: 'search',
      hint: pattern ? `"${pattern}"` : pathLike,
    }
  }

  if (toolName === 'Read' || toolName === 'FileRead') {
    return {
      collapsible: true,
      category: 'read',
      hint: pathLike,
    }
  }

  if (toolName === 'Bash') {
    const command =
      typeof parsed.command === 'string'
        ? parsed.command.trim()
        : null
    if (!command) return { collapsible: false, category: null, hint: null }
    if (looksLikeListCommand(command)) {
      return { collapsible: true, category: 'list', hint: command }
    }
    if (looksLikeSearchCommand(command)) {
      return { collapsible: true, category: 'search', hint: command }
    }
    if (looksLikeReadCommand(command)) {
      return { collapsible: true, category: 'read', hint: command }
    }
    return { collapsible: true, category: 'bash', hint: command }
  }

  return { collapsible: false, category: null, hint: null }
}
