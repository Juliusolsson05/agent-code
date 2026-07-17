import { asRecord } from '@shared/lib/asRecord'
import type { ToolUseBlock } from '@shared/types/transcript'

export type OpencodeTodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type OpencodeTodoModel = {
  items: readonly OpencodeTodoItem[]
}

/**
 * Admit only the OpenCode checklist grammar captured from a real 1.15.2
 * session. A matching tool name is not ownership: MCP servers and future
 * OpenCode releases can reuse names while changing payloads. Parse the whole
 * visible list or decline to the structured JSON fallback, which preserves
 * every field instead of painting a confident but fabricated checklist.
 */
export function fromOpencodeTodoUse(block: ToolUseBlock): OpencodeTodoModel | null {
  if (block.name !== 'todowrite') return null
  const input = asRecord(block.input)
  if (!input || !Array.isArray(input.todos)) return null

  const items: OpencodeTodoItem[] = []
  for (const raw of input.todos) {
    const item = asRecord(raw)
    if (!item || typeof item.content !== 'string' || !/\S/.test(item.content)) return null
    if (
      item.status !== 'pending' &&
      item.status !== 'in_progress' &&
      item.status !== 'completed'
    ) return null
    items.push({ content: item.content, status: item.status })
  }
  return { items }
}
