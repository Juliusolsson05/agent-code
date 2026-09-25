import type { Entry } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { TranscriptEntryMapper } from '@shared/types/providerConfig'
import { asRecord } from '@shared/lib/asRecord'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState } from '@renderer/session-runtime/state'
import { stepLiveSemantic } from '@renderer/session-runtime/ingest/liveSemantic'
import {
  admitMappedEntries,
  latestCommittedTimestamp,
  type CommittedSeenLedger,
} from '@renderer/session-runtime/ingest/committedRecords'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import {
  ghostsFromSemanticTurn,
  reconcileUpstream,
} from '@renderer/session-runtime/ghosts'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { RuntimeLedgerSlices } from '@renderer/rendering/adapter/collectLedgerInput'

// ---------------------------------------------------------------------------
// The replay fold — turn a recorded SessionFeed event stream back into the
// `RuntimeLedgerSlices` the rendering pipeline consumes, tick by tick.
//
// WHY this file exists, and the fidelity level it achieves (read this before
// changing anything here):
//
// A recording captures the 9 SessionFeed IPC channels verbatim (see the
// recorder in src/main/recording/). The rendering pipeline, however, does NOT
// consume those events — it consumes `RuntimeLedgerSlices`, which the live
// renderer's fold (`useIpcSubscriptions`, ~1985 lines) produces from those
// events. So a replay MUST re-derive the slices from the events. There are two
// ways to do that, and the plan (§1, §6) and the seam research
// (docs/rendering/research-2026-07/rec-research-seam.md §4) disagree on which:
//
//   • Option B (plan's ideal): drive the REAL React fold hook. Rejected here
//     for a hard, structural reason — the required verify gate runs the
//     `unit` vitest project, which is `environment: 'node'` and EXCLUDES
//     `*.renderer.test.ts`. The fold is a React hook that only runs under the
//     `renderer` project (happy-dom + @testing-library). It is also entangled
//     with a 1000ms `setInterval` orphan sweep,
//     module-level session maps, and direct `Date.now()` reads with no
//     injection seam. Driving it faithfully in a node unit test is not
//     possible without adding a clock seam to runtime code (which the task
//     forbids) and a full DOM/timer/window.api harness.
//
//   • Option A' (what this implements): reconstruct the slices by RE-RUNNING
//     THE SAME PURE LEAF REDUCERS the fold calls, in the same composition.
//     This is NOT a second fold reimplementation — every state transition that
//     matters to the ledger is delegated to the production reducer:
//       - semantic turn structure    → foldSemanticEvent   (session-runtime/semantic/foldEvent.ts)
//       - stream phase               → reduceStreamPhase   (session-runtime/semantic/streamPhaseMachine.ts)
//       - ghost bridge from semantic → ghostsFromSemanticTurn (session-runtime/ghosts.ts)
//       - ghost→committed handoff    → reconcileUpstream    (session-runtime/ghosts.ts)
//       - raw JSONL line → Entry     → the provider's real TranscriptEntryMapper
//       - committed admission + the lastJsonlEntryAt cursor, and the
//         fold→phase step → session-runtime/ingest/ (#1177), shared with the
//         desktop fold AND the phone store, so all three agree by construction
//     Only the thin ORCHESTRATION glue (entries append, exit teardown) is
//     re-expressed here, mirrored from the corresponding sites in
//     useIpcSubscriptions.ts and kept deliberately faithful.
//
// FIDELITY STATEMENT (honest): this replay is REDUCER-FAITHFUL and
// ORCHESTRATION-MIRRORED. It exercises the real semantic fold, phase machine,
// ghost bridge, ghost reconciliation and transcript mappers — the leaf logic
// where nearly all render bugs live. It does NOT exercise: the fold's
// setRuntimes batching, the 1000ms orphan-sweep timer (gcSupersededGhosts on a
// wall-clock cadence — event-less, so unrepresentable in an event replay), the
// provider-id quarantine (`decideJsonlProviderBurst`), the Claude queue-op
// reconstruction, or the optimistic-user reconciliation — those are omitted
// from this glue because they either need module-level cross-session state or
// are not on the render-slice path for the recordings this harness targets.
// A bug that lives ONLY in that omitted glue (and not in a leaf reducer) is out
// of scope for this replay; the plan's Option-B full-fold replay would be its
// home, and it can only be built once the pipeline moves off the React hook.
//
// THE D11 PAYOFF — why reusing the real reducers is not just convenient but
// load-bearing for the identity contract:
//
// The adapter caches each plane on the RUNTIME SLICE REFERENCE (===), and the
// ledger caches on the LedgerInput array references (model/ledger.ts:129-145).
// Reproducing that "unchanged plane ⇒ same object reference" pattern is the
// whole point of an invariant replay (plan §6 Mode 2, invariant 4). The seam
// research warned that a naive snapshot-per-tick recording loses it, because
// JSON round-trip mints a fresh reference for every slice every tick, making
// every plane look changed (rec-research-seam.md §4). We sidestep that entirely
// because we hold ONE running state object across ticks and mutate a field's
// reference ONLY when its production reducer actually changed it — and those
// reducers are all reference-stable on no-op BY CONTRACT (foldSemanticEvent
// returns `state` unchanged, ghostsFromSemanticTurn/reconcileUpstream return
// `prev`, and we only allocate a new `entries` array on a real append). So a
// no-op tick (e.g. a `session:screen` frame, or a `usage_updated` semantic
// event) hands back every slice field by the SAME reference as the prior tick,
// the adapter's plane caches all hit, and the ledger returns its previous
// object — exactly as production does. The reference pattern is faithful by
// construction, no content-pool needed.
// ---------------------------------------------------------------------------

