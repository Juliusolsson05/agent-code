import type { GhostEntry } from 'agent-transcript-parser/ghost'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { SemanticLiveTurn } from '@renderer/workspace/workspaceState'
import type { GhostPredicateContext } from '@renderer/rendering/model/ghostPredicate'
import type { GhostLedgerCandidate, LedgerInput } from '@renderer/rendering/model/ledger'
import type { OwnershipDecision, RenderCandidate } from '@renderer/rendering/model/types'
import {
  collectCommittedCandidates,
  type RawCommittedEntry,
} from '@renderer/rendering/observations/committed'
import { collectGhostCandidates, type GhostLike } from '@renderer/rendering/observations/ghosts'
import {
  collectLifecycleCandidates,
  collectOptimisticCandidates,
  type OptimisticPromptLike,
} from '@renderer/rendering/observations/local'
import {
  collectSemanticCandidates,
  type SemanticBlockLike,
  type SemanticTurnLike,
} from '@renderer/rendering/observations/semantic'

// ---------------------------------------------------------------------------
// The runtime → collector adapter — THE shadow seam.
//
// This is the single module that vouches the real SessionRuntime shapes
// satisfy the collectors' structural types. Stage 2 shadow mode calls
// `adapter(slices)` beside the legacy renderer and diffs the two outputs;
// Stage 3 cutover makes this the only path. Everything above this file
// (collectors, ledger, predicate) stays hand-fixture-testable JSON; every
// runtime-specific quirk — record-shaped semantic blocks, optimistic rows
// embedded in `entries`, ghost `_atp` metadata — is absorbed HERE and
// nowhere else.
//
// REFERENCE STABILITY (plan D11) is enforced per PLANE, matching the
// runtime's own discipline: each runtime slice (entries array, semantic
// current/history, ghost map) only changes reference when its reducer
// really changed it, so caching per-plane on those references composes
// with the ledger's own last-call cache into "no real change ⇒ same
// LedgerInput fields ⇒ same RenderLedger object". A single whole-input
// cache would lose this: one plane changing would rebuild every plane's
// candidate arrays and bust the downstream memo for all of them.
// ---------------------------------------------------------------------------

/**
 * Runtime semantic turn shape: blocks live in a Record keyed by index with
 * a separate blockOrder (streaming deltas arrive out of order; the reducer
 * needs O(1) block addressing). The collectors take ordered arrays because
 * fixtures are far more readable that way — this translation is the tax,
 * paid once per turn-reference change.
 */
export type RuntimeSemanticTurn = {
  turnId: string
  source: string | null
  text?: string
  blocks: Record<number, SemanticBlockLike & { blockIndex: number }>
  blockOrder: number[]
  startedAt: number
  endedAt: number | null
  isCompactionSynthesis?: boolean
}

export type RuntimeLedgerSlices = {
  provider: AgentProviderKind
  sessionId: string
  /** runtime.entries — committed JSONL rows PLUS embedded optimistic rows
   *  (uuid prefix `optimistic-codex-user:`), which this adapter partitions
   *  back out into the optimistic plane. */
  entries: readonly RawCommittedEntry[]
  semanticCurrent: RuntimeSemanticTurn | null
  semanticHistory: readonly RuntimeSemanticTurn[]
  ghosts: ReadonlyMap<string, GhostLike>
  streamPhase: string
  lastJsonlEntryAtMs: number | null
}

export type LedgerInputBundle = {
  input: LedgerInput
  /** Rejections made at COLLECTION time (hidden meta rows, compaction-
   *  synthesis kills, duplicate-turn drops). The ledger's own decisions
   *  cover only what reached it; the shadow diff and debug bundles need
   *  BOTH halves to explain every raw artifact — that is the ledger=paint=
   *  debug promise (plan D5). */
  collectorDecisions: readonly OwnershipDecision[]
}

/** Shared optimistic-row marker. Codex-named for history (it shipped for
 *  Codex first) but provider-neutral: every echo provider's submit path
 *  mints this prefix. Source of truth: workspace/hook/actions/streaming.ts. */
const OPTIMISTIC_UUID_PREFIX = 'optimistic-codex-user:'

function toTurnLike(turn: RuntimeSemanticTurn): SemanticTurnLike {
  return {
    turnId: turn.turnId,
    source: turn.source ?? undefined,
    text: turn.text,
    startedAtMs: turn.startedAt,
    endedAtMs: turn.endedAt,
    isCompactionSynthesis: turn.isCompactionSynthesis,
    blocks: turn.blockOrder
      .map(i => turn.blocks[i])
      .filter((b): b is SemanticBlockLike & { blockIndex: number } => b != null),
  }
}

