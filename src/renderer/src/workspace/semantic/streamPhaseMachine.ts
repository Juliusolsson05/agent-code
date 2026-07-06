import type { SemanticLiveTurn, StreamPhase } from '@renderer/workspace/workspaceState'
import { hasPendingSemanticTools } from '@renderer/workspace/semantic/helpers'

// The stream-phase machine — the in-feed WorkIndicator's state, reduced from
// semantic events OUTSIDE foldSemanticEvent (the phase lives on
// SessionRuntime, not SemanticRuntimeState; folding it in would be a
// layering violation — see the original inline comment in
// useIpcSubscriptions, where this logic lived until 2026-07-06).
//
// WHY this is a standalone pure reducer: the remote phone client runs the
// SAME machine over the same wire events (TranscriptStore), and its first
// implementation was a hand-copied fork that silently diverged in three
// places (review finding). One reducer, two callers — the desktop hook and
// the phone store — makes divergence impossible instead of merely reviewed
// against.
//
// Caller contract: run AFTER foldSemanticEvent and pass the POST-fold
// currentTurn — the turn_completed guard consults the folded turn's pending
// tools. Compare fields against the previous state to detect change; the
// reducer always returns a fresh object.

export type StreamPhaseState = {
  streamPhase: StreamPhase
  streamPhasePendingToolName: string | null
  streamPhasePendingToolUseId: string | null
  turnStartedAt: number | null
  phaseChangedAt: number | null
  /** Stamped by the desktop's optimistic-submit path; the phone has no
   *  optimistic submit and always passes null. Preferred over `now` for
   *  turnStartedAt so the elapsed counter includes the submit→first-event
   *  gap. */
  submittedAt: number | null
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

export function reduceStreamPhase(
  prev: StreamPhaseState,
  semanticEvent: Record<string, unknown>,
  postFoldCurrentTurn: SemanticLiveTurn | null,
): StreamPhaseState {
  const eventType = typeof semanticEvent.type === 'string' ? semanticEvent.type : ''

  let streamPhase = prev.streamPhase
  let streamPhasePendingToolName = prev.streamPhasePendingToolName
  let streamPhasePendingToolUseId = prev.streamPhasePendingToolUseId
  let turnStartedAt = prev.turnStartedAt
  let phaseChangedAt = prev.phaseChangedAt
  let submittedAt = prev.submittedAt

  if (eventType === 'stream_phase') {
    const rawPhase = typeof semanticEvent.phase === 'string' ? semanticEvent.phase : 'idle'
    const nextPhase = rawPhase as StreamPhase
    if (nextPhase !== streamPhase) {
      const now = Date.now()
      streamPhase = nextPhase
      streamPhasePendingToolName = stringField(semanticEvent, 'toolName')
      streamPhasePendingToolUseId = stringField(semanticEvent, 'toolUseId')
      phaseChangedAt = now
      if (nextPhase === 'idle') {
        turnStartedAt = null
        submittedAt = null
      } else if (turnStartedAt === null) {
        // First non-idle phase of this turn — stamp the start time. If the
        // optimistic-submit path already stamped `submittedAt`, prefer it
        // over `now` so the elapsed counter includes the gap between submit
        // and first adapter event.
        turnStartedAt = submittedAt ?? now
      }
    } else if (
      // Re-assign pending tool info even on same-phase re-emit (turnId
      // upgrade: null → real id is the classic case).
      streamPhase !== 'idle'
    ) {
      streamPhasePendingToolName =
        stringField(semanticEvent, 'toolName') ?? streamPhasePendingToolName
      streamPhasePendingToolUseId =
        stringField(semanticEvent, 'toolUseId') ?? streamPhasePendingToolUseId
    }
  } else if (eventType === 'tool_result') {
    // Tool result arrived. If it matches the pending tool we're
    // `awaiting-tool` on, move to a neutral 'requesting' phase so the
    // indicator doesn't sit amber after the tool returned. The adapter's
    // next stream_phase event (from the next assistant flow's
    // message_start) will overwrite; this is the gap-filler.
    const resultToolUseId = stringField(semanticEvent, 'toolUseId')
    if (
      streamPhase === 'awaiting-tool' &&
      resultToolUseId !== null &&
      resultToolUseId === streamPhasePendingToolUseId
    ) {
      streamPhase = 'requesting'
      streamPhasePendingToolName = null
      streamPhasePendingToolUseId = null
      phaseChangedAt = Date.now()
    }
  } else if (eventType === 'turn_started') {
    // Turn-based phase bridge (2026-07-06, provider-agnostic gap-filler).
    // WHY: the phase machine used to advance ONLY on `stream_phase` events,
    // which opencode's headless does not emit. The 2026-07-06 opencode
    // bundle showed the consequence: phaseChangedAt == submittedAt with 258
    // deltas flowing — the pane sat pinned at the optimistic 'submitting'
    // pseudo-phase for the whole turn, and the awaitingAssistant safety net
    // in the bootstrap-complete reconciler was ALSO deadlocked on it (its
    // predicate requires streamPhase === 'idle' to fire, and idle could
    // never arrive). Turn lifecycle events are the provider-neutral signal
    // every semantic adapter already emits, so bridge from them.
    //
    // Claude/codex are unaffected in practice: their adapters emit real
    // stream_phase events which continue to overwrite this bridge on the
    // very next event. We only FILL gaps — advance out of the pre-response
    // phases ('submitting'/'requesting'); never stomp
    // 'responding'/'awaiting-tool' state a real stream_phase event
    // established.
    if (streamPhase === 'submitting' || streamPhase === 'requesting') {
      const now = Date.now()
      streamPhase = 'responding'
      phaseChangedAt = now
      if (turnStartedAt === null) {
        // Mirror the stream_phase branch: prefer the optimistic submittedAt
        // so the elapsed counter includes the submit→first-event gap.
        turnStartedAt = submittedAt ?? now
      }
    }
  } else if (eventType === 'turn_completed') {
    // Second half of the turn-based bridge: return to 'idle' when the turn
    // is over and nothing is pending. Guards:
    //   - 'awaiting-tool' is itself pending tool state at the phase-machine
    //     level (codex MCP: turn_completed arrives while the client tool
    //     still owes its output in the NEXT turn) — never idle out of it
    //     here.
    //   - hasPendingSemanticTools on the post-fold turn covers the same
    //     lifecycle when the phase machine hasn't caught up (fold keeps an
    //     ended pending-tool turn mounted).
    // For claude/codex the adapter's own stream_phase 'idle' arrives around
    // the same moment and would produce the same state, so this is a no-op
    // for them beyond ordering.
    const pendingTool =
      streamPhase === 'awaiting-tool' ||
      (postFoldCurrentTurn !== null && hasPendingSemanticTools(postFoldCurrentTurn))
    if (!pendingTool && streamPhase !== 'idle') {
      streamPhase = 'idle'
      streamPhasePendingToolName = null
      streamPhasePendingToolUseId = null
      phaseChangedAt = Date.now()
      turnStartedAt = null
      submittedAt = null
    }
  }

  return {
    streamPhase,
    streamPhasePendingToolName,
    streamPhasePendingToolUseId,
    turnStartedAt,
    phaseChangedAt,
    submittedAt,
  }
}