/** The 9 real SessionFeed channels (see src/shared/sessionFeed/types.ts).
 *  Synthetic `__note` / `__truncated` lines are NOT here — replay ignores them
 *  for pipeline input (plan §7b). */
export type FeedChannel =
  | 'session:started'
  | 'session:screen'
  | 'session:jsonl-entries'
  | 'session:jsonl-error'
  | 'session:history-boundary'
  | 'session:semantic-event'
  | 'session:conditions'
  | 'session:process-state'
  | 'session:sub-agents'
  | 'session:exit'

/** Running reconstruction state for ONE session's replay. Mutated in place by
 *  `applyFeedEvent`; each field's reference is replaced only when its reducer
 *  changed it, so `slicesFromState` composes with the adapter's D11 caches. */
import { applyDecisionToWindow, decideHistoryBoundary, emptyHistoryWindow, type HistoryWindow } from '../../session-runtime/historyBoundary.js'
export type ReplayFoldState = {
  /** History-boundary window identity (grok Stage 5). Owned by the pure
   *  decisions in session-runtime/historyBoundary.ts; replay applies the same
   *  decisions the live clients do or recordings diverge from production. */
  historyWindow: HistoryWindow
  /** True after an applied reset until a fresh turn_started arrives — the
   *  semantic fold drops suffixes meanwhile (the phone's gate, shared). */
  awaitingSemanticStart: boolean
  readonly provider: AgentProviderKind
  readonly sessionId: string
  /** Persistent per session so the (Codex) rolling turn cursor survives across
   *  bursts — the live fold does the same via `codexCurrentTurnIdBySession`
   *  (useIpcSubscriptions.ts:1366-1375). Claude's mapper is stateless. */
  readonly mapper: TranscriptEntryMapper
  /** Dedup set, mirroring the fold's `seenUuidsRef` (useIpcSubscriptions.ts:1303). */
  readonly seenUuids: Set<string>
  /** Committed plane. New array reference ONLY on a real append. */
  entries: Entry[]
  /** Folded via the real foldSemanticEvent — reference-stable on no-op. */
  semantic: SemanticRuntimeState
  /** Ghost map — from ghostsFromSemanticTurn + reconcileUpstream (both
   *  reference-stable on no-op). Typed via the reducer's own return type so
   *  we never need to import the GhostEntry nominal type. */
  ghosts: ReturnType<typeof ghostsFromSemanticTurn>
  /** Stream-phase machine state. reduceStreamPhase always returns a fresh
   *  object, but only the `streamPhase` STRING feeds the ledger (value-compared
   *  by the adapter/ledger), so a same-phase tick is still a ledger no-op. */
  phase: StreamPhaseState
  /** Newest observed JSONL entry timestamp — ghost predicate rule 4 gate
   *  (useIpcSubscriptions.ts:1611-1620). Derived from entry.timestamp, never
   *  the wall clock, so it is deterministic from the recording. */
  lastJsonlEntryAt: number | null
  /** Tracked for completeness (process-state affects it) but NOT a ledger
   *  slice, so a process-state event is a ledger no-op tick — useful precisely
   *  for exercising the D11 reference-stability invariant. */
  processActive: boolean
}

