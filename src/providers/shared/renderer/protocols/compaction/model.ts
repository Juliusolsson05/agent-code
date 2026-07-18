import type { CompactSummaryEntry, ContentBlock } from '@shared/types/transcript'
import { boundedTextPage } from '@renderer/lib/text/boundedText'

export type CompactionRenderModel =
  | { kind: 'boundary' }
  | { kind: 'progress'; phase: 'running' | 'done'; label: string }
  | { kind: 'summary'; text: string }

/**
 * Extract only the normalized summary content shared by Claude and Codex.
 * Entry recognition remains provider-owned; this function starts after the
 * adapter has proved that the entry is a durable compaction summary.
 */
export function compactionSummaryText(entry: CompactSummaryEntry): string {
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

export function compactionSummaryPreview(text: string): string {
  const page = boundedTextPage(text, 0, 2_400, 24)
  return page.hasNext
    ? `${page.text.trimEnd()}\n\n[summary truncated]`
    : page.text
}