function optimisticTextOf(entry: RawCommittedEntry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const t = content.find(b => (b as { type?: string })?.type === 'text') as
      | { text?: unknown }
      | undefined
    if (typeof t?.text === 'string') return t.text
  }
  return ''
}

function entryTimestampMs(entry: RawCommittedEntry): number | null {
  if (typeof entry.timestamp === 'number') return entry.timestamp
  if (typeof entry.timestamp === 'string') {
    const ms = Date.parse(entry.timestamp)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

// ---------------------------------------------------------------------------
// Compile-time seam checks. TYPE-ONLY imports of the real runtime types —
// the rendering pipeline still has zero runtime dependency on the legacy
// system; these exist so `tsc` (the merge gate) fails the moment a runtime
// type drifts away from the structural shapes this adapter vouches for,
// instead of the drift surfacing as a shadow-diff mystery weeks later.
// Both target types are KEEP-fated in the deletion manifest, so these
// edges survive Stage 3.
// ---------------------------------------------------------------------------
type AssertAssignable<A extends B, B> = A extends B ? true : never
type _SemanticTurnSeam = AssertAssignable<SemanticLiveTurn, RuntimeSemanticTurn>
type _GhostSeam = AssertAssignable<GhostEntry, GhostLike>

export function createLedgerInputAdapter(): (slices: RuntimeLedgerSlices) => LedgerInputBundle {
  // Per-plane last-call caches. Keys are the RUNTIME slice references the
  // plane reads — nothing else. A plane recomputes iff its own inputs
  // moved; all other planes hand back the previous arrays by reference.
  let committedCache: {
    entries: readonly RawCommittedEntry[]
    provider: AgentProviderKind
    committed: readonly RenderCandidate[]
    optimistic: readonly RenderCandidate[]
    decisions: readonly OwnershipDecision[]
  } | null = null
  let liveCache: {
    current: RuntimeSemanticTurn | null
    history: readonly RuntimeSemanticTurn[]
    provider: AgentProviderKind
    candidates: readonly RenderCandidate[]
    decisions: readonly OwnershipDecision[]
    ownedTurnIds: ReadonlySet<string>
  } | null = null
  let ghostCache: {
    ghosts: ReadonlyMap<string, GhostLike>
    provider: AgentProviderKind
    candidates: readonly GhostLedgerCandidate[]
  } | null = null
  let staticsCache: {
    streamPhaseIdle: boolean
    hasContentCandidates: boolean
    provider: AgentProviderKind
    candidates: readonly RenderCandidate[]
  } | null = null
  // The live plane the ledger sees = semantic candidates + optimistic rows
  // (both are "live" trust tier). Memoized on BOTH source references —
  // without this the spread below would mint a fresh array every call
  // whenever an optimistic row exists, silently breaking the identity
  // contract exactly during prompt submission, the hottest repaint window.
  let mergedLiveCache: {
    semantic: readonly RenderCandidate[]
    optimistic: readonly RenderCandidate[]
    merged: readonly RenderCandidate[]
  } | null = null
  let lastBundle: { input: LedgerInput; bundle: LedgerInputBundle } | null = null

  return slices => {
    const { provider, sessionId } = slices

    if (
      !committedCache ||
      committedCache.entries !== slices.entries ||
      committedCache.provider !== provider
    ) {
      // Partition BEFORE the committed collector: optimistic rows are
      // provisional local state that happens to live in `entries` (the
      // legacy runtime appends them there so the old fixed-plane renderer
      // would paint them). Routing them through the committed plane would
      // hand them committed-grade trust — they would SUPPRESS the live
      // stream instead of being reconciled against it.
      const committedRows: RawCommittedEntry[] = []
      const optimisticRows: OptimisticPromptLike[] = []
      for (const e of slices.entries) {
        if (e.uuid?.startsWith(OPTIMISTIC_UUID_PREFIX)) {
          optimisticRows.push({
            uuid: e.uuid,
            text: optimisticTextOf(e),
            submittedAtMs: entryTimestampMs(e),
          })
        } else {
          committedRows.push(e)
        }
      }
      const collected = collectCommittedCandidates(committedRows, provider, sessionId)
      committedCache = {
        entries: slices.entries,
        provider,
        committed: collected.candidates,
        optimistic: collectOptimisticCandidates(optimisticRows, provider, sessionId),
        decisions: collected.decisions,
      }
    }

    if (
      !liveCache ||
      liveCache.current !== slices.semanticCurrent ||
      liveCache.history !== slices.semanticHistory ||
      liveCache.provider !== provider
    ) {
      const collected = collectSemanticCandidates(
        slices.semanticCurrent ? toTurnLike(slices.semanticCurrent) : null,
        slices.semanticHistory.map(toTurnLike),
        provider,
        sessionId,
      )
      // Ghost rule 3's context set, derived here because it reads exactly
      // this plane's inputs — and cached WITH the plane so its reference
      // only moves when the semantic plane really moved (the ledger cache
      // compares this set by reference).
      const ownedTurnIds = new Set<string>(
        [slices.semanticCurrent?.turnId, ...slices.semanticHistory.map(t => t.turnId)].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      )
      liveCache = {
        current: slices.semanticCurrent,
        history: slices.semanticHistory,
        provider,
        candidates: collected.candidates,
        decisions: collected.decisions,
        ownedTurnIds,
      }
    }

    if (!ghostCache || ghostCache.ghosts !== slices.ghosts || ghostCache.provider !== provider) {
      ghostCache = {
        ghosts: slices.ghosts,
        provider,
        candidates: collectGhostCandidates(slices.ghosts, provider, sessionId),
      }
    }

    // Statics key off two BOOLEANS, not references — 'work' and 'empty'
    // candidates have no per-tick content, so any tick with the same two
    // flags gets the previous array back and the feed's tail rows keep
    // their identity across the whole stream.
    const streamPhaseIdle = slices.streamPhase === 'idle'
    const hasContentCandidates =
      committedCache.committed.length > 0 ||
      committedCache.optimistic.length > 0 ||
      liveCache.candidates.length > 0 ||
      ghostCache.candidates.length > 0
    if (
      !staticsCache ||
      staticsCache.streamPhaseIdle !== streamPhaseIdle ||
      staticsCache.hasContentCandidates !== hasContentCandidates ||
      staticsCache.provider !== provider
    ) {
      staticsCache = {
        streamPhaseIdle,
        hasContentCandidates,
        provider,
        candidates: collectLifecycleCandidates({
          provider,
          sessionId,
          streamPhaseIdle,
          hasContentCandidates,
        }),
      }
    }

    const ghostContext: GhostPredicateContext = {
      lastJsonlEntryAtMs: slices.lastJsonlEntryAtMs,
      semanticOwnedTurnIds: liveCache.ownedTurnIds,
    }

    if (
      !mergedLiveCache ||
      mergedLiveCache.semantic !== liveCache.candidates ||
      mergedLiveCache.optimistic !== committedCache.optimistic
    ) {
      mergedLiveCache = {
        semantic: liveCache.candidates,
        optimistic: committedCache.optimistic,
        merged:
          committedCache.optimistic.length > 0
            ? [...liveCache.candidates, ...committedCache.optimistic]
            : liveCache.candidates,
      }
    }
    const live = mergedLiveCache.merged

    // Final assembly: if every plane cache hit AND the scalars match, the
    // previous bundle IS the answer — same object, so callers can `===`
    // the bundle itself, not just its fields. (The ledger's own cache
    // would also catch this via field comparison; returning the same
    // bundle just makes the adapter honor the same contract it demands.)
    if (
      lastBundle &&
      lastBundle.input.provider === provider &&
      lastBundle.input.committed === committedCache.committed &&
      lastBundle.input.live === live &&
      lastBundle.input.statics === staticsCache.candidates &&
      lastBundle.input.ghosts === ghostCache.candidates &&
      lastBundle.input.ghostContext?.lastJsonlEntryAtMs === slices.lastJsonlEntryAtMs &&
      lastBundle.input.ghostContext?.semanticOwnedTurnIds === liveCache.ownedTurnIds
    ) {
      return lastBundle.bundle
    }

    const input: LedgerInput = {
      provider,
      committed: committedCache.committed,
      live,
      statics: staticsCache.candidates,
      unknowns: [],
      ghosts: ghostCache.candidates,
      ghostContext,
    }
    const bundle: LedgerInputBundle = {
      input,
      collectorDecisions: [...committedCache.decisions, ...liveCache.decisions],
    }
    lastBundle = { input, bundle }
    return bundle
  }
}
