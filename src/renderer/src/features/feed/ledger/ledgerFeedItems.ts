import type { Entry } from '@shared/types/transcript'
import type {
  FeedRenderItem,
  FeedRenderItemOrder,
} from '@renderer/features/feed/model/renderModel'
import type { VisibleDecision } from '@renderer/features/feed/types'
import type {
  RuntimeRenderInput,
  SemanticLiveTurn,
  StreamPhase,
} from '@renderer/session-runtime/state'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderLedger, RenderRow } from '@renderer/rendering/model/types'
import { groupSemanticActivity } from '@renderer/features/feed/ui/semantic/renderUnits'
import { providerDurableEntryKind } from '@providers/registry.renderer.capabilities'

// ---------------------------------------------------------------------------
// The view bridge: RenderLedger rows → FeedRenderItem[].
//
// #491 BLOCK-LEVEL UN-COLLAPSE: this bridge used to COLLAPSE every semantic
// turn's block-rows back into ONE turn-level item (semantic-current /
// semantic-history) so the legacy `SemanticStreamingTurn` could render it —
// and that component then RE-DERIVED all the suppression the ledger already
// made (buildSemanticRenderUnits). That was two decision-makers for live
// turns. Now the bridge emits ONE item per ledger-APPROVED block: the ledger
// (observations/semantic.ts + model/ownership.ts) is the sole decider of which
// blocks are visible, and the bridge only applies the PRESENTATION grouping
// (fold churn tools into a "worked: N reads" receipt via groupSemanticActivity)
// before handing dumb rows their block.
//
// GROUP-BY-TURN, NOT BY-ADJACENCY: order.ts tiebreaks equal-timestamp turns by
// per-turn block index, so two turns sharing a timestamp INTERLEAVE
// (A0,B0,A1,B1). We therefore pre-group semantic rows by turnId and emit each
// turn's blocks contiguously at its FIRST row's position — safe because a
// committed row can never sort strictly between a turn's equal-timestamp blocks.
//
// ORDER CONTRACT: items are emitted in LEDGER order; the synthesized `order`
// fields keep timeMs null + a constant source so the legacy sorter is a no-op —
// the ledger's D4 chronological merge stays authoritative.
// ---------------------------------------------------------------------------

export type LedgerFeedContext = {
  provider: AgentProviderKind
  /** committed + embedded-optimistic rows (runtime.entries) PLUS ghost
   *  records — every uuid a row candidate can reference. */
  entriesByUuid: ReadonlyMap<string, Entry>
  turnsById: ReadonlyMap<string, SemanticLiveTurn>
  streamPhase: StreamPhase
  streamPhasePendingToolName: string | null
  streamPhasePendingToolUseId: string | null
  /**
   * Provider-owned block paintability for committed entries. Optional keeps
   * pure ledger fixtures focused on row mapping; production always supplies
   * it from useLedgerFeedItems with the same pair cache Feed uses.
   */
  committedEntryPaints?: (entry: Entry) => boolean
}

export type LedgerFeedItemsResult = {
  items: FeedRenderItem[]
  /** Candidate ids the bridge could not resolve to renderable data (uuid
   *  or turnId missing from the context lookups). MUST be surfaced by the
   *  caller — a silently dropped row is the exact "present but invisible"
   *  failure class (#239) this rewrite exists to kill. */
  dropped: string[]
}

/** Build the uuid→Entry / turnId→turn lookups from the live runtime. Split
 *  from the mapper so tests can hand-construct contexts. Ghost records ARE
 *  Entry-shaped (atp mints provisional ClaudeEntry rows), so they join the
 *  same lookup the legacy fold relied on. */
export function ledgerFeedContextFromRuntime(
  runtime: RuntimeRenderInput,
  provider: AgentProviderKind,
): LedgerFeedContext {
  const entriesByUuid = new Map<string, Entry>()
  for (const e of runtime.entries) {
    if (typeof e.uuid === 'string') entriesByUuid.set(e.uuid, e)
  }
  for (const [uuid, ghost] of runtime.ghosts) {
    entriesByUuid.set(uuid, ghost as Entry)
  }
  const turnsById = new Map<string, SemanticLiveTurn>()
  if (runtime.semantic.currentTurn) {
    turnsById.set(runtime.semantic.currentTurn.turnId, runtime.semantic.currentTurn)
  }
  for (const t of runtime.semantic.history) turnsById.set(t.turnId, t)
  return {
    provider,
    entriesByUuid,
    turnsById,
    streamPhase: runtime.streamPhase,
    streamPhasePendingToolName: runtime.streamPhasePendingToolName,
    streamPhasePendingToolUseId: runtime.streamPhasePendingToolUseId,
  }
}

function orderAt(index: number, phase: FeedRenderItemOrder['phase']): FeedRenderItemOrder {
  return { phase, timeMs: null, sequence: index, source: 'ledger' }
}

