import { isCompactSummaryEntry, isConversationEntry } from '@shared/types/transcript'
import type { Entry } from '@shared/types/transcript'
import type { SessionKind } from '@renderer/workspace/types'

export type LatestUserPrompt = {
  text: string
  timestamp: string | null
}

type UserPromptMeta = {
  permissionMode?: string
  isMeta?: boolean
  uuid?: string
}

function userPromptMeta(entry: Entry): UserPromptMeta {
  // These fields are provider-specific extensions on Claude user
  // entries. Keep the cast behind a named helper so the filtering
  // invariant is visible at each call site without repeating the
  // broad "Entry plus loose metadata" assertion three times.
  return entry as Entry & UserPromptMeta
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

    const meta = userPromptMeta(entry)
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

export function extractLatestUserPrompt(
  entries: Entry[],
  sessionKind: SessionKind | undefined,
): LatestUserPrompt | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry) continue
    if (!isConversationEntry(entry)) continue
    if (entry.message.role !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue

    const meta = userPromptMeta(entry)
    if (meta.isMeta === true) continue
    if (sessionKind !== 'codex' && meta.permissionMode === undefined) continue

    const text = extractPromptText(entry)
    if (!text) continue
    if (text.startsWith('<')) continue
    return {
      text,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    }
  }

  return null
}
