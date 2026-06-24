import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'

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
  committedToolResultIndex?: Map<string, ToolResultBlock>,
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

  // WHY `.some(paintsDom)` and not `.length > 0` (feed audit Finding 3):
  // a render unit existing is NOT the same as a unit that paints DOM. The one
  // offending case is a RUNNING collapsed_activity run: buildSemanticRenderUnits
  // emits a unit for it, but SemanticCollapsedActivityRow returns null while it
  // is running (WorkIndicator owns the "busy" surface instead). Counting that
  // null-painting unit as renderable makes render-model ownership disagree with
  // the DOM — it suppresses the empty/work fallback and can mislead duplicate
  // guards into thinking a row exists where the screen is blank. Asking "does any
  // unit actually paint?" keeps the model and the DOM in agreement.
  return buildSemanticRenderUnits(
    turn,
    committedToolUseIndex,
    committedToolResultIndex,
    committedAssistantText,
  ).some(semanticRenderUnitPaintsDom)
}

// Does this render unit own visible feed space, or is it a no-op the row
// component renders as null? Mirrors the row components' own null returns so the
// render model never claims ownership for a unit that paints nothing.
//   - A RUNNING collapsed_activity run paints null (CollapsedActivityRow defers
//     to WorkIndicator); a FINISHED run paints a "worked: …" receipt.
//   - 'block' units are only emitted AFTER the invisible-block filters in
//     buildSemanticRenderUnits (empty write_stdin, empty reasoning, committed-
//     owned dupes), so a surviving block unit always owns DOM.
export function semanticRenderUnitPaintsDom(unit: SemanticRenderUnit): boolean {
  if (unit.type === 'collapsed_activity') return !unit.isRunning
  return true
}

function semanticToolUseCorrelationId(block: SemanticLiveTurn['blocks'][number]): string | null {
  return block.toolUseId ?? block.callId ?? block.itemId ?? null
}

function semanticToolOutputCorrelationId(block: SemanticLiveTurn['blocks'][number]): string | null {
  return block.toolUseId ?? block.callId ?? null
}

function isSemanticToolOutputBlock(block: SemanticLiveTurn['blocks'][number]): boolean {
  return (
    block.kind === 'function_call_output' ||
    block.kind === 'custom_tool_call_output' ||
    block.kind === 'tool_search_output'
  )
}

function writeStdinChars(block: SemanticLiveTurn['blocks'][number]): string {
  const parsed = asRecord(block.parsedInput)
  if (typeof parsed?.chars === 'string') return parsed.chars
  const raw = block.argumentsJson ?? block.inputJson ?? ''
  const rawParsed = parseJsonRecord(raw)
  return typeof rawParsed?.chars === 'string' ? rawParsed.chars : ''
}

function isInvisibleWriteStdinBlock(block: SemanticLiveTurn['blocks'][number]): boolean {
  if (
    block.toolName !== 'write_stdin' ||
    (block.kind !== 'function_call' && block.kind !== 'custom_tool_call')
  ) {
    return false
  }
  // WHY the selector mirrors the row renderer instead of trusting
  // "there is a semantic block":
  // `CodexWriteStdinRow` intentionally returns null when the input
  // carries no non-empty `chars` payload. If the render-unit layer
  // still emits a unit for that same block, the model/debug panel
  // claims semantic content exists while React paints nothing. That
  // false ownership is how the feed loses its empty/work fallback and
  // how future duplicate guards get misled. Visibility is decided at
  // this layer, so the render model and the DOM agree on whether this
  // block actually owns screen real estate.
  return writeStdinChars(block).length === 0
}

function isInvisibleEmptyReasoningBlock(block: SemanticLiveTurn['blocks'][number]): boolean {
  if (block.kind !== 'thinking' && block.kind !== 'reasoning') return false
  const text =
    block.thinking ||
    block.reasoningSummary ||
    block.reasoningText ||
    ''
  // WHY this belongs in the render-unit selector:
  // SemanticLiveBlockRow intentionally returns null for empty
  // reasoning/thinking because WorkIndicator is the real "agent is
  // thinking" surface. If this selector still emits a block unit, an
  // archived proxy turn with only empty finalized reasoning can keep a
  // semantic-history row alive forever in debug/render ownership while
  // React paints no content. That false positive was part of the
  // 2026-05-17 web-search bundle: after committed rollout owned the
  // visible answer, empty reasoning blocks helped keep old proxy
  // history mounted at the bottom.
  return text.length === 0
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
// / `tool_search_output`) deliberately do NOT use the tool_use
// index. Codex commits tool_use and tool_result as separate rollout
// items, so a committed command card does not prove the committed
// output row exists yet. Output blocks yield only to the
// ToolResultIndex; until then, the live semantic stream remains the
// sole visible owner of stdout/stderr.
export function buildSemanticRenderUnits(
  turn: SemanticLiveTurn,
  committedToolUseIndex?: Map<string, ToolUseBlock>,
  committedToolResultIndex?: Map<string, ToolResultBlock>,
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

    if (isInvisibleWriteStdinBlock(block)) continue
    if (isInvisibleEmptyReasoningBlock(block)) continue

    // Committed-ownership skip. Check both Claude's `toolUseId` and
    // Codex's `callId` — the committed indices are keyed by the
    // tool_use.id / tool_result.tool_use_id fields, which for Codex
    // are the original call_id (see codexToolUseEntry in
    // workspace/codex/entries.ts).
    //
    // WHY outputs use the result index instead of the use index:
    // Codex rollout can commit the tool_use row before the paired
    // tool_result row. During that JSONL lag, the live semantic
    // output is still the only owner of visible stdout/stderr. The
    // previous broad rule ("tool_use committed means all associated
    // live blocks are dupes") created a gap: the command card was
    // committed, the result was not, and the live output disappeared.
    // Use blocks yield to committed tool_use ownership; output blocks
    // yield only after committed tool_result ownership exists.
    const toolId = isSemanticToolOutputBlock(block)
      ? semanticToolOutputCorrelationId(block)
      : semanticToolUseCorrelationId(block)
    const toolOwnedByCommitted = toolId
      ? isSemanticToolOutputBlock(block)
        ? committedToolResultIndex?.has(toolId) === true
        : committedToolUseIndex?.has(toolId) === true
      : false
    if (toolOwnedByCommitted) {
      // Don't flush() here — a collapsed_activity run should stay
      // open across a committed skip; the next non-skipped block
      // decides whether to continue accumulating or emit the run.
      continue
    }

    const toolState = block.toolUseId
      ? turn.lookups.toolCallsById[block.toolUseId] ?? null
      : null
    const activity = classifySemanticToolActivity(block)
    // AskUserQuestion must NEVER fold into a collapsed_activity run — it
    // is a live, blocking picker the user has to act on, not low-signal
    // read/search/bash churn. classifySemanticToolActivity already
    // returns collapsible:false for it (it isn't Read/Grep/Glob/Bash), so
    // this is belt-and-suspenders: if a future tweak to that classifier
    // ever marks it collapsible, this guard keeps the picker rendering as
    // its own answerable AskUserQuestionRow rather than vanishing into a
    // "worked: N reads" summary the user can't click.
    const isCollapsibleTool =
      (block.kind === 'tool_use' ||
        block.kind === 'server_tool_use' ||
        block.kind === 'mcp_tool_use') &&
      block.toolName !== 'AskUserQuestion' &&
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
