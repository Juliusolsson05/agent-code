import type { Entry, ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'

import { classifySemanticToolActivity } from '@renderer/features/feed/lib/helpers'

import type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'

export type CommittedAssistantText = {
  /** Turn-scoped keys for the clean case where live semantic turn id
   *  and committed transcript turn id agree. Claude normally lands
   *  here via message.id; Codex sometimes lands here via codexTurnId. */
  keys: ReadonlySet<string>
  /** Exact committed assistant text, independent of turn id.
   *
   * WHY this fallback exists:
   * Codex can expose two ids for one user-visible response. The proxy
   * semantic stream uses the Responses API id (`resp_*`); committed
   * rollout rows are stamped with the task/turn id (`019e...`) because
   * response_item rows do not carry the proxy response id. The debug
   * bundle `2026-05-16T17-51-43-433-f2395303` has exactly that shape:
   * committed row `2026-05-16T17:51:37.605Z:message` plus live
   * semantic row `resp_009dff...` rendered the same paragraph in raw
   * HTML. A turn-key-only filter cannot see they are the same visible
   * block.
   *
   * This is intentionally exact-string and committed-only. We do not
   * fuzzy match prefixes, and the render-unit guard only applies to
   * finalized/completed live text blocks, so active streaming text is
   * not hidden just because an older committed answer shares a prefix. */
  texts: ReadonlySet<string>
  /** Same ownership check as `texts`, but after display-normalizing
   *  whitespace and unicode form.
   *
   * WHY this has to exist:
   * Codex can commit a response through rollout while the live
   * semantic history row was built from a different stream. Those
   * streams can preserve line wrapping / spacing differently even
   * when the user-visible sentence is the same. Exact string
   * suppression is still the safest first check, but the recurring
   * "old assistant sentence stuck at the bottom" failure is caused by
   * an archived semantic row surviving committed catch-up because the
   * two copies are textually equivalent rather than byte-identical.
   * Normalize only whitespace/unicode, not prefixes or fuzzy
   * substrings, so active streaming text is not hidden by a merely
   * similar older answer. */
  normalizedTexts: ReadonlySet<string>
}

export function normalizeCommittedAssistantText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildCommittedAssistantText(entries: Entry[]): CommittedAssistantText {
  const keys = new Set<string>()
  const texts = new Set<string>()
  const normalizedTexts = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const assistantEntry = entry as {
      codexTurnId?: unknown
      message?: { id?: unknown; content?: unknown }
    }
    const turnIds = [
      typeof assistantEntry.message?.id === 'string' ? assistantEntry.message.id : null,
      typeof assistantEntry.codexTurnId === 'string' ? assistantEntry.codexTurnId : null,
    ].filter((id): id is string => Boolean(id))
    const content = assistantEntry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const item = block as Record<string, unknown>
      if (item.type !== 'text' || typeof item.text !== 'string' || !item.text) continue
      // WHY text ownership does not require a committed turn id:
      // Codex rollout rows can be perfectly good visible assistant
      // transcript entries while still lacking both `message.id` and
      // `codexTurnId`. The 2026-05-16T18:49 bundle reproduced the
      // bottom-stuck row with exactly that shape: committed text was
      // visible above, but `buildCommittedAssistantText` skipped it
      // before adding it to `texts`, so the archived rollout semantic
      // copy survived as `semantic-history:*`. Turn ids are needed
      // only for the stricter key check; exact/normalized text
      // ownership must include every visible committed assistant
      // text block.
      texts.add(item.text)
      const normalized = normalizeCommittedAssistantText(item.text)
      if (normalized) normalizedTexts.add(normalized)
      for (const turnId of turnIds) {
        keys.add(`${turnId}\u0000${item.text}`)
      }
    }
  }
  return { keys, texts, normalizedTexts }
}

export function semanticTurnHasRenderableContent(
  turn: SemanticLiveTurn,
  committedToolUseIndex?: Map<string, ToolUseBlock>,
  committedAssistantText?: CommittedAssistantText,
): boolean {
  // Compaction synthesis deliberately paints a placeholder instead
  // of its raw XML body. That placeholder is real user-visible UI,
  // so the render model must count the turn as renderable even if
  // all semantic blocks are otherwise filtered.
  if (turn.isCompactionSynthesis) return true

  const blocks = Object.values(turn.blocks)
  if (blocks.length === 0) {
    if (!turn.text) return false
    const normalizedText = normalizeCommittedAssistantText(turn.text)
    return !(
      committedAssistantText?.keys.has(`${turn.turnId}\u0000${turn.text}`) ||
      committedAssistantText?.texts.has(turn.text) ||
      (
        normalizedText !== '' &&
        committedAssistantText?.normalizedTexts.has(normalizedText)
      )
    )
  }

  return buildSemanticRenderUnits(
    turn,
    committedToolUseIndex,
    committedAssistantText,
  ).length > 0
}

// WHY add a derived render-unit pass before painting semantic blocks:
//
// Claude Code does not render raw transcript/tool rows directly for
// noisy low-signal activity. It groups read/search/tool churn into
// summary units first, then the UI renders those summaries.
// Agent Code is not at full parity yet, but even this narrow pass
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
  committedAssistantText?: CommittedAssistantText,
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
    const text = block.text ?? ''
    if (
      text &&
      (block.kind === 'text' || block.kind === 'message') &&
      (block.finalized || block.status === 'completed') &&
      (
        committedAssistantText?.keys.has(`${turn.turnId}\u0000${text}`) ||
        committedAssistantText?.texts.has(text) ||
        committedAssistantText?.normalizedTexts?.has(normalizeCommittedAssistantText(text))
      )
    ) {
      continue
    }

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
