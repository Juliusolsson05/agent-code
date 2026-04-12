// Types for the JSONL transcript entries CC writes to
// ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
//
// Loosely modeled — the on-disk format is a discriminated union with many
// variants. We define just the shapes we render. Use the type guards below
// at runtime; don't trust the discriminator alone.
//
// Lives under src/core/ so it can be imported by main, renderer, AND the
// testbench. Pure types only — no runtime, no Node, no DOM.

export type TextBlock = { type: 'text'; text: string }

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string }>
  is_error?: boolean
  codex?: Record<string, unknown>
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown }

export type Message = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  usage?: Record<string, unknown>
}

export type ConversationEntry = {
  type: 'user' | 'assistant'
  uuid: string
  parentUuid: string | null
  timestamp?: string
  sessionId?: string
  gitBranch?: string
  cwd?: string
  message: Message
  isSidechain?: boolean
}

export type SystemEntry = {
  type: string
  uuid?: string
  [k: string]: unknown
}

export type Entry = ConversationEntry | SystemEntry

export function isConversationEntry(e: Entry): e is ConversationEntry {
  return (
    (e.type === 'user' || e.type === 'assistant') &&
    typeof (e as ConversationEntry).message === 'object' &&
    (e as ConversationEntry).message !== null
  )
}
