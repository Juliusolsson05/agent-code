import type { ProviderDurableEntryDecision, ProviderDurableEntryInput } from '@shared/types/providerConfig'
import type { CompactSummaryEntry } from '@shared/types/transcript'
import { CompactionView } from '@providers/shared/renderer/protocols/compaction/CompactionView'
import { compactionSummaryText } from '@providers/shared/renderer/protocols/compaction/model'
import { classifyCodexDurableEntry } from '@providers/codex/renderer/entries/classify'

export function renderCodexDurableEntry(
  input: ProviderDurableEntryInput,
): ProviderDurableEntryDecision | undefined {
  // Codex's rollout adapter deliberately emits the same narrow normalized pair
  // as Claude. The active provider is still part of routing: OpenCode cannot
  // accidentally inherit this interpretation merely by emitting similar keys.
  const kind = classifyCodexDurableEntry(input.entry)
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
      // The provider classifier is the runtime proof; TypeScript cannot carry
      // that refinement through the semantic kind string returned by the
      // capability, so state the normalized summary type at the protocol seam.
      node: <CompactionView model={{ kind: 'summary', text: compactionSummaryText(input.entry as CompactSummaryEntry) }} />,
      receipt: { rendererId: 'shared.compaction', protocolId: 'compaction.summary' },
    }
  }
  return undefined
}
