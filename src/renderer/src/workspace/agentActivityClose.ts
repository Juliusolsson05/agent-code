import type { SessionRuntime } from '@renderer/session-runtime/state'
import { closeGrantedSessions } from '@renderer/workspace/bulkClose'
import type { BulkCloseSession } from '@renderer/workspace/bulkClose'
import {
  describePartialClose,
  isSessionLiveForClose,
  summarizeCloseTargets,
} from '@renderer/workspace/closeConfirmation'
import type {
  CloseConfirmationRequest,
  CloseTargetSnapshot,
  PartialCloseOutcome,
} from '@renderer/workspace/closeConfirmation'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// Closing the agents the user selected in Agent Activity (#1170, Stage 4).
//
// The third bulk surface. It routes through closeGrantedSessions like Close Old
// Agents and Close Idle Orchestration Agents, rather than looping
// `closeSession`, because that loop is where #886's guarantees live: the grant
// is the list the user saw, every kill re-judges its target at the kill
// boundary, owners close after what they own, and one failure does not
// abandon the rest. A raw loop here would be a fourth copy of destructive
// safety code that no test compares with the other three.
//
// Dependencies are arguments, as in idleOrchestrationAgents.ts, so the
// renderer test drives the REAL executor with a scripted dialog and
// useWorkspace only wires it.
// ---------------------------------------------------------------------------

type Runtimes = Record<SessionId, SessionRuntime>

/** What the user saw for one selected row: its id and the name on the row. */
export type AgentActivitySelection = { sessionId: SessionId; name: string }

export type AgentActivityCloseDeps = {
  /** Live workspace state (the action's refs, not a render snapshot). */
  readState: () => WorkspaceState
  readRuntimes: () => Runtimes
  closeSession: BulkCloseSession
  confirm: (request: Extract<CloseConfirmationRequest, { required: true }>) => Promise<boolean>
  showToast: (message: string, durationMs?: number) => void
}

function inWindow(state: WorkspaceState, sessionId: SessionId): boolean {
  return state.tabs.some(tab => resolveTabSessions(state, tab.id).includes(sessionId))
}

/**
 * The per-kill re-derivation for closeGrantedSessions' `onlyIf`: synchronous,
 * argument-only, as that contract requires.
 *
 * WHY the only condition is "still here": unlike the other two bulk surfaces,
 * this one has no FILTER to re-check. The user picked each row by hand, from
 * any section — including a working agent they chose to stop. The executor
 * still refuses a target that was idle at approval and is working now
 * (`!current.live || target.live`), which is the one change the user did not
 * approve.
 */
export function currentAgentActivityCloseTarget(
  state: WorkspaceState,
  runtimes: Runtimes,
  sessionId: SessionId,
): CloseTargetSnapshot | null {
  if (!state.sessions[sessionId] || !inWindow(state, sessionId)) return null
  // The title is not re-derived: the executor compares liveness only, and the
  // name the user approved is the one the confirmation already showed.
  return { sessionId, title: sessionId, live: isSessionLiveForClose(runtimes, sessionId) }
}

function agentsNoun(count: number): string {
  return count === 1 ? 'agent' : 'agents'
}

/**
 * Confirm the selection, then close it. Returns the outcome, or null when
 * nothing was attempted (empty selection, or the user declined).
 *
 * WHY it always asks, even for one row: the per-close dialog waves an idle
 * single close through because the user aimed ⌘W at a pane they can see, with
 * Undo Close behind them. A bulk close records no undo entry (captureUndo is
 * off in the executor, so a purge cannot evict the user's own close history),
 * so the confirmation is the only chance to back out.
 */
export async function closeAgentActivitySelection(
  selection: readonly AgentActivitySelection[],
  deps: AgentActivityCloseDeps,
): Promise<PartialCloseOutcome | null> {
  const state = deps.readState()
  const runtimes = deps.readRuntimes()
  // Rows that vanished between selecting and pressing ⌫ are dropped here,
  // before the dialog, so the count the user confirms is the count that can
  // actually close.
  const granted: CloseTargetSnapshot[] = selection
    .filter(item => state.sessions[item.sessionId] && inWindow(state, item.sessionId))
    .map(item => ({
      sessionId: item.sessionId,
      title: item.name,
      live: isSessionLiveForClose(runtimes, item.sessionId),
    }))
  if (granted.length === 0) return null

  const confirmed = await deps.confirm({
    required: true,
    reason: 'multi',
    targets: granted,
    summary: `Close ${granted.length} ${agentsNoun(granted.length)}? ${summarizeCloseTargets(granted)}`,
  })
  if (!confirmed) return null

  const outcome = await closeGrantedSessions({
    granted,
    // Read after the dialog: only the ownership edges are used, for ordering.
    sessions: deps.readState().sessions,
    closeSession: deps.closeSession,
    currentTarget: currentAgentActivityCloseTarget,
    killCaller: 'bulk.agent-activity',
  })
  deps.showToast(
    describePartialClose(outcome) ?? `Closed ${outcome.closed.length} ${agentsNoun(outcome.closed.length)}.`,
    6000,
  )
  return outcome
}
