import { isCompactSummaryEntry, isConversationEntry } from '@shared/types/transcript'
import type { Entry } from '@shared/types/transcript'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SessionKind } from '@renderer/workspace/types'

export type LatestUserPrompt = {
  text: string
  timestamp: string | null
}

function isMetaEntry(entry: Entry): boolean {
  // `isMeta` is a Claude extension on user entries (auto-continue hints).
  // It is checked here rather than in the provider rule because no provider
  // uses it to mean "typed", so it filters uniformly and costs nothing.
  return (entry as { isMeta?: boolean }).isMeta === true
}

// Which user rows are prompts the user actually typed is provider knowledge,
// answered by each provider's `isTypedUserPrompt` capability (see
// registry.renderer.capabilities.ts for why it is a capability, and each
// provider's transcript mapper for its rule).
//
// A plain shell (`terminal`) never reaches here with conversation rows, and a
// kind that predates the field is a legacy Claude session; both take the
// default provider's (Claude's) rule, which is exactly what the old inline
// switch did for them.
function isTypedUserPrompt(entry: Entry, text: string, sessionKind: SessionKind | undefined): boolean {
  const provider = isAgentProviderKind(sessionKind) ? sessionKind : DEFAULT_PROVIDER
  return getRendererProviderCapabilities(provider).isTypedUserPrompt(entry, text)
}

function extractPromptText(entry: Entry): string {
  if (!isConversationEntry(entry)) return ''
  const content = entry.message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const firstText = content.find(
    (block): block is { type: 'text'; text: string } =>
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return firstText?.text.trim() ?? ''
}

export function extractLatestUserPrompts(
  entries: Entry[],
  sessionKind: SessionKind | undefined,
  limit = Number.POSITIVE_INFINITY,
): LatestUserPrompt[] {
  const chronological: LatestUserPrompt[] = []

  for (const entry of entries) {
    if (!isConversationEntry(entry)) continue
    if (entry.message.role !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue
    if (isMetaEntry(entry)) continue

    const text = extractPromptText(entry)
    if (!text) continue
    if (!isTypedUserPrompt(entry, text, sessionKind)) continue
    if (chronological.length > 0 && chronological[chronological.length - 1]?.text === text) {
      continue
    }

    chronological.push({
      text,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    })
  }

  const latestFirst = chronological.reverse()
  return Number.isFinite(limit) ? latestFirst.slice(0, limit) : latestFirst
}

export function extractLatestUserPrompt(
  entries: Entry[],
  sessionKind: SessionKind | undefined,
): LatestUserPrompt | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry) continue
    if (!isConversationEntry(entry)) continue
    if (entry.message.role !== 'user') continue
    if (isCompactSummaryEntry(entry)) continue
    if (isMetaEntry(entry)) continue

    const text = extractPromptText(entry)
    if (!text) continue
    if (!isTypedUserPrompt(entry, text, sessionKind)) continue
    return {
      text,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    }
  }

  return null
}
