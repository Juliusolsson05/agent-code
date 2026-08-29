import { memo } from 'react'

import { decodeClaudeQueuedUserPrompt, queuedUserPromptConversationEntry } from '@providers/claude/renderer/entries/queuedCommand'
import { ConversationRow } from '@renderer/features/feed/ui/rows/ConversationRow'
import type { Entry } from '@shared/types/transcript'

export const QueuedUserPromptRow = memo(function QueuedUserPromptRow({
  entry,
}: {
  entry: Entry
}) {
  const command = decodeClaudeQueuedUserPrompt(entry)
  if (!command) return null
  return <ConversationRow entry={queuedUserPromptConversationEntry(command)} />
})
