// extractLastAssistantText — provider-agnostic extraction of the most
// recent assistant text from a pane's `runtime.entries` (Copy Last Response).
//
// WHY one walk serves every provider: providers store assistant content in
// different raw shapes, but nothing raw reaches `runtime.entries`. Each
// provider's transcript mapper (the registry's createTranscriptEntryMapper)
// folds its lines into the same Claude-shaped ConversationEntry first:
//
//   Claude:   the entry itself: { type: 'assistant', message: { role:
//             'assistant', content: string | ContentBlock[] } }.
//   Codex:    a rollout `response_item` message's `output_text` blocks
//             become `{ type: 'text' }` blocks (codex/renderer/transcript/
//             rollout.ts).
//   OpenCode: a committed `{ info, parts }` message becomes one assistant
//             entry whose text parts are `{ type: 'text' }` blocks
//             (opencode/renderer/transcript/mapper.ts). That includes an
//             OpenCode Terminal pane: its history and live entries come
//             from OpenCode's database through the same mapper, so Copy
//             Last Response works on the raw-TUI pane too.
//
// Text lives in `TextBlock` elements. We concatenate all text blocks of the
// newest assistant entry (skipping thinking, tool_use, etc.) because a single
// assistant turn can interleave several text blocks with tool calls, walking
// backward so the first match is the most recent turn. Returns null if no
// assistant text is found. `kind` is unused for that reason; it stays in the
// signature so a provider whose mapped shape ever diverges has a place to
// branch without touching callers.

import type { Entry } from '@shared/types/transcript'

export function extractLastAssistantText(
  entries: readonly Entry[],
  kind: string,
): string | null {
  void kind
  return extractClaude(entries)
}

function extractClaude(entries: readonly Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const msg = (e as { message?: { role?: string; content?: unknown } }).message
    if (!msg || msg.role !== 'assistant') continue

    if (typeof msg.content === 'string') {
      const trimmed = msg.content.trim()
      if (trimmed) return trimmed
      continue
    }
    if (Array.isArray(msg.content)) {
      // Concatenate all text blocks from this turn — a single
      // assistant message may interleave text with tool_use blocks.
      const parts: string[] = []
      for (const block of msg.content) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = b.text.trim()
          if (t) parts.push(t)
        }
      }
      if (parts.length > 0) return parts.join('\n\n')
    }
  }
  return null
}

export {
  extractAssistantByUuid,
  assistantUuidsWithText,
} from '@renderer/features/copy-assistant/lib/extractAssistantByUuid'
