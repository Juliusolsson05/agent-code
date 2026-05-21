import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
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
  semanticTurnHasRenderableContent,
} from '@renderer/features/feed/ui/semantic/renderUnits'

export type FeedRenderModelInput = {
  provider: AgentProvider
  entries?: Entry[]
  committed?: FeedCommittedProjection
  semanticHistory: SemanticLiveTurn[]
  semanticTurn: SemanticLiveTurn | null
  streamPhase: StreamPhase
  streamPhasePendingToolName: string | null
  streamPhasePendingToolUseId: string | null
  committedToolUseIndex?: Map<string, ToolUseBlock>
  committedToolResultIndex?: Map<string, ToolResultBlock>
}

export type FeedCommittedProjection = {
  visibleDecisions: VisibleDecision[]
  visibleEntries: Entry[]
  committedClaudeMessageTurnIds: ReadonlySet<string>
  committedAssistantText: CommittedAssistantText
}

export type FeedRenderModel = {
  items: FeedRenderItem[]
  visibleDecisions: VisibleDecision[]
  visibleEntries: Entry[]
  renderedSemanticHistory: SemanticLiveTurn[]
  renderedSemanticTurn: SemanticLiveTurn | null
  hasSemanticStreaming: boolean
  shouldShowWorkIndicator: boolean
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

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function entryTimestampMs(entry: Entry): number | null {
  return timestampMs(asRecord(entry)?.timestamp)
}

function semanticTurnTimestampMs(turn: SemanticLiveTurn): number | null {
  return typeof turn.endedAt === 'number' ? turn.endedAt : turn.startedAt
}

function phaseRank(phase: FeedRenderItemOrder['phase']): number {
  switch (phase) {
    case 'empty':
      return 0
    case 'content':
      return 1
    case 'work':
      return 2
  }
}

function contentSourceRank(source: string): number {
  switch (source) {
    case 'entry':
      return 0
    case 'semantic-history':
      return 1
    case 'semantic-current':
      return 2
    default:
      return 3
  }
}

function contentSortTime(order: FeedRenderItemOrder): number {
  // WHY null timestamps sort after timestamped content instead of
  // pretending to be "now": a missing timestamp is a lossy transcript
  // edge, not evidence that the row happened last. Keeping the
  // sequence fallback stable prevents one malformed committed row from
  // pushing stale semantic history underneath a newer user prompt.
  return order.timeMs ?? Number.MAX_SAFE_INTEGER
}

function sortFeedRenderItems(items: FeedRenderItem[]): FeedRenderItem[] {
  return [...items].sort((a, b) => {
    const phaseDelta = phaseRank(a.order.phase) - phaseRank(b.order.phase)
    if (phaseDelta !== 0) return phaseDelta

    if (a.order.phase === 'content' && b.order.phase === 'content') {
      const timeDelta = contentSortTime(a.order) - contentSortTime(b.order)
      if (timeDelta !== 0) return timeDelta
      const sourceDelta =
        contentSourceRank(a.order.source) - contentSourceRank(b.order.source)
      if (sourceDelta !== 0) return sourceDelta
    }

    return a.order.sequence - b.order.sequence
  })
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
      return provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…'
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

export function deriveFeedRenderModel({
  provider,
  entries,
  committed,
  semanticHistory,
  semanticTurn,
  streamPhase,
  streamPhasePendingToolName,
  streamPhasePendingToolUseId,
  committedToolUseIndex,
  committedToolResultIndex,
}: FeedRenderModelInput): FeedRenderModel {
  const projection = committed ?? deriveFeedCommittedProjection(entries ?? [])
  const {
    visibleDecisions,
    visibleEntries,
    committedClaudeMessageTurnIds,
    committedAssistantText,
  } = projection

  // WHY this suppression stays turn-scoped only for Claude:
  // Claude's durable assistant JSONL row carries `message.id` equal to
  // the live semantic turn id, so once that committed row exists the
  // entire archived live turn is an older copy of the same renderable
  // assistant response. Codex rollout is not shaped that way. Codex
  // commits response items one at a time, and a single tool item may
  // share the broader codex turn id with later assistant text. If we
  // used "any committed id suppresses the whole turn" for Codex, tool
  // commit catch-up would hide still-live assistant text. Codex exact
  // duplicate prevention therefore belongs at the semantic-block level
  // inside SemanticStreamingTurn until committed and live share a more
  // precise item identity.
  const renderedSemanticHistory = semanticHistory.filter(
    turn =>
      turn.turnId !== semanticTurn?.turnId &&
      !committedClaudeMessageTurnIds.has(turn.turnId) &&
      semanticTurnHasRenderableContent(
        turn,
        committedToolUseIndex,
        committedToolResultIndex,
        committedAssistantText,
      ),
  )
  const renderedSemanticTurn =
    semanticTurn != null &&
    semanticTurnHasRenderableContent(
      semanticTurn,
      committedToolUseIndex,
      committedToolResultIndex,
      committedAssistantText,
    )
      ? semanticTurn
      : null
  const hasSemanticStreaming =
    renderedSemanticTurn !== null || renderedSemanticHistory.length > 0
  const shouldShowWorkIndicator = streamPhase !== 'idle'

  const unsortedItems: FeedRenderItem[] = []
  let contentSequence = 0
  let entryOrdinal = 0
  for (const item of visibleDecisions) {
    if (!item.visible) continue
    unsortedItems.push({
      type: 'entry',
      key: `entry:${item.key}`,
      entry: item.entry,
      visibleDecision: item,
      entryOrdinal,
      order: {
        phase: 'content',
        timeMs: entryTimestampMs(item.entry),
        sequence: contentSequence++,
        source: 'entry',
      },
    })
    entryOrdinal += 1
  }
  for (const turn of renderedSemanticHistory) {
    unsortedItems.push({
      type: 'semantic-history',
      key: `semantic-history:${turn.turnId}`,
      turn,
      order: {
        phase: 'content',
        timeMs: semanticTurnTimestampMs(turn),
        sequence: contentSequence++,
        source: 'semantic-history',
      },
    })
  }
  if (renderedSemanticTurn != null) {
    unsortedItems.push({
      type: 'semantic-current',
      key: `semantic:${renderedSemanticTurn.turnId}`,
      turn: renderedSemanticTurn,
      order: {
        phase: 'content',
        timeMs: semanticTurnTimestampMs(renderedSemanticTurn),
        sequence: contentSequence++,
        source: 'semantic-current',
      },
    })
  }

  const hasContentItems = unsortedItems.length > 0
  if (!hasContentItems) {
    unsortedItems.push({
      type: 'empty',
      key: 'empty',
      provider,
      order: {
        phase: 'empty',
        timeMs: null,
        sequence: 0,
        source: 'empty',
      },
    })
  }

  // WHY work is modeled independently from content rows:
  // `streamPhase` is the agent lifecycle signal, not proof that a
  // semantic text row exists. Fresh submits, tool waits, and mid-turn
  // follow-up queueing can all have "agent is busy" state before or
  // after assistant text. The previous renderer repeatedly regressed
  // by tying the spinner to whatever row happened to be mounted. Keep
  // the work affordance as its own surface so "busy" cannot disappear
  // just because the semantic owner changed.
  if (shouldShowWorkIndicator) {
    unsortedItems.push({
      type: 'work',
      key: `work:${streamPhase}:${streamPhasePendingToolUseId ?? 'none'}`,
      phase: streamPhase,
      toolName: streamPhasePendingToolName,
      toolUseId: streamPhasePendingToolUseId,
      order: {
        phase: 'work',
        timeMs: null,
        sequence: 0,
        source: 'work',
      },
    })
  }

  // WHY the sort happens after ownership suppression rather than
  // before: visibility ownership decides whether a semantic/archive
  // row is allowed to exist at all. Ordering is only meaningful over
  // surviving render owners. This is the bug boundary that kept
  // hiding user prompts: the old renderer made correct per-plane
  // ownership decisions, then mounted the planes in bucket order so a
  // stale semantic history row could still appear after a newer user
  // prompt.
  const items = sortFeedRenderItems(unsortedItems)
  const debugRows = debugRowsForItems(items, provider)

  return {
    items,
    visibleDecisions,
    visibleEntries,
    renderedSemanticHistory,
    renderedSemanticTurn,
    hasSemanticStreaming,
    shouldShowWorkIndicator,
    debugRows,
  }
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
