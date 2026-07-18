import type { ProviderDurableEntryKind } from '@shared/types/providerConfig'
import type { Entry } from '@shared/types/transcript'
import { isCompactBoundaryEntry, isCompactSummaryEntry } from '@shared/types/transcript'

/**
 * Codex's rollout mapper currently normalizes `compacted` into the same narrow
 * boundary/summary entry model used by the visual protocol. The capability is
 * still provider-scoped: without this gate OpenCode (or a future provider)
 * could accidentally acquire Codex semantics merely by emitting similar
 * object keys.
 */
export function classifyCodexDurableEntry(entry: Entry): ProviderDurableEntryKind | null {
  if (isCompactBoundaryEntry(entry)) return 'compact-boundary'
  if (isCompactSummaryEntry(entry)) return 'compact-summary'
  return null
}