const IDLE_PHASE: StreamPhaseState = {
  streamPhase: 'idle',
  streamPhasePendingToolName: null,
  streamPhasePendingToolUseId: null,
  turnStartedAt: null,
  phaseChangedAt: null,
  submittedAt: null,
}

export function createReplayFoldState(
  provider: AgentProviderKind,
  sessionId: string,
): ReplayFoldState {
  return {
    provider,
    sessionId,
    mapper: getRendererProviderCapabilities(provider).createTranscriptEntryMapper(null),
    seenUuids: new Set(),
    entries: [],
    semantic: emptySemanticRuntime(),
    ghosts: new Map(),
    phase: IDLE_PHASE,
    lastJsonlEntryAt: null,
    processActive: false,
    historyWindow: emptyHistoryWindow(),
    awaitingSemanticStart: false,
  }
}

/**
 * Apply one recorded SessionFeed event to the running state, mirroring the
 * corresponding handler in useIpcSubscriptions.ts. Mutates `state` in place.
 *
 * Only the rendering-relevant channels move any state; the rest
 * (started/screen/conditions/sub-agents/jsonl-error) are intentional no-ops
 * for the ledger and therefore produce D11-stable ticks.
 */
export function applyFeedEvent(
  state: ReplayFoldState,
  channel: FeedChannel,
  payload: unknown,
): void {
  const p = asRecord(payload) ?? {}
  switch (channel) {
    case 'session:history-boundary': {
      // Replay must consume boundaries exactly like production: the shared
      // pure owner decides, the fold state applies (wipe window, await a fresh
      // turn). Without this case a recorded reset would replay as a no-op and
      // the snapshot rows would dedup against pre-reset seen uuids.
      const decision = decideHistoryBoundary(state.historyWindow ?? emptyHistoryWindow(), {
        type: p.type === 'caught-up' ? 'caught-up' : 'reset',
        generation: typeof p.generation === 'number' ? p.generation : 0,
        snapshotByteLength: typeof p.snapshotByteLength === 'number' ? p.snapshotByteLength : 0,
        ...(p.byteOffset !== undefined ? { byteOffset: p.byteOffset as number } : {}),
        ...(p.complete !== undefined ? { complete: p.complete as boolean } : {}),
        file: typeof p.file === 'string' ? p.file : '',
      })
      if (decision.kind === 'apply-reset') {
        state.entries.length = 0
        state.seenUuids.clear()
        state.semantic = emptySemanticRuntime()
        state.awaitingSemanticStart = true
      }
      state.historyWindow = applyDecisionToWindow(state.historyWindow ?? emptyHistoryWindow(), decision)
      return
    }
    case 'session:jsonl-entries': {
      // Mirror of useIpcSubscriptions Pass B (lines 1300-1620), reduced to the
      // render-slice essentials: map each raw line through the provider mapper,
      // dedup by uuid, append, advance the JSONL-tail cursor, then reconcile
      // ghosts against the freshly-committed entries. The heavy fold machinery
      // we deliberately skip (provider-id quarantine, queue ops, optimistic
      // reconciliation) is documented in the module header.
      const rawEntries = Array.isArray(p.entries)
        ? (p.entries as Array<{ entry?: unknown }>)
        : []
      // Admission is the SHARED live rule (session-runtime/ingest/
      // committedRecords.ts, #1177) — the very function the desktop's Pass B
      // and the phone's store call, so replay cannot drift from either.
      // Replay never trims its window, so no uuid is ever a tombstone here.
      const ledger: CommittedSeenLedger = { seen: state.seenUuids, isTrimmed: () => false, releaseTrimmed: () => {} }
      const appended: Entry[] = []
      for (const item of rawEntries) {
        const raw = asRecord(item?.entry)
        if (!raw) continue
        const { entries: mapped, historyMarker } = state.mapper.map(raw)
        appended.push(...admitMappedEntries(mapped, historyMarker, 'live', ledger).admitted)
      }
      // Reference-stability guard: an all-duplicate / all-filtered burst mints
      // NOTHING, so we must not replace `entries` (that would fake a change and
      // bust the adapter's committed-plane cache on a genuine no-op). This
      // mirrors the fold's own short-circuit discipline.
      if (appended.length === 0) break

      state.entries = [...state.entries, ...appended]
      state.lastJsonlEntryAt = latestCommittedTimestamp(state.lastJsonlEntryAt, appended)

      // Ghost→committed handoff: reconcileUpstream stamps `supersededBy` on any
      // live ghost the new entries replace. Returns `prev` on no-op, so a burst
      // that matched nothing keeps the ghost map reference stable.
      let ghosts = state.ghosts
      for (const e of appended) ghosts = reconcileUpstream(e, ghosts)
      state.ghosts = ghosts
      break
    }

    case 'session:semantic-event': {
      // Mirror of the semantic handler (useIpcSubscriptions.ts:894-975).
      const ev = asRecord(p.event) ?? {}
      // prompt_suggestion is an ephemeral next-prompt hint, NOT a turn — it must
      // never touch semantic state (the #174 leak). Handled out-of-band by the
      // fold; here it is simply a no-op for every ledger slice.
      if (ev.type === 'prompt_suggestion') break

      // The shared history-boundary gate: after an applied reset the window
      // was wiped; stale semantic suffixes from the superseded generation
      // must not repaint it. A fresh turn_started reopens the fold (api_error
      // still passes — it is diagnostic, not turn state).
      if (state.awaitingSemanticStart) {
        if (ev.type === 'turn_started') state.awaitingSemanticStart = false
        else if (ev.type !== 'api_error') break
      }

      // The live semantic step every client runs (ingest/liveSemantic.ts):
      // the real fold, then reduceStreamPhase on the POST-fold turn.
      const step = stepLiveSemantic(state.semantic, state.phase, ev, state.provider)
      if (step.kind === 'out-of-band') break
      const nextSemantic = step.semantic
      state.semantic = nextSemantic
      state.phase = step.phase
      // Ghost bridge from the new semantic turn (idempotent, ref-stable no-op).
      state.ghosts = ghostsFromSemanticTurn(
        nextSemantic.currentTurn,
        state.sessionId,
        state.ghosts,
      )
      break
    }

    case 'session:exit': {
      // Mirror of the exit handler (useIpcSubscriptions.ts:721-772): a dead
      // process cannot own a live turn — clear phase + currentTurn. History and
      // committed entries persist (they are the record of what happened).
      state.phase = IDLE_PHASE
      if (state.semantic.currentTurn !== null) {
        state.semantic = { ...state.semantic, currentTurn: null }
      }
      break
    }

    case 'session:process-state': {
      // Affects processActive only — NOT a ledger slice. Kept for completeness;
      // the tick is a deliberate ledger no-op (drives the D11 invariant).
      state.processActive = p.active === true
      break
    }

    // started / screen / conditions / sub-agents / jsonl-error: no ledger slice
    // moves. Falling through leaves every slice reference untouched, so the
    // resulting tick is D11-stable.
    default:
      break
  }
}

/**
 * Snapshot the running state as the `RuntimeLedgerSlices` the adapter consumes.
 * Builds a FRESH wrapper each tick but populates it with the running state's
 * field references — so the adapter compares field references (not the wrapper)
 * and unchanged planes hit their caches. `SemanticLiveTurn` is compile-time
 * assignable to `RuntimeSemanticTurn`, and `GhostEntry` to `GhostLike` (the
 * `_SemanticTurnSeam` / `_GhostSeam` assertions in collectLedgerInput.ts vouch
 * for both), so no translation is needed here.
 */
export function slicesFromState(state: ReplayFoldState): RuntimeLedgerSlices {
  return {
    provider: state.provider,
    sessionId: state.sessionId,
    entries: state.entries,
    semanticCurrent: state.semantic.currentTurn,
    semanticHistory: state.semantic.history,
    semanticErrors: state.semantic.errors,
    ghosts: state.ghosts,
    streamPhase: state.phase.streamPhase,
    lastJsonlEntryAtMs: state.lastJsonlEntryAt,
  }
}
