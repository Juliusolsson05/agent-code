import { extractLatestUserPrompt } from '@renderer/features/workspace/lib/latestUserPrompts'
import type { Entry } from '@shared/types/transcript'
import type { DispatchAgentRow } from './dispatchSelectors'

// Shared presentation policy for the visible index and external observation.
// Control must not reimplement the title fallback or import the index UI.
const latestPromptTitleCache = new WeakMap<
  Entry[],
  { kind: DispatchAgentRow['kind']; title: string | null }
>()

// Exported for reuse by the Tiled Dispatch mini-list, which renders the
// same prompt-derived title in a more compact row.
export function cachedLatestPromptTitle(
  entries: Entry[],
  kind: DispatchAgentRow['kind'],
): string | null {
  const cached = latestPromptTitleCache.get(entries)
  if (cached && cached.kind === kind) return cached.title

  const title = extractLatestUserPrompt(entries, kind)?.text ?? null
  latestPromptTitleCache.set(entries, { kind, title })
  return title
}

/**
 * Resolve the one-line Dispatch label without erasing the distinction between
 * an explicit title and the existing latest-prompt fallback.
 *
 * WHY `row.title` alone is insufficient: selectors historically fold the cwd
 * basename into that field, and the component then replaces it with the latest
 * prompt. Once users can author a title, applying the same replacement makes
 * Save appear to work in the pane while the primary Dispatch index—the surface
 * built for scanning many agents—continues showing something else. Carrying
 * `agentTitle` separately lets explicit user intent win while preserving the
 * useful automatic prompt label for every untitled agent.
 */
export function dispatchRowTitle(
  row: Pick<DispatchAgentRow, 'agentTitle' | 'kind' | 'title'>,
  entries?: Entry[],
): string {
  if (row.agentTitle) return row.agentTitle
  if (row.kind !== 'terminal' && entries) {
    return cachedLatestPromptTitle(entries, row.kind) ?? row.title
  }
  return row.title
}

