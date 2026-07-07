import type { Entry } from '@shared/types/transcript'
import type {
  FeedRenderItem,
  FeedRenderItemOrder,
} from '@renderer/features/feed/model/renderModel'
import type { VisibleDecision } from '@renderer/features/feed/types'
import type {
  SemanticLiveTurn,
  SessionRuntime,
  StreamPhase,
} from '@renderer/workspace/workspaceState'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderLedger } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// The view bridge: RenderLedger rows → FeedRenderItem[].
//
// WHY this exists instead of new row components: the Stage 3 cutover swaps
// the DECISION CORE (what is visible, who owns it, in what order) while
// Feed's row rendering — LazyEntry, the memo structure, autoscroll's
// tail-signature, TextProse/StreamingProse — survives untouched. Emitting
// the legacy FeedRenderItem shape means `Feed.tsx` behind
// AGENT_CODE_RENDER_PIPELINE=1 changes ONE call site. SemanticStreamingTurn
// keeps rendering semantic items until the final cutover slice deletes it
// together with ghost rule 3 (plan D6) — deleting it here would couple the
// decision-core swap to a full row-component rewrite, exactly the big-bang
// this staging exists to avoid.
//
// ORDER CONTRACT: items are emitted in LEDGER order, and the synthesized
// `order` fields are engineered so legacy sortFeedRenderItems is a NO-OP
// on them: phase matches the ledger's own phase partition (the two systems
// share PHASE_RANK semantics), timeMs is null (all-equal at MAX_SAFE_INT in
// the comparator), source is a constant (all-equal rank), sequence is the
// emission index (the comparator's final tiebreak — strictly increasing).
// The ledger's D4 chronological merge is thereby authoritative even though
// the legacy sorter still runs over the result.
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
  runtime: SessionRuntime,
  provider: AgentProviderKind,
): LedgerFeedContext {
  const entriesByUuid = new Map<string, Entry>()
  for (const e of runtime.entries) {
    if (typeof e.uuid === 'string') entriesByUuid.set(e.uuid, e)
  }
  for (const [uuid, ghost] of runtime.ghosts) {
    entriesByUuid.set(uuid, ghost as unknown as Entry)
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

function visibleDecisionFor(entry: Entry): VisibleDecision {
  const type = (entry as { type?: string }).type
  const reason =
    type === 'system' || type === 'compact_boundary'
      ? 'compact_boundary'
      : (entry as { isCompactSummary?: boolean }).isCompactSummary
        ? 'compact_summary'
        : 'conversation'
  return {
    key: typeof entry.uuid === 'string' ? entry.uuid : 'no-uuid',
    entry,
    visible: true,
    reason,
  }
}

export function ledgerToFeedItems(
  ledger: RenderLedger,
  ctx: LedgerFeedContext,
): LedgerFeedItemsResult {
  const items: FeedRenderItem[] = []
  const dropped: string[] = []
  let entryOrdinal = 0
  // Semantic rows arrive block-level from the ledger but the legacy row
  // component (SemanticStreamingTurn) renders whole turns — collapse a turn's
  // blocks into ONE item.
  //
  // #442 finding-C6: this used to be a `lastSemanticTurnId` guard that only
  // caught CONSECUTIVE same-turn rows. But a semantic candidate's `sequence`
  // is just its per-turn block index, so two history turns sharing the same
  // `timestampMs` order as A0,B0,A1,B1 — interleaved, not consecutive — and the
  // adjacency guard then emitted turn A (and B) twice. One row per turnId is
  // ALWAYS correct (the row renders the whole turn), so re-emission is always a
  // bug: track every emitted turnId in a set, not just the previous one. No
  // resets on entry/process rows are needed — a turn is emitted at most once
  // for the whole feed.
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
        items.push({
          type: 'entry',
          key: `entry:${uuid}`,
          entry,
          visibleDecision: visibleDecisionFor(entry),
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
        const turn = ctx.turnsById.get(turnId)
        if (!turn) {
          dropped.push(c.id)
          break
        }
        emittedTurnIds.add(turnId)
        if (c.owner === 'semantic-current') {
          items.push({
            type: 'semantic-current',
            key: `semantic:${turnId}`,
            turn,
            order: orderAt(items.length, 'content'),
          })
        } else {
          items.push({
            type: 'semantic-history',
            key: `semantic-history:${turnId}`,
            turn,
            order: orderAt(items.length, 'content'),
          })
        }
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

  return { items, dropped }
}
