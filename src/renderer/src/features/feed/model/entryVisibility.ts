import { isConversationEntry, type ContentBlock, type Entry, type ToolResultBlock, type ToolUseBlock } from '@shared/types/transcript'
import type { CommittedOperationDecisionResolver } from '@renderer/features/feed/context'

/**
 * Decide whether a committed entry can paint before allocating its feed box.
 *
 * WHY this is a render-contract query rather than a React `:empty` trick: a
 * provider can deliberately absorb both sides of an operation. Discovering
 * that only after LazyEntry and the ledger carrier mount leaves zero-height
 * flex children that still receive `gap`. The same cached provider decision
 * used by Block is the authoritative source, so this check cannot drift from
 * the leaf renderer and does not parse an operation twice.
 */
export function committedEntryPaints(input: {
  entry: Entry
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
  resolveOperation: CommittedOperationDecisionResolver
}): boolean {
  if (!isConversationEntry(input.entry) || !Array.isArray(input.entry.message.content)) return true
  const blocks = input.entry.message.content
  // WHY prove obvious paint before resolving any operation: mixed assistant
  // entries commonly contain prose followed by a tool call. The prose already
  // guarantees a feed box, so parsing a potentially large embedded script here
  // would front-load work LazyEntry can defer until the row enters view.
  if (blocks.some(block => obviousNonOperationPaint(block))) return true
  return blocks.some(block => blockPaints(block, input))
}

function obviousNonOperationPaint(block: ContentBlock): boolean {
  if (block.type === 'thinking') {
    return Boolean((block as { thinking?: string }).thinking)
  }
  return block.type !== 'tool_use' && block.type !== 'tool_result'
}

function blockPaints(
  block: ContentBlock,
  input: {
    toolUseIndex: Map<string, ToolUseBlock>
    toolResultIndex: Map<string, ToolResultBlock>
    resolveOperation: CommittedOperationDecisionResolver
  },
): boolean {
  if (block.type === 'thinking') return false
  if (block.type === 'tool_use') {
    const toolUse = block as ToolUseBlock
    const result = input.toolResultIndex.get(toolUse.id) ?? null
    return input.resolveOperation(toolUse, result).toolUse.action !== 'absorb'
  }
  if (block.type === 'tool_result') {
    const result = block as ToolResultBlock
    const toolUse = input.toolUseIndex.get(result.tool_use_id)
    if (!toolUse) return true
    return input.resolveOperation(toolUse, result).toolResult?.action !== 'absorb'
  }
  return true
}
