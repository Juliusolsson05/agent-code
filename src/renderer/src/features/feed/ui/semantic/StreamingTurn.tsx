import { memo, useContext, useMemo } from 'react'

import type { Entry } from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import {
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { SemanticCollapsedActivityRow } from '@renderer/features/feed/ui/semantic/CollapsedActivityRow'
import { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
import {
  buildCommittedAssistantText,
  buildSemanticRenderUnits,
} from '@renderer/features/feed/ui/semantic/renderUnits'

// WHY render the semantic turn block-by-block instead of just dumping
// `turn.text` through markdown:
//
// The proxy stream already tells us where text, thinking, tool_use,
// connector_text, and tool results begin and end. If we collapse all
// of that back into one markdown blob, we recreate the exact failure
// mode that made screen parsing brittle: code fences, todo lists,
// tool boundaries, and agent progress all become heuristics again.
// The whole point of the semantic path is to stop inferring
// structure from terminal paint when upstream already gave us the
// structure directly.
//
// Two previously-rendered siblings (SemanticTaskSummary,
// SemanticTurnFooter) were removed in the 2026-04-18 thinking-
// indicator rework — SemanticTaskSummary competed with WorkIndicator
// for "is the agent working" attention without answering that
// question (todos render via TodoWrite's own block row; active tool
// names are visible on the tool rows themselves). SemanticTurnFooter
// printed `stop: tool_use · in: 1234 · out: 567` — diagnostic chatter
// that lives in DebugPanel now. Both components are gone; if we ever
// want a per-turn receipt card in the chat it belongs as its own
// surface, not as a tail on every turn.
// See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
export const SemanticStreamingTurn = memo(function SemanticStreamingTurn({
  turn,
  committedEntries,
}: {
  turn: SemanticLiveTurn
  committedEntries: Entry[]
}) {
  const blocks = Object.values(turn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  // Committed tool_use index is threaded down from Feed via context.
  // buildSemanticRenderUnits uses it to skip live blocks whose
  // `toolUseId` / `callId` is already committed — kills the bottom-
  // of-feed dupe where the live turn keeps rendering tool rounds
  // that the committed transcript already painted above.
  const committedToolUseIndex = useContext(ToolUseIndexContext)
  const committedToolResultIndex = useContext(ToolResultIndexContext)
  const committedAssistantText = useMemo(
    () => buildCommittedAssistantText(committedEntries),
    [committedEntries],
  )
  const units = buildSemanticRenderUnits(
    turn,
    committedToolUseIndex,
    committedToolResultIndex,
    committedAssistantText,
  )
  const hasBlocks = blocks.length > 0

  // Compaction-synthesis placeholder.
  //
  // When Claude Code triggers `/compact` (manual or auto), the proxy
  // sees a normal `/v1/messages` POST whose last user message is the
  // fixed compact prompt. The mitm addon sniffs that signature and
  // the proxy adapter tags the resulting semantic turn with
  // `isCompactionSynthesis: true` at turn_started. The model's
  // response body is `<analysis>…</analysis><summary>…</summary>` XML
  // — not user-visible text — and rendering it raw is the visible
  // bug we're fixing.
  //
  // Returning a placeholder here is the simplest correct UI: the
  // user-facing artefacts of compaction (the `compact_boundary`
  // system entry and the `isCompactSummary: true` user entry) land
  // via JSONL later and already have proper renderers
  // (`CompactBoundaryRow` and `CompactSummaryRow` in feed/ui/rows/).
  // The placeholder just covers the seconds-to-minutes streaming
  // window where the synthesis turn would otherwise leak XML into
  // the feed. Mirrors `CompactBoundaryRow` styling so the live and
  // committed states share visual language.
  //
  // Placed AFTER the hooks (useContext/useMemo above) on purpose:
  // moving it earlier would break Rules of Hooks because the hook
  // count would differ between compaction and non-compaction renders
  // of the same component instance. The wasted hook work is cheap —
  // `committedAssistantText` memoizes on `committedEntries` which
  // doesn't grow during the compaction window.
  if (turn.isCompactionSynthesis) {
    return (
      <MarkerRow marker="·" tone="muted">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          Compacting conversation…
        </div>
      </MarkerRow>
    )
  }

  if (!hasBlocks) {
    // WHY collapse to null instead of rendering an empty MarkerRow:
    //
    // For Codex the rollout stream does not emit per-block events, so
    // `turn.blocks` stays empty and this branch owns the entire live
    // view. `turn.text` is cleared to '' by the Codex adapter the
    // moment a `response_item` commits the current assistant message,
    // because the committed `:message` entry in the feed then owns
    // display of that text. During that transient — and between two
    // messages in the same Codex turn more broadly — there is
    // genuinely nothing the ghost should paint. An empty MarkerRow
    // would still render a solitary ⏺ bullet under the committed row,
    // which reads as a second speaker to the user.
    //
    // Returning null is correct because WorkIndicator below the feed
    // carries the "agent is working" signal on its own. See
    // docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
    if (!turn.text) return null
    if (
      committedAssistantText.keys.has(`${turn.turnId}\u0000${turn.text}`) ||
      committedAssistantText.texts.has(turn.text)
    ) {
      return null
    }
    return (
      <MarkerRow marker="⏺">
        <StreamingProse text={turn.text} />
      </MarkerRow>
    )
  }

  return (
    <>
      {units.map(unit => (
        unit.type === 'collapsed_activity' ? (
          <SemanticCollapsedActivityRow
            key={`${turn.turnId}:collapsed:${unit.blockIndices.join(',')}`}
            unit={unit}
          />
        ) : (
          <SemanticLiveBlockRow
            key={`${turn.turnId}:block:${unit.block.blockIndex}:${unit.block.itemId ?? unit.block.callId ?? unit.block.toolUseId ?? 'anon'}`}
            block={unit.block}
            toolState={unit.toolState}
          />
        )
      ))}
    </>
  )
})
