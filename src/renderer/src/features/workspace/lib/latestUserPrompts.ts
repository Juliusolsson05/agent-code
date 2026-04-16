import {
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
} from '../../../../../shared/types/transcript'
import type { SessionKind } from '../../../tiles/types'

export type LatestUserPrompt = {
  text: string
  timestamp: string | null
}

function extractPromptText(entry: Entry): string {
  if (!isConversationEntry(entry)) return ''
  const content = entry.message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const firstText = content.find(
    (block): block is { type: 'text'; text: string } =>
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return firstText?.text.trim() ?? ''
}

export function extractLatestUserPrompts(
  entries: Entry[],
  sessionKind: SessionKind | undefined,
  limit = Number.POSITIVE_INFINITY,
): LatestUserPrompt[] {
  const chronological: LatestUserPrompt[] = []

  for (const entry of entries) {
    if (!isConversationEntry(entry)) continue
    if (entry.message.role !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue

    const meta = entry as unknown as {
      permissionMode?: string
      isMeta?: boolean
    }
    if (meta.isMeta === true) continue
    if (sessionKind !== 'codex' && meta.permissionMode === undefined) continue

    const text = extractPromptText(entry)
    if (!text) continue
    if (text.startsWith('<')) continue
    if (chronological.length > 0 && chronological[chronological.length - 1]?.text === text) {
      continue
    }

    chronological.push({
      text,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    })
  }

  const latestFirst = chronological.reverse()
  return Number.isFinite(limit) ? latestFirst.slice(0, limit) : latestFirst
}
