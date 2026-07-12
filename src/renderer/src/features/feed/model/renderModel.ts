import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { Entry } from '@shared/types/transcript'

import type {
  SemanticLiveTurn,
  StreamPhase,
} from '@renderer/session-runtime/state'
import type {
  AgentProvider,
  DebugVisibleRow,
  VisibleDecision,
} from '@renderer/features/feed/types'
import { debugLabelForEntry } from '@renderer/features/feed/lib/helpers'
import type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'

// NOTE (Stage 3 cutover + #491 block-level un-collapse): the legacy in-Feed
// decision core lived here and is fully deleted — `deriveFeedRenderModel` (the
// plane partitioner) AND `deriveFeedCommittedProjection` (which only fed
// SemanticStreamingTurn's committed dedup, now that the ledger owns that and the
// component is gone). The ownership ledger (src/renderer/src/rendering/) is the
// sole decision-maker; desktop and phone hand Feed the ledger's pre-ordered
// items. What remains is deliberately dumb: the FeedRenderItem contract and
// `feedRenderModelFromItems` (attaches debug side-products to the ledger's list).

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
  // #491 block-level un-collapse: the view bridge no longer hands Feed a whole
  // turn (which SemanticStreamingTurn then re-suppressed block-by-block). The
  // ledger already decided which blocks are visible, so the bridge emits ONE
  // item per ledger-approved block (or a collapsed churn receipt / a blockless
  // text row), drawn by a dumb row. `owner` is kept so Feed can still derive the
  // history/current debug + work-hint signals it used to read off the turn item.
  | {
      type: 'semantic-block'
      key: string
      turnId: string
      owner: 'semantic-current' | 'semantic-history'
      block: SemanticLiveTurn['blocks'][number]
      toolState: SemanticLiveTurn['lookups']['toolCallsById'][string] | null
      order: FeedRenderItemOrder
    }
  | {
      type: 'semantic-collapsed-activity'
      key: string
      turnId: string
      owner: 'semantic-current' | 'semantic-history'
      unit: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }>
      order: FeedRenderItemOrder
    }
  | {
      // Blockless turn text (Codex/opencode deliver text ONLY on turn.text with
      // an empty block map — semantic.ts mints a `sem:<turnId>:text` candidate).
      type: 'semantic-text'
      key: string
      turnId: string
      owner: 'semantic-current' | 'semantic-history'
      text: string
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

function labelForItem(item: FeedRenderItem, provider: AgentProvider): string {
  switch (item.type) {
    case 'entry':
      return debugLabelForEntry(item.entry)
    case 'semantic-block':
      return `semantic ${item.owner === 'semantic-current' ? 'current' : 'history'} ${item.turnId.slice(0, 12)}#${item.block.blockIndex} · ${item.block.kind}`
    case 'semantic-collapsed-activity':
      return `collapsed ${item.turnId.slice(0, 12)} · ${item.unit.count} tools${item.unit.isRunning ? ' (running)' : ''}`
    case 'semantic-text':
      return `semantic text ${item.owner === 'semantic-current' ? 'current' : 'history'} ${item.turnId.slice(0, 12)}`
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
    case 'semantic-block':
    case 'semantic-collapsed-activity':
    case 'semantic-text':
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

