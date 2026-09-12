import type { ReadDepth } from '@control-sdk'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import { isConversationEntry } from '@shared/types/transcript'
import { providerDurableEntryKind } from '@providers/registry.renderer.capabilities'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'

export type ProjectedMessage = {
  id: string; role: 'user' | 'assistant' | 'activity'; text: string; kind: string; source: string; partial: boolean
  timestamp?: string; phase?: string
  attachments?: Array<{ id: string; kind: string; mimeType?: string }>
}

function summary(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value
  if (!value || typeof value !== 'object') return value
  if (depth >= 3) return '[detail available at full depth]'
  if (Array.isArray(value)) return value.slice(0, 4).map(item => summary(item, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 10).map(([key, item]) => [key, summary(item, depth + 1)]))
}

// This is the sole control-read projection consumer of the rendering ledger.
// It does not reconcile committed/live/ghost ownership. Those decisions come
// from the exact adapter, ledger and provider paintability bridge used by Feed.
// Never add a text-prefix deduper or independently append currentTurn.text here:
// that would resurrect the duplicate/missing intermediate-message bug class.
export function createConversationProjection() {
  const adapt = createLedgerInputAdapter()
  const decide = createSessionLedger()
  let previousKeys: unknown[] = []
  let previousMessages: ProjectedMessage[] = []
  return (runtime: RuntimeRenderInput, provider: AgentProviderKind, sessionId: string, depth: ReadDepth): ProjectedMessage[] => {
    const keys = [runtime.entries, runtime.semantic.currentTurn, runtime.semantic.history, runtime.ghosts,
      runtime.streamPhase, runtime.streamPhasePendingToolName, runtime.streamPhasePendingToolUseId, runtime.lastJsonlEntryAt, provider, sessionId, depth]
    if (keys.length === previousKeys.length && keys.every((key, index) => key === previousKeys[index])) return previousMessages
    const ledger = decide(adapt({ provider, sessionId, entries: runtime.entries,
      semanticCurrent: runtime.semantic.currentTurn, semanticHistory: runtime.semantic.history,
      ghosts: runtime.ghosts, streamPhase: runtime.streamPhase, lastJsonlEntryAtMs: runtime.lastJsonlEntryAt }).input)
    const { items, dropped } = ledgerToFeedItems(ledger, providerLedgerFeedContextFromRuntime(runtime, provider).context)
    if (dropped.length) throw new Error(`Canonical feed projection has unresolved payloads: ${dropped.join(', ')}`)
    const candidates = new Map(ledger.rows.map(row => [row.candidate.id.replace(/^(entry|optimistic|ghost):/, ''), row.candidate]))
    const messages: ProjectedMessage[] = []
    const details = depth === 'activity' || depth === 'full'
    for (const item of items) {
      if (item.type === 'absorbed-entry' || item.type === 'empty' || item.type === 'work') continue
      if (item.type === 'entry') {
        const entry = item.entry
        const candidate = candidates.get(entry.uuid ?? '')
        const source = candidate?.owner ?? 'committed'
        const allowed = providerDurableEntryKind(entry, provider) !== 'queued-user-prompt'
          && (candidate?.contentKind === 'user-text' || candidate?.contentKind === 'assistant-text')
        const text = entryTextContent(entry)
        const content = isConversationEntry(entry) && Array.isArray(entry.message.content) ? entry.message.content : []
        const attachments = content.flatMap((block, index) => block.type === 'image' ? [{
          id: `${item.key}:block:${index}`, kind: 'image',
          ...('source' in block && block.source && typeof block.source === 'object' && 'media_type' in block.source
            ? { mimeType: String(block.source.media_type) } : {}),
        }] : [])
        if (allowed && (entry.type === 'user' || entry.type === 'assistant') && (text?.length || attachments.length)) {
          messages.push({ id: item.key, role: entry.type, text: text ?? '', kind: 'message', source,
            partial: source === 'optimistic-submit', ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
            ...(attachments.length ? { attachments } : {}) })
        }
        if (details) {
          if (!allowed) {
            messages.push({ id: item.key, role: 'activity', kind: entry.type, source, partial: false,
              ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}), text: JSON.stringify(depth === 'full' ? entry : summary(entry)) })
            continue
          }
          content.forEach((block, index) => {
            if (block.type === 'text') return
            // Conversation blocks stay separate from activity, including mixed
            // assistant prose + tool entries. Tool-result user-role carriers
            // can therefore never masquerade as an actual user prompt.
            messages.push({ id: `${item.key}:block:${index}`, role: 'activity', kind: block.type,
              source, partial: false, ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
              text: JSON.stringify(depth === 'full' ? block : summary(block)) })
          })
        }
      } else if (item.type === 'semantic-text') {
        messages.push({ id: item.key, role: 'assistant', text: item.text, kind: 'message', source: item.owner,
          partial: item.owner === 'semantic-current' })
      } else if (item.type === 'semantic-block') {
        const block = item.block
        if (block.kind === 'text') {
          if (block.text) messages.push({ id: item.key, role: 'assistant', text: block.text, kind: 'message', source: item.owner,
            partial: item.owner === 'semantic-current', ...(block.messagePhase ? { phase: block.messagePhase } : {}) })
        } else if (details) messages.push({ id: item.key, role: 'activity', kind: block.kind, source: item.owner,
          partial: item.owner === 'semantic-current' && !block.finalized,
          text: JSON.stringify(depth === 'full' ? { block, state: item.toolState } : summary({ block, state: item.toolState })) })
      } else if (details && item.type === 'semantic-collapsed-activity') {
        messages.push({ id: item.key, role: 'activity', kind: 'collapsed-activity', source: item.owner,
          partial: item.owner === 'semantic-current', text: JSON.stringify(depth === 'full' ? item.unit : summary(item.unit)) })
      }
    }
    previousKeys = keys
    previousMessages = messages
    return messages
  }
}
