import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
} from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import type {
  SemanticLiveTurn,
  StreamPhase,
} from '@renderer/workspace/workspaceState'
import type {
  AgentProvider,
  DebugVisibleRow,
  VisibleDecision,
} from '@renderer/features/feed/types'
import {
  debugKeyForEntry,
  debugLabelForEntry,
} from '@renderer/features/feed/lib/helpers'
import {
  buildCommittedAssistantText,
  type CommittedAssistantText,
} from '@renderer/features/feed/ui/semantic/renderUnits'

// NOTE (Stage 3 cutover, 2026-07): `deriveFeedRenderModel` — the legacy in-Feed
// decision core that partitioned committed + semantic planes into an ordered
// item list — lived here and is deleted. The ownership ledger
// (src/renderer/src/rendering/) is now the sole decision-maker; both the
// desktop and the phone hand Feed the ledger's pre-ordered items. What remains
// is deliberately dumb: the FeedRenderItem contract, `feedRenderModelFromItems`
// (attaches debug side-products to the ledger's list), and
// `deriveFeedCommittedProjection` (still feeds SemanticStreamingTurn's committed
// dedup until the block-level un-collapse retires that component too).

export type FeedCommittedProjection = {
  visibleDecisions: VisibleDecision[]
  visibleEntries: Entry[]
  committedClaudeMessageTurnIds: ReadonlySet<string>
  committedAssistantText: CommittedAssistantText
}

export type FeedRenderModel = {
  items: FeedRenderItem[]
  visibleDecisions: VisibleDecision[]
  debugRows: DebugVisibleRow[]
}

export type FeedRenderItemOrder = {
  phase: 'empty' | 'content' | 'work'
  timeMs: number | null
  sequence: number
  source: string
}

export type FeedRenderItem =
  | {
      type: 'entry'
      key: string
      entry: Entry
      visibleDecision: VisibleDecision
      entryOrdinal: number
      order: FeedRenderItemOrder
    }
  | {
      type: 'semantic-history'
      key: string
      turn: SemanticLiveTurn
      order: FeedRenderItemOrder
    }
  | {
      type: 'semantic-current'
      key: string
      turn: SemanticLiveTurn
      order: FeedRenderItemOrder
    }
  | {
      type: 'work'
      key: string
      phase: StreamPhase
      toolName: string | null
      toolUseId: string | null
      order: FeedRenderItemOrder
    }
  | {
      type: 'empty'
      key: string
      provider: AgentProvider
      order: FeedRenderItemOrder
    }

function committedMessageIds(entries: Entry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const record = asRecord(entry)
    const message = asRecord(record?.message)
    const messageId = message?.id
    if (typeof messageId === 'string') ids.add(messageId)
  }
  return ids
}

function visibleDecisionForEntry(entry: Entry, index: number): VisibleDecision {
  if (isCompactBoundaryEntry(entry)) {
    return {
      key: debugKeyForEntry(entry, index),
      entry,
      visible: true,
      reason: 'compact_boundary',
    }
  }
  if (isCompactSummaryEntry(entry)) {
    return {
      key: debugKeyForEntry(entry, index),
      entry,
      visible: true,
      reason: 'compact_summary',
    }
  }
  if (!isConversationEntry(entry)) {
    return {
      key: debugKeyForEntry(entry, index),
      entry,
      visible: false,
      reason: 'not_conversation',
    }
  }
  if (asRecord(entry)?.isMeta === true) {
    return {
      key: debugKeyForEntry(entry, index),
      entry,
      visible: false,
      reason: 'meta_filtered',
    }
  }
  return {
    key: debugKeyForEntry(entry, index),
    entry,
    visible: true,
    reason: 'conversation',
  }
}

function labelForItem(item: FeedRenderItem, provider: AgentProvider): string {
  switch (item.type) {
    case 'entry':
      return debugLabelForEntry(item.entry)
    case 'semantic-history':
      return `semantic history ${item.turn.turnId.slice(0, 12)} · ${item.turn.source ?? 'unknown'}`
    case 'semantic-current':
      return `semantic turn ${item.turn.turnId.slice(0, 12)} · ${item.turn.source ?? 'unknown'}`
    case 'work':
      return item.toolName && (
        item.phase === 'tool-input' ||
        item.phase === 'tool-use' ||
        item.phase === 'awaiting-tool'
      )
        ? `work ${item.phase} · ${item.toolName}`
        : `work ${item.phase}`
    case 'empty':
      return `waiting for ${getRendererProviderCapabilities(provider).name}…`
  }
}

function slotForItem(item: FeedRenderItem): DebugVisibleRow['slot'] {
  switch (item.type) {
    case 'entry':
      return 'entry'
    case 'semantic-history':
    case 'semantic-current':
      return 'semantic'
    case 'work':
      return 'work'
    case 'empty':
      return 'empty'
  }
}

function debugRowsForItems(items: FeedRenderItem[], provider: AgentProvider): DebugVisibleRow[] {
  return items.map(item => ({
    key: item.key,
    slot: slotForItem(item),
    label: labelForItem(item, provider),
    itemType: item.type,
    order: item.order,
  }))
}

/**
 * Attach Feed's two debug side-products to the ownership ledger's pre-decided
 * item list. The ledger (src/renderer/src/rendering/) decides
 * visibility/ownership/order and hands Feed pre-ordered FeedRenderItems via
 * the view bridge; this wrapper only derives what downstream consumers read
 * off the side (visibleDecisions for the debug panel, debugRows for the RENDER
 * feed-debug stream). No sorting happens here — the ledger's order IS the
 * order (the bridge engineers item.order so any re-sort would be a no-op
 * anyway, but not re-sorting keeps the invariant visible in the code).
 */
export function feedRenderModelFromItems(
  items: FeedRenderItem[],
  provider: AgentProvider,
): FeedRenderModel {
  const visibleDecisions: VisibleDecision[] = []
  for (const item of items) {
    if (item.type === 'entry') visibleDecisions.push(item.visibleDecision)
  }
  return { items, visibleDecisions, debugRows: debugRowsForItems(items, provider) }
}

export function deriveFeedCommittedProjection(entries: Entry[]): FeedCommittedProjection {
  const visibleDecisions = entries.map(visibleDecisionForEntry)
  const visibleEntries = visibleDecisions
    .filter(item => item.visible)
    .map(item => item.entry)
  return {
    visibleDecisions,
    visibleEntries,
    committedClaudeMessageTurnIds: committedMessageIds(entries),
    committedAssistantText: buildCommittedAssistantText(entries),
  }
}
