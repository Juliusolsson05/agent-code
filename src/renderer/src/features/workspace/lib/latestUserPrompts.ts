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

/** A user prompt the rewind picker can offer as an anchor.
 *
 *  For Claude the anchor is the underlying user entry's `uuid`. For
 *  Codex it's the zero-based index among user-role message entries
 *  in document order — the picker must count in the SAME order the
 *  parser (`rewindCodexRollout`) does, i.e. raw user-role message
 *  entries in the transcript. */
export type AnchoredUserPrompt = LatestUserPrompt & {
  anchor:
    | { kind: 'claude'; uuid: string }
    | { kind: 'codex'; userMessageIndex: number }
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

/**
 * Anchored prompt extraction for the Rewind-to-Prompt picker.
 *
 * Same filter as `extractLatestUserPrompts`, but each returned prompt
 * carries the anchor data the parser layer needs to identify the
 * exact transcript row:
 *   - Claude: the user entry's `uuid`.
 *   - Codex: the zero-based count of user-role message entries seen
 *     in document order BEFORE the selected one. The parser walks
 *     the raw rollout in the same order, so the indexes line up 1:1.
 *
 * WHY a separate function rather than adding the anchor to
 * `extractLatestUserPrompts`: call sites that just want to read
 * prompts (history cycling, view-prompts modal) don't need to pay
 * for anchor bookkeeping, and the anchor type union is wider than
 * what those surfaces want to expose. Keeping the two helpers
 * parallel keeps the rewind anchor type locally scoped.
 */
export function extractAnchoredUserPrompts(
  entries: Entry[],
  sessionKind: SessionKind | undefined,
  limit = Number.POSITIVE_INFINITY,
): AnchoredUserPrompt[] {
  const chronological: AnchoredUserPrompt[] = []
  // Codex document-order counter. Incremented after a prompt is
  // accepted so the numbers match the parser's walk exactly.
  let codexUserIndex = 0

  for (const entry of entries) {
    if (!isConversationEntry(entry)) continue
    if (entry.message.role !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue

    const meta = entry as unknown as {
      permissionMode?: string
      isMeta?: boolean
      uuid?: string
    }
    if (meta.isMeta === true) continue
    if (sessionKind !== 'codex' && meta.permissionMode === undefined) continue

    const text = extractPromptText(entry)
    if (!text) continue
    if (text.startsWith('<')) continue
    if (
      chronological.length > 0 &&
      chronological[chronological.length - 1]?.text === text
    ) {
      continue
    }

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null

    if (sessionKind === 'codex') {
      chronological.push({
        text,
        timestamp,
        anchor: { kind: 'codex', userMessageIndex: codexUserIndex },
      })
      codexUserIndex++
      continue
    }

    if (typeof meta.uuid !== 'string' || meta.uuid.length === 0) continue
    chronological.push({
      text,
      timestamp,
      anchor: { kind: 'claude', uuid: meta.uuid },
    })
  }

  const latestFirst = chronological.reverse()
  return Number.isFinite(limit) ? latestFirst.slice(0, limit) : latestFirst
}
