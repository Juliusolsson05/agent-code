import type { Conversation, ConversationMatch } from '@shared/conversations/types.js'

// Substring, case-insensitive, first hit wins in this order: label, agent
// name, first prompt, other prompts. A word-boundary hit is not ranked above
// a mid-word one on purpose: rows are ordered by activity, and the user's
// complaint was about finding a session at all, not about ranking two hits
// against each other.
function span(field: ConversationMatch['field'], text: string, queryLower: string): ConversationMatch | null {
  const start = text.toLowerCase().indexOf(queryLower)
  return start < 0 ? null : { field, text, start, end: start + queryLower.length }
}

export function matchConversation(row: Conversation, prompts: readonly string[], queryLower: string): ConversationMatch | null {
  if (!queryLower) return null
  return span('label', row.label, queryLower)
    ?? (row.agentName ? span('name', row.agentName, queryLower) : null)
    ?? (row.firstPrompt ? span('prompt', row.firstPrompt, queryLower) : null)
    ?? prompts.reduce<ConversationMatch | null>((found, p) => found ?? span('prompt', p, queryLower), null)
}
