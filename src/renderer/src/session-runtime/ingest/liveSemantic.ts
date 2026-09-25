import type { SessionKind } from '@shared/types/providerKind'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { SemanticRuntimeState } from '@renderer/session-runtime/state'

// One live semantic event → the next fold state and stream phase (#1177).
//
// WHY a shared step for two function calls: the ORDER and the routing are
// the contract, and three clients (the desktop fold, the phone store, the
// replay harness) each re-typed them. Fold first, then the phase machine on
// the POST-fold turn; `prompt_suggestion` routed AROUND both, because it is a
// next-prompt hint, not a turn (#174). foldSemanticEvent also refuses it on
// its own as defense in depth, but only the step makes the routing visible
// to a caller that has a surface for it (the desktop's suggestion chip) and
// lets every other caller skip the phase reduction for it. The desktop
// threads its session run id through; the phone and replay have none.
// Whatever a client does AROUND the step (the desktop's ghost bridge,
// optimistic awaiting flag, suggestion chip) stays that client's.

export type LiveSemanticStep =
  /** The event is not a turn event and must not enter the fold. The caller
   *  applies it through its own surface (the desktop's suggestion chip) or
   *  ignores it (the phone has no such surface). */
  | { kind: 'out-of-band'; type: 'prompt_suggestion' }
  | { kind: 'folded'; semantic: SemanticRuntimeState; phase: StreamPhaseState }

export function stepLiveSemantic(
  semantic: SemanticRuntimeState,
  phase: StreamPhaseState,
  event: Record<string, unknown>,
  sessionKind: SessionKind,
  sessionRunId?: string | null,
): LiveSemanticStep {
  if (event.type === 'prompt_suggestion') return { kind: 'out-of-band', type: 'prompt_suggestion' }
  const nextSemantic = foldSemanticEvent(semantic, event, sessionKind, sessionRunId)
  // reduceStreamPhase's caller contract: run AFTER the fold, on the POST-fold
  // current turn (see streamPhaseMachine.ts).
  return {
    kind: 'folded',
    semantic: nextSemantic,
    phase: reduceStreamPhase(phase, event, nextSemantic.currentTurn),
  }
}
