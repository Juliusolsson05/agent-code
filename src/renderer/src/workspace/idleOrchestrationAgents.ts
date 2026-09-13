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
import { orchestrationChildLifecycle } from '@renderer/workspace/orchestrationMcp'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

// ---------------------------------------------------------------------------
// Close Idle Orchestration Agents (#960).
//
// Orchestration runs leave finished workers behind as idle Dispatch rows when
// the parent never calls close_run. This module decides which of those workers
// are safe to close and runs the confirm-then-close flow; the destructive loop
// itself is shared with Close Old Agents in bulkClose.ts.
//
// The flow takes its dependencies (state readers, closeSession, the dialog and
// the toast) as arguments rather than reaching for the workspace hook, so the
// renderer test drives it through the REAL close executor with a scripted
// dialog, and useWorkspace only wires it.
// ---------------------------------------------------------------------------

type Runtimes = Record<SessionId, SessionRuntime>

/**
 * Whether the command should be offered at all.
 *
 * WHY metadata only, not placement or idleness: this backs the command's
 * `when`, which the palette evaluates for every command on every render, and
 * idleness scans transcripts. The run re-derives the real target list and says
 * so when nothing is idle, so offering the command for a workspace whose only
 * orchestration child is buried or busy costs one toast, while an exact gate
 * would cost transcript scans on every palette keystroke.
 */
export function hasOrchestrationAgents(state: WorkspaceState): boolean {
  return Object.values(state.sessions).some(meta =>
    Boolean(meta.orchestrationParentId) && isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER))
}

/**
 * Is this session an orchestration worker that has finished and is doing
 * nothing? Placement and coordinator ownership are judged separately.
 *
 * WHY `completed` and not "not live": a worker that has not produced output yet
 * is not idle, it is about to work. `create_agent` spawns the child first and
 * delivers its prompt once the provider is ready, and in that gap every
 * activity signal reads quiet. `completed` requires assistant output, which is
 * also exactly what the PARENT agent is told through `list_agents`/`wait_agents`,
 * so the user's cleanup and the parent's coordination cannot disagree about
 * whether a worker is done.
 *
 * WHY exited and failed workers are excluded: Dispatch paints them `exited` or
 * with an error, not `idle`, and a failure is something the user may want to
 * read before it disappears. Close Old Agents still reaches them.
 */
export function isIdleOrchestrationAgent(
  sessionId: SessionId,
  meta: SessionMeta,
  runtimes: Runtimes,
): boolean {
  if (!meta.orchestrationParentId) return false
  if (!isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) return false
  const runtime = runtimes[sessionId]
  // No runtime means nothing has been observed about this session yet; that
  // proves nothing about it being finished.
  if (!runtime) return false
  // Unsettled evidence. A reload replays old history, which can show assistant
  // output for a worker whose process has not come back yet; this is the same
  // "incomplete history cannot prove anything" guard Close Old Agents uses.
  if (runtime.bootstrapping || runtime.processStatus === 'spawning' || runtime.transcriptStatus === 'loading') {
    return false
  }
  // Implied by `completed` for agents today, but it is the rule closeSession
  // applies at the kill boundary, so eligibility must never be looser than it.
  if (isSessionLiveForClose(runtimes, sessionId)) return false
  return orchestrationChildLifecycle(runtime, meta) === 'completed'
}

function orchestrationChildIds(state: WorkspaceState, ownerId: SessionId): SessionId[] {
  // A malformed self-reference is not a child; counting it would make that
  // session permanently ineligible.
  return Object.entries(state.sessions)
    .filter(([id, meta]) => id !== ownerId && meta.orchestrationParentId === ownerId)
    .map(([id]) => id)
}

/** Grid leaves and Dispatch rows of every project tab, in tab order and then
 *  each tab's own order, so the confirmation lists targets the way the user
 *  reads the workspace. Buried sessions are not placed. */
