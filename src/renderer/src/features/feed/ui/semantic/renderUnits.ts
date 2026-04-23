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
export function buildSemanticRenderUnits(turn: SemanticLiveTurn): SemanticRenderUnit[] {
  const blocks = Object.values(turn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  const units: SemanticRenderUnit[] = []
  let pending: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }> | null = null

  const flush = () => {
    if (!pending) return
    units.push(pending)
    pending = null
  }

  for (const block of blocks) {
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
