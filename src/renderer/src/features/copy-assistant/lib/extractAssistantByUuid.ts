// Pure helper — walk a transcript entry list, find the assistant
// entry whose uuid matches, return its concatenated text content.
//
// Mirrors extractLastAssistantText's text concatenation logic but
// parameterized by uuid instead of always-last. Returns null when
// the uuid doesn't match an assistant entry or when the entry has
// no text content (only tool_use blocks, etc.).
//
// Pure: no React, no DOM, no IO.

import type { Entry } from '../../../../../shared/types/transcript'

type AssistantMessage = {
  role?: string
  content?: unknown
}

export function extractAssistantByUuid(
  entries: readonly Entry[],
  uuid: string,
): string | null {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    if ((entry as { uuid?: string }).uuid !== uuid) continue

    const msg = (entry as { message?: AssistantMessage }).message
    if (!msg || msg.role !== 'assistant') return null

    if (typeof msg.content === 'string') {
      const trimmed = msg.content.trim()
      return trimmed || null
    }

    if (Array.isArray(msg.content)) {
      const parts: string[] = []
      for (const block of msg.content) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = b.text.trim()
          if (t) parts.push(t)
        }
      }
      return parts.length > 0 ? parts.join('\n\n') : null
    }

    return null
  }
  return null
}

/**
 * Return the uuids of every assistant entry in the list, in order.
 * Used by the picker to know which uuids to step between on
 * Up/Down. Skips entries that have no text content (defensive —
 * those couldn't be copied anyway).
 */
export function assistantUuidsWithText(
  entries: readonly Entry[],
): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const uuid = (entry as { uuid?: string }).uuid
    if (typeof uuid !== 'string') continue
    if (!extractAssistantByUuid(entries, uuid)) continue
    out.push(uuid)
  }
  return out
}
