import type { ClaudeContentBlock, ClaudeEntry } from 'agent-transcript-parser'

export function sanitizeClaudeEntriesForResume(entries: readonly ClaudeEntry[]): ClaudeEntry[] {
  const resolvedToolUseIds = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isClaudeToolResultBlock(block)) resolvedToolUseIds.add(block.tool_use_id)
    }
  }

  const out: ClaudeEntry[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const message = entry.message
    const content = entry.message?.content
    if (entry.type !== 'assistant' || !message || !Array.isArray(content)) {
      out.push(entry)
      continue
    }

    const cleaned = content.filter(block => {
      if (!isClaudeToolUseBlock(block)) return true
      return resolvedToolUseIds.has(block.id)
    })
    if (cleaned.length === 0) {
      if (index === entries.length - 1) {
        out.push({
          ...entry,
          message: {
            ...message,
            content: [{
              type: 'text',
              text: 'Tool call omitted from this resumed snapshot because its result was not recorded before the transcript was cloned.',
            }],
          },
        })
        continue
      }
      out.push(entry)
      continue
    }
    if (cleaned.length === content.length) {
      out.push(entry)
      continue
    }

    // WHY clone/translation sanitization exists at the provider-switch layer:
    // these helpers write transcripts that are immediately resumed and then
    // receive a new user prompt. A live source transcript can be captured after
    // an assistant tool_use was persisted but before the matching tool_result
    // reached disk. Claude's API rejects that history shape on resume. Dropping
    // only unresolved assistant tool_use blocks preserves completed tool calls,
    // text, thinking, and metadata while making the snapshot safe for the next
    // child turn.
    out.push({
      ...entry,
      message: {
        ...message,
        content: cleaned,
      },
    })
  }
  return out
}

function isClaudeToolUseBlock(
  block: ClaudeContentBlock,
): block is ClaudeContentBlock & { type: 'tool_use'; id: string } {
  return block.type === 'tool_use' && typeof block.id === 'string'
}

function isClaudeToolResultBlock(
  block: ClaudeContentBlock,
): block is ClaudeContentBlock & { type: 'tool_result'; tool_use_id: string } {
  return block.type === 'tool_result' && typeof block.tool_use_id === 'string'
}