function visibleDecisionFor(
  entry: Entry,
  provider: AgentProviderKind,
  visible = true,
): VisibleDecision {
  // This bridge reports the ledger's decision but does not reinterpret raw
  // entry keys. Durable provider vocabulary was already admitted through the
  // same classifier used by the painter; the reason below is only a generic
  // debug label for that provider-owned classification.
  const durableKind = providerDurableEntryKind(entry, provider)
  const reason = durableKind === 'compact-boundary'
    ? 'compact_boundary'
    : durableKind === 'compact-summary'
      ? 'compact_summary'
      : 'conversation'
  return {
    key: typeof entry.uuid === 'string' ? entry.uuid : 'no-uuid',
    entry,
    visible,
    reason: visible ? reason : 'provider_operation_absorbed',
  }
}

// Build the FeedRenderItems for ONE semantic turn from its ledger-approved
// rows. The ledger already decided WHICH blocks are visible; here we only fetch
// each block's rich payload (turn.blocks — the ledger candidate carries only
// turnId+blockIndex, not the drawable input/result) and apply the presentation
// grouping. Emits: `semantic-text` for a blockless text-only turn, else one
// `semantic-block` / `semantic-collapsed-activity` per grouped unit.
function buildSemanticTurnItems(
  turnId: string,
  rows: readonly RenderRow[],
  turn: SemanticLiveTurn,
  baseSeq: number,
): { items: FeedRenderItem[]; dropped: string[] } {
  const out: FeedRenderItem[] = []
  const dropped: string[] = []
  const owner: 'semantic-current' | 'semantic-history' =
    rows[0]?.candidate.owner === 'semantic-current' ? 'semantic-current' : 'semantic-history'
  const orderFor = (): FeedRenderItemOrder => orderAt(baseSeq + out.length, 'content')

  // Blockless turn (Codex/opencode deliver text ONLY on turn.text with an empty
  // block map): semantic.ts mints a single `sem:<turnId>:text` candidate with no
  // blockIndex. Render turn.text directly — the legacy no-blocks path.
  const textCandidate = rows.find(r => r.candidate.blockIndex === undefined)
  if (textCandidate) {
    if (typeof turn.text === 'string' && turn.text.length > 0) {
      out.push({
        type: 'semantic-text',
        key: `semantic-text:${turnId}`,
        turnId,
        owner,
        text: turn.text,
        order: orderFor(),
      })
    } else {
      dropped.push(textCandidate.candidate.id)
    }
    return { items: out, dropped }
  }

  // Real blocks: map each approved blockIndex to its rich block (in block order),
  // then apply presentation grouping. A missing block is a lookup gap — surface
  // it in `dropped`, never silently omit (#239 class).
  const byIndex = new Map<number, SemanticLiveTurn['blocks'][number]>()
  for (const b of Object.values(turn.blocks)) byIndex.set(b.blockIndex, b)
  const approved: SemanticLiveTurn['blocks'][number][] = []
  for (const r of [...rows].sort(
    (a, b) => (a.candidate.blockIndex ?? 0) - (b.candidate.blockIndex ?? 0),
  )) {
    const bi = r.candidate.blockIndex
    if (bi === undefined) continue
    const block = byIndex.get(bi)
    if (!block) {
      dropped.push(r.candidate.id)
      continue
    }
    approved.push(block)
  }
  for (const unit of groupSemanticActivity(approved, turn)) {
    if (unit.type === 'collapsed_activity') {
      // A RUNNING collapsed run paints nothing — SemanticCollapsedActivityRow
      // returns null while running (WorkIndicator owns the "busy" surface).
      // Emitting an item for it would put a null-painting row in the list while
      // the ledger counts its blocks as content — the false-ownership class the
      // pipeline exists to kill (#492 review finding). Skip it; only the
      // finished "worked: N reads" receipt emits. Mirrors the retired
      // semanticRenderUnitPaintsDom.
      if (unit.isRunning) continue
      out.push({
        type: 'semantic-collapsed-activity',
        key: `semantic-collapsed:${turnId}:${unit.blockIndices.join(',')}`,
        turnId,
        owner,
        unit,
        order: orderFor(),
      })
    } else {
      out.push({
        type: 'semantic-block',
        key: `semantic-block:${turnId}:${unit.block.blockIndex}`,
        turnId,
        owner,
        block: unit.block,
        toolState: unit.toolState,
        order: orderFor(),
      })
    }
  }
  return { items: out, dropped }
}

