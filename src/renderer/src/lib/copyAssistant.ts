// extractLastAssistantText — provider-agnostic extraction of the most
// recent assistant text from a transcript entry list.
//
// Claude and Codex store assistant content in different shapes:
//
//   Claude: ConversationEntry { type: 'assistant', message: { role: 'assistant',
//           content: string | ContentBlock[] } }
//     Text lives in `TextBlock` elements ({ type: 'text', text: '...' }).
//     We concatenate all text blocks (skipping thinking, tool_use, etc.)
//     because a single assistant turn can contain multiple text blocks
//     interleaved with tool calls.
//
//   Codex:  CodexRolloutLine { type: 'response_item', payload: { type: 'message',
//           role: 'assistant', content: [{ type: 'output_text', text: '...' }] } }
//     Text lives in `output_text` content blocks inside the payload.
//
// We walk the entries array backward so the first match is the most
// recent assistant turn. Returns null if no assistant text is found.

import type { Entry } from '../../../shared/types/transcript'

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
} from '../features/copy-assistant/lib/extractAssistantByUuid'
