import {
  isConversationEntry,
  type CompactSummaryEntry,
  type ContentBlock,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../../../../shared/types/transcript'
import type { SemanticLiveTurn } from '../../../workspace/workspaceState'

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
      if (b.type === 'tool_use') {
        const tu = b as ToolUseBlock
        map.set(tu.id, tu)
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
      if (b.type === 'tool_result') {
        const tr = b as ToolResultBlock
        map.set(tr.tool_use_id, tr)
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
  const input = block.input as Record<string, unknown> | undefined
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
                 : typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text
                 : '')
      .join('\n')
  }
  return ''
}

/** Truncate long bash commands for the tool-band header. We keep the
 *  first line and cut after ~160 chars; the full command is still
 *  available in the expanded view. Matches Claude Code's own
 *  truncation style so the UI feels consistent across surfaces. */
export function truncateBashCommand(cmd: string): string {
  const firstLine = cmd.split('\n', 1)[0] ?? cmd
  if (firstLine.length <= 160) return firstLine
  return firstLine.slice(0, 160) + '…'
}

/** Strip the leading "nnn→" line-number markers Claude emits in Read
 *  tool results. Used before we hand the content to a code renderer
 *  that does its own line numbering — the markers would otherwise
 *  double up. */
export function stripLineNumberPrefix(text: string): string {
  return text.replace(/^\s*\d+→/gm, '')
}

/** Build a stable React key for an Entry + its index. Prefers the
 *  entry's uuid; falls back to a type+index composite so entries
 *  without a uuid (synthetic system rows) still get a unique key. */
export function debugKeyForEntry(entry: Entry, index: number): string {
  const uuid = (entry as Entry).uuid
  return uuid ?? `${entry.type}:${index}`
}

/** One-line summary for the feed-debug RENDER layer. Prefers the
 *  first text block's content; falls back to the first block's type
 *  name when no text is present (tool_use, image, etc.). */
export function debugLabelForEntry(entry: Entry): string {
  if (entry.type === 'user' || entry.type === 'assistant') {
    const message = (entry as ConversationEntry).message
    const content = Array.isArray(message.content) ? message.content : []
    const first = content[0] as Record<string, unknown> | undefined
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
 *  the block isn't an image or its source fields aren't set. */
export function imageDataUrl(block: ContentBlock): string | null {
  if (block.type !== 'image') return null
  const src = (block as unknown as { source?: Record<string, unknown> }).source
  if (!src) return null
  const mediaType = typeof src.media_type === 'string' ? src.media_type : null
  const data = typeof src.data === 'string' ? src.data : null
  if (!mediaType || !data) return null
  return `data:${mediaType};base64,${data}`
}

/** Extract the human text of a compact-summary entry. Both the
 *  conversation-entry shape (content array) and the raw-string shape
 *  (older schema) are supported. */
export function compactSummaryText(entry: CompactSummaryEntry): string {
  const message = entry.message
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map(block => {
        const item = block as Record<string, unknown>
        return item.type === 'text' && typeof item.text === 'string'
          ? (item.text as string)
          : ''
      })
      .join('\n')
      .trim()
  }
  return ''
}

/** Truncate the compact-summary body for the inline preview. */
export function truncateCompactSummary(text: string): string {
  if (text.length <= 400) return text
  return text.slice(0, 400).trimEnd() + '…'
}

/** Label attachment-type entries for the system row (file-history-
 *  snapshot, hook-attachment, etc.). */
export function attachmentLabel(entry: Entry): string {
  const att = (entry as unknown as { attachment?: Record<string, unknown> }).attachment
  if (!att) return 'attachment'
  const kind = typeof att.type === 'string' ? att.type : 'attachment'
  const path =
    typeof att.path === 'string'
      ? att.path
      : typeof att.target === 'string'
        ? att.target
        : null
  return path ? `${kind} · ${path}` : kind
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