export function ledgerToFeedItems(
  ledger: RenderLedger,
  ctx: LedgerFeedContext,
): LedgerFeedItemsResult {
  const items: FeedRenderItem[] = []
  const dropped: string[] = []
  let entryOrdinal = 0

  // Pre-group every semantic row by turnId so a turn's blocks emit CONTIGUOUSLY
  // even when order.ts interleaved two equal-timestamp turns (A0,B0,A1,B1). Each
  // turn is then emitted once, at the position of its FIRST row in ledger order.
  // (The old collapse used a per-turn emitted-set on a single item; block-level
  // needs the full row list per turn, hence the map.)
  const semanticRowsByTurn = new Map<string, RenderRow[]>()
  for (const row of ledger.rows) {
    if (row.candidate.sourcePlane !== 'semantic') continue
    const t = row.candidate.turnId
    if (!t) continue
    const arr = semanticRowsByTurn.get(t)
    if (arr) arr.push(row)
    else semanticRowsByTurn.set(t, [row])
  }
  const emittedTurnIds = new Set<string>()

  for (const row of ledger.rows) {
    const c = row.candidate
    switch (c.sourcePlane) {
      case 'committed':
      case 'local-submit':
      case 'ghost': {
        const uuid = c.id.replace(/^(entry|optimistic|ghost):/, '')
        const entry = ctx.entriesByUuid.get(uuid)
        if (!entry) {
          dropped.push(c.id)
          break
        }
        if (ctx.committedEntryPaints?.(entry) === false) {
          items.push({
            type: 'absorbed-entry',
            key: `absorbed-entry:${uuid}`,
            entry,
            visibleDecision: visibleDecisionFor(entry, ctx.provider, false),
            order: orderAt(items.length, 'content'),
          })
          break
        }
        items.push({
          type: 'entry',
          key: `entry:${uuid}`,
          entry,
          visibleDecision: visibleDecisionFor(entry, ctx.provider),
          entryOrdinal: entryOrdinal++,
          order: orderAt(items.length, 'content'),
        })
        break
      }
      case 'semantic': {
        const turnId = c.turnId
        if (!turnId) {
          dropped.push(c.id)
          break
        }
        if (emittedTurnIds.has(turnId)) break
        emittedTurnIds.add(turnId)
        const turnRows = semanticRowsByTurn.get(turnId) ?? [row]
        const turn = ctx.turnsById.get(turnId)
        if (!turn) {
          // #492 review finding: the turn is marked emitted above, so the OTHER
          // rows of this turn will be skipped by the emittedTurnIds guard — we
          // must account for ALL of them in dropped here, not just this row's
          // candidate, or a missing multi-block turn silently under-reports
          // selected-but-invisible rows (the #239 class).
          for (const r of turnRows) dropped.push(r.candidate.id)
          break
        }
        const built = buildSemanticTurnItems(turnId, turnRows, turn, items.length)
        for (const it of built.items) items.push(it)
        for (const d of built.dropped) dropped.push(d)
        break
      }
      case 'process': {
        if (c.contentKind === 'work') {
          items.push({
            type: 'work',
            key: `work:${ctx.streamPhase}:${ctx.streamPhasePendingToolUseId ?? 'none'}`,
            phase: ctx.streamPhase,
            toolName: ctx.streamPhasePendingToolName,
            toolUseId: ctx.streamPhasePendingToolUseId,
            order: orderAt(items.length, 'work'),
          })
        } else {
          items.push({
            type: 'empty',
            key: 'empty',
            provider: ctx.provider,
            order: orderAt(items.length, 'empty'),
          })
        }
        break
      }
      default:
        dropped.push(c.id)
        break
    }
  }

  // WHY the bridge repairs emptiness here: provider operation correlation is
  // block-grain information the entry-grain ledger candidate deliberately does
  // not carry. Once all selected committed carriers are resolved, they may all
  // become named absorptions. Without this post-correlation verdict the ledger
  // counted a content survivor but Feed painted none, recreating the blank
  // surface invariant this pipeline was built to prevent. This is still an
  // upstream data decision—Feed receives an explicit empty item and never
  // filters a selected row itself.
  const hasPaintedContent = items.some(item =>
    item.type !== 'absorbed-entry' && item.type !== 'empty' && item.type !== 'work',
  )
  if (!hasPaintedContent && !items.some(item => item.type === 'empty')) {
    const workIndex = items.findIndex(item => item.type === 'work')
    const insertionIndex = workIndex < 0 ? items.length : workIndex
    items.splice(insertionIndex, 0, {
      type: 'empty',
      key: 'empty:post-correlation',
      provider: ctx.provider,
      order: orderAt(insertionIndex, 'empty'),
    })
    // Keep the order metadata truthful after inserting before a work item.
    for (let index = insertionIndex + 1; index < items.length; index += 1) {
      const item = items[index]
      const phase = item.type === 'work' ? 'work' : item.type === 'empty' ? 'empty' : 'content'
      item.order = orderAt(index, phase)
    }
  }

  return { items, dropped }
}
