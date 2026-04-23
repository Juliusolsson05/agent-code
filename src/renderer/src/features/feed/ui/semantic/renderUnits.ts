import type { ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

import { classifySemanticToolActivity } from '@renderer/features/feed/lib/helpers'

import type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'

// WHY add a derived render-unit pass before painting semantic blocks:
//
// Claude Code does not render raw transcript/tool rows directly for
// noisy low-signal activity. It groups read/search/tool churn into
// summary units first, then the UI renders those summaries.
// cc-shell is not at full parity yet, but even this narrow pass
// moves us away from "one semantic block = one visual row" and
// toward the same safer architecture.
//
// The loop walks blocks in blockIndex order and maintains a single
// `pending` collapsed_activity bucket. Every non-collapsible block
// flushes the bucket (committing it as a unit) and then emits its
// own 'block' unit. Runs of collapsible blocks accumulate into the
// bucket, tallying per-category counts. The terminal flush() after
// the loop commits the last bucket if the turn ended while
// accumulating.
//
// Committed-ownership filter. When a tool_use / function_call /
// custom_tool_call block's id already exists in the committed
// `ToolUseIndex`, the committed transcript has already rendered
// the row inline above. Painting the same block again from the
// live semantic turn produces the bottom-of-feed duplicate that
// shows up whenever the Codex live turn stays mounted longer than
// its individual tool rounds take to commit (proved by the
// 2026-04-23 debug bundle: 7 exec_command rows painted at the
// bottom while their committed counterparts were already in the
// feed above). Skip those blocks entirely. Text / thinking /
// citations / image / search / shell blocks that carry no tool
// correlation id pass through unchanged — they're either still-
// only-live-owner content or will be filtered by the turn-level
// suppression when we add it.
//
// Output blocks (`function_call_output` / `custom_tool_call_output`
// / `tool_search_output`) get the same treatment when their
// `callId` matches a committed tool_use: if the tool_use is
// already in the committed index, its paired output is rendered
// by the committed `ToolResultRow` above and the live copy is a
// duplicate. The rule is "if the tool_use is committed, ALL its
// associated live blocks are dupes" — simpler than tracking the
// commit state per output block separately, and matches how the
// committed feed renders both halves as a pair.
export function buildSemanticRenderUnits(
  turn: SemanticLiveTurn,
  committedToolUseIndex?: Map<string, ToolUseBlock>,
): SemanticRenderUnit[] {
  const blocks = Object.values(turn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  const units: SemanticRenderUnit[] = []
  let pending: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }> | null = null

  const flush = () => {
    if (!pending) return
    units.push(pending)
    pending = null
  }

  for (const block of blocks) {
    // Committed-ownership skip. Check both Claude's `toolUseId` and
    // Codex's `callId` — the committed index is keyed by the
    // tool_use.id field, which for Codex is the original call_id
    // (see codexToolUseEntry in workspace/codex/entries.ts). Either
    // field matching means the committed feed already owns this
    // block; the live copy is a dupe.
    const toolId = block.toolUseId ?? block.callId
    if (toolId && committedToolUseIndex?.has(toolId)) {
      // Don't flush() here — a collapsed_activity run should stay
      // open across a committed skip; the next non-skipped block
      // decides whether to continue accumulating or emit the run.
      continue
    }

    const toolState = block.toolUseId
      ? turn.lookups.toolCallsById[block.toolUseId] ?? null
      : null
    const activity = classifySemanticToolActivity(block)
    const isCollapsibleTool =
      (block.kind === 'tool_use' ||
        block.kind === 'server_tool_use' ||
        block.kind === 'mcp_tool_use') &&
      activity.collapsible &&
      activity.category !== null

    if (!isCollapsibleTool) {
      flush()
      units.push({ type: 'block', block, toolState })
      continue
    }

    if (!pending) {
      pending = {
        type: 'collapsed_activity',
        count: 0,
        searchCount: 0,
        readCount: 0,
        listCount: 0,
        bashCount: 0,
        latestHint: null,
        blockIndices: [],
        isRunning: false,
      }
    }

    pending.count += 1
    pending.blockIndices.push(block.blockIndex)
    pending.latestHint = activity.hint ?? pending.latestHint
    if (toolState?.status === 'in_progress') pending.isRunning = true

    if (activity.category === 'search') pending.searchCount += 1
    else if (activity.category === 'read') pending.readCount += 1
    else if (activity.category === 'list') pending.listCount += 1
    else if (activity.category === 'bash') pending.bashCount += 1
  }

  flush()
  return units
}
