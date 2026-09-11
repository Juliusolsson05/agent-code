// Pure helper — walk a transcript entry list, find the assistant
// entry whose uuid matches, return its concatenated text content.
//
// Mirrors extractLastAssistantText's text concatenation logic but
// parameterized by uuid instead of always-last. Returns null when
// the uuid doesn't match an assistant entry or when the entry has
// no text content (only tool_use blocks, etc.).
//
// Pure: no React, no DOM, no IO.

import type { Entry } from '@shared/types/transcript'

type AssistantMessage = {
  role?: string
  content?: unknown
}

/**
 * The prose of ONE assistant entry: its text blocks joined, or null when it is
 * not an assistant entry or carries no text (a tool_use-only carrier).
 *
 * WHY this is its own export: Reader Mode walks the ledger's feed items, which
 * hand it the entry itself, not a uuid to look up. Before this existed the only
 * way to get an entry's text was `extractAssistantByUuid`, which re-scans the
 * whole list per call; Reader called it once per assistant uuid, so a long
 * session paid O(entries × assistant entries) on every transcript change.
 */
export function assistantEntryText(entry: Entry): string | null {
  if (entry.type !== 'assistant') return null

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

export function extractAssistantByUuid(
  entries: readonly Entry[],
  uuid: string,
): string | null {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    if ((entry as { uuid?: string }).uuid !== uuid) continue
    // The first assistant entry with this uuid is the answer even when it has
    // no text: uuids are unique per entry, so there is nothing later to find.
    return assistantEntryText(entry)
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
    const uuid = (entry as { uuid?: string }).uuid
    if (typeof uuid !== 'string') continue
    // Read the entry in hand rather than re-finding it by uuid: the lookup was
    // a full rescan per assistant entry (quadratic on long sessions) and could
    // only ever return this same entry.
    if (!assistantEntryText(entry)) continue
    out.push(uuid)
  }
  return out
}
