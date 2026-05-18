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
  visibleDecisions: VisibleDecision[]
  visibleEntries: Entry[]
  renderedSemanticHistory: SemanticLiveTurn[]
  renderedSemanticTurn: SemanticLiveTurn | null
  hasSemanticStreaming: boolean
  shouldShowWorkIndicator: boolean
  debugRows: DebugVisibleRow[]
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

  const debugRows: DebugVisibleRow[] = []
  if (visibleEntries.length === 0 && !hasSemanticStreaming) {
    debugRows.push({
      key: 'empty',
      slot: 'empty',
      label: provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…',
    })
  } else {
    for (const item of visibleDecisions) {
      if (!item.visible) continue
      debugRows.push({
        key: `entry:${item.key}`,
        slot: 'entry',
        label: debugLabelForEntry(item.entry),
      })
    }
    for (const turn of renderedSemanticHistory) {
      debugRows.push({
        key: `semantic-history:${turn.turnId}`,
        slot: 'semantic',
        label: `semantic history ${turn.turnId.slice(0, 12)} · ${turn.source ?? 'unknown'}`,
      })
    }
    if (renderedSemanticTurn != null) {
      debugRows.push({
        key: `semantic:${renderedSemanticTurn.turnId}`,
        slot: 'semantic',
        label: `semantic turn ${renderedSemanticTurn.turnId.slice(0, 12)} · ${renderedSemanticTurn.source ?? 'unknown'}`,
      })
    }
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
    debugRows.push({
      key: `work:${streamPhase}:${streamPhasePendingToolUseId ?? 'none'}`,
      slot: 'work',
      label:
        streamPhasePendingToolName && (
          streamPhase === 'tool-input' ||
          streamPhase === 'tool-use' ||
          streamPhase === 'awaiting-tool'
        )
          ? `work ${streamPhase} · ${streamPhasePendingToolName}`
          : `work ${streamPhase}`,
    })
  }

  return {
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
