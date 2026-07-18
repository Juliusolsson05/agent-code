import type { ProviderDurableEntryDecision, ProviderDurableEntryInput } from '@shared/types/providerConfig'
import type { CompactSummaryEntry } from '@shared/types/transcript'
import { CompactionView } from '@providers/shared/renderer/protocols/compaction/CompactionView'
import { compactionSummaryText } from '@providers/shared/renderer/protocols/compaction/model'
import { taskNotificationFromEntry } from '@providers/claude/renderer/adapters/taskNotification'
import { TaskNotificationRow } from '@providers/claude/renderer/components/task-notification'
import { classifyClaudeDurableEntry } from '@providers/claude/renderer/entries/classify'

export function renderClaudeDurableEntry(
  input: ProviderDurableEntryInput,
): ProviderDurableEntryDecision | undefined {
  const kind = classifyClaudeDurableEntry(input.entry)
  if (kind === 'compact-boundary') {
    return {
      action: 'render',
      node: <CompactionView model={{ kind: 'boundary' }} />,
      receipt: { rendererId: 'shared.compaction', protocolId: 'compaction.boundary' },
    }
  }
  if (kind === 'compact-summary') {
    return {
      action: 'render',
      // `kind` is proof produced by the provider-local classifier above. The
      // compact protocol intentionally accepts the normalized summary shape,
      // while TypeScript cannot preserve a type guard through a string-valued
      // capability result, so make that proven refinement explicit here.
      node: <CompactionView model={{ kind: 'summary', text: compactionSummaryText(input.entry as CompactSummaryEntry) }} />,
      receipt: { rendererId: 'shared.compaction', protocolId: 'compaction.summary' },
    }
  }
  const notification = taskNotificationFromEntry(input.entry)
  if (notification) {
    // WHY the provider claims the carrier before the shared conversation row:
    // Claude encodes background-task completion as a synthetic user XML entry.
    // It is neither user-authored conversation nor a cross-provider protocol;
    // allowing the shell to recognize the tag is what previously made Codex
    // accidentally consume Claude completion semantics as compatibility data.
    return {
      action: 'render',
      node: <TaskNotificationRow notification={notification} />,
      receipt: { rendererId: 'claude.task-notification' },
    }
  }
  return undefined
}
