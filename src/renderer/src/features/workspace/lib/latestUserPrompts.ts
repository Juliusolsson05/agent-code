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
/**
 * The user's own words, with provider scaffolding removed (#1059).
 *
 * Applied right after the predicate, because everything downstream of this
 * helper SHOWS or REPLAYS the result — pane titles, ⌘↑ composer history, View
 * Prompts and the Rewind picker. Claude's `<pasted_content id="…">` envelope
 * reached all four verbatim, and ⌘↑ then fed it back to Claude, which wrapped
 * the already-wrapped text.
 */
function typedUserPromptText(text: string, sessionKind: SessionKind | undefined): string {
  // Resolved exactly as the predicate above resolves it, so the rule that
  // accepted a row and the rule that renders it can never come from two
  // different providers.
  const provider = isAgentProviderKind(sessionKind) ? sessionKind : DEFAULT_PROVIDER
  return getRendererProviderCapabilities(provider).typedUserPromptText(text)
}

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

    const raw = extractPromptText(entry)
    if (!raw) continue
    if (!isTypedUserPrompt(entry, raw, sessionKind)) continue
    // De-duplicated on the DISPLAYED text: two consecutive pastes of the same
    // prompt carry different envelope ids, so comparing the raw rows called
    // them distinct and ⌘↑ history showed the same prompt twice.
    const text = typedUserPromptText(raw, sessionKind)
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

    const raw = extractPromptText(entry)
    if (!raw) continue
    if (!isTypedUserPrompt(entry, raw, sessionKind)) continue
    return {
      text: typedUserPromptText(raw, sessionKind),
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    }
  }

  return null
}
