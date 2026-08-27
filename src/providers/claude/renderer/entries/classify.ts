import type { ProviderDurableEntryKind } from '@shared/types/providerConfig'
import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
} from '@providers/claude/types/claudeTranscript'
import { decodeClaudeQueuedUserPrompt } from '@providers/claude/renderer/entries/queuedCommand'

/**
 * Claude owns both halves of durable compaction recognition. The ledger calls
 * this classifier for admission and the painter calls the same classifier for
 * presentation, so adding a new Claude carrier cannot make a row selectable
 * but invisible (or paintable but filtered before dispatch). Raw Claude
 * discriminators must not be duplicated in the shared feed to keep that
 * invariant enforceable.
 */
export function classifyClaudeDurableEntry(entry: Entry): ProviderDurableEntryKind | null {
  if (isCompactBoundaryEntry(entry)) return 'compact-boundary'
  if (isCompactSummaryEntry(entry)) return 'compact-summary'
  if (decodeClaudeQueuedUserPrompt(entry)) return 'queued-user-prompt'
  return null
}