function placedSessionIds(state: WorkspaceState): SessionId[] {
  const seen = new Set<SessionId>()
  const out: SessionId[] = []
  for (const tab of state.tabs) {
    for (const id of resolveTabSessions(state, tab.id)) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function closeTargetSnapshot(
  state: WorkspaceState,
  runtimes: Runtimes,
  sessionId: SessionId,
  meta: SessionMeta,
): CloseTargetSnapshot {
  // Title plus folder, the same label Close Old Agents lists: orchestration
  // workers are frequently spawned in several worktrees of one repository, and
  // a list of five "Reviewer" rows would not tell the user which is which.
  const folder = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd
  return {
    sessionId,
    title: `${sessionDisplayTitle(meta)} · ${folder}`,
    live: isSessionLiveForClose(runtimes, sessionId),
  }
}

/**
 * Every idle orchestration worker in the window that may be closed now.
 *
 * WHY a coordinator (a worker with workers of its own) is included only when
 * every one of its children is also being closed: closing it under a child that
 * stays open orphans that child's run — the child keeps working for a parent
 * that can no longer wait on it or close it. Exclusion propagates to a fixed
 * point, so one working great-grandchild keeps its whole chain open.
 */
export function idleOrchestrationCloseTargets(
  state: WorkspaceState,
  runtimes: Runtimes,
): CloseTargetSnapshot[] {
  const idle = placedSessionIds(state).filter(id => {
    const meta = state.sessions[id]
    return meta !== undefined && isIdleOrchestrationAgent(id, meta, runtimes)
  })
  const eligible = new Set(idle)
  let changed = true
  while (changed) {
    changed = false
    // Deleting from a Set during for...of is well-defined: deleted entries that
    // were not reached yet are skipped, and the outer loop re-checks the rest.
    for (const id of eligible) {
      if (orchestrationChildIds(state, id).some(child => !eligible.has(child))) {
        eligible.delete(id)
        changed = true
      }
    }
  }
  return idle
    .filter(id => eligible.has(id))
    .map(id => closeTargetSnapshot(state, runtimes, id, state.sessions[id]!))
}

/**
 * The per-kill re-derivation of ONE target, for closeGrantedSessions' `onlyIf`.
 * Synchronous and argument-only, as that contract requires.
 *
 * WHY a coordinator needs NO child left here, where enumeration only needed all
 * children to be targets: closeGrantedSessions closes deeper sessions first, so
 * by the time a coordinator is judged, every worker the user approved has had
 * its turn. A worker still present survived — it started working, failed to
 * close, or was spawned after the dialog — and the coordinator is still
 * coordinating it.
 */
export function currentIdleOrchestrationCloseTarget(
  state: WorkspaceState,
  runtimes: Runtimes,
  sessionId: SessionId,
): CloseTargetSnapshot | null {
  const meta = state.sessions[sessionId]
  if (!meta) return null
  if (!state.tabs.some(tab => resolveTabSessions(state, tab.id).includes(sessionId))) return null
  if (!isIdleOrchestrationAgent(sessionId, meta, runtimes)) return null
  if (orchestrationChildIds(state, sessionId).length > 0) return null
  return closeTargetSnapshot(state, runtimes, sessionId, meta)
}

export type IdleOrchestrationCleanupDeps = {
  /** Live workspace state (the action's refs, not a render snapshot). */
  readState: () => WorkspaceState
  readRuntimes: () => Runtimes
  closeSession: BulkCloseSession
  confirm: (request: Extract<CloseConfirmationRequest, { required: true }>) => Promise<boolean>
  showToast: (message: string, durationMs?: number) => void
}

function agentsNoun(count: number): string {
  return count === 1 ? 'idle orchestration agent' : 'idle orchestration agents'
}

/**
 * Confirm the idle workers with the user, then close them.
 *
 * Returns the outcome, or null when nothing was attempted (nothing idle, or the
 * user declined).
 *
 * WHY it always asks, even for one target: closeConfirmationFor waves an idle
 * single close through because a human aimed ⌘W at a pane they can see, with
 * Undo Close behind them. Neither holds here. This reaches Dispatch rows the
 * user may not have on screen, and a purge records no undo entry.
 *
 * The grant is the list shown. A worker that becomes idle while the dialog is
 * open is not added (the user never saw it), and one that starts working is
 * refused at its kill boundary.
 */
export async function closeIdleOrchestrationAgents(
  deps: IdleOrchestrationCleanupDeps,
): Promise<PartialCloseOutcome | null> {
  const granted = idleOrchestrationCloseTargets(deps.readState(), deps.readRuntimes())
  if (granted.length === 0) {
    deps.showToast('No idle orchestration agents to close.')
    return null
  }
  const confirmed = await deps.confirm({
    required: true,
    reason: 'multi',
    targets: granted,
    summary: `Close ${granted.length} ${agentsNoun(granted.length)}? ${summarizeCloseTargets(granted)}`,
  })
  if (!confirmed) return null

  const outcome = await closeGrantedSessions({
    granted,
    // Read after the dialog: only the ownership edges are used, for ordering,
    // and every kill is judged against live state regardless.
    sessions: deps.readState().sessions,
    closeSession: deps.closeSession,
    currentTarget: currentIdleOrchestrationCloseTarget,
  })
  deps.showToast(
    describePartialClose(outcome) ?? `Closed ${outcome.closed.length} ${agentsNoun(outcome.closed.length)}.`,
    6000,
  )
  return outcome
}
