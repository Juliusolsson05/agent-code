import type { SessionRuntime } from '@renderer/session-runtime/state'
import { closeGrantedSessions } from '@renderer/workspace/bulkClose'
import type { BulkCloseSession, CurrentBulkCloseTarget } from '@renderer/workspace/bulkClose'
import { describePartialClose, isSessionLiveForClose } from '@renderer/workspace/closeConfirmation'
import type { CloseTargetSnapshot, PartialCloseOutcome } from '@renderer/workspace/closeConfirmation'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { tldrIdentityForSession } from '@renderer/features/tldr/identity'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import { hasReportingDomain } from '@shared/types/tldr'
import type { TldrRecord } from '@shared/types/tldr'

// ---------------------------------------------------------------------------
// Close Completed Agents… (#1182).
//
// An agent calls goal_complete once the user's task is delivered and accepted
// (the PR merged). This module decides which open agents are in that state and
// how each kill is re-judged; the destructive loop is the shared one in
// bulkClose.ts, and the modal only wires the two.
//
// WHY the goal record is the source of truth and not anything the renderer
// sees (idleness, a merged PR in the feed): "done" is a claim about the USER'S
// task, which only the agent that did the work can make. Idleness says nothing
// about it — an agent waiting on review is idle and very much not done.
//
// WHY goal records arrive as an argument: they live in main (goal.json) and
// reach the renderer asynchronously. The kill-boundary check below must be
// synchronous, so the modal keeps the latest records in memory (read on open,
// kept fresh by goal:changed) and hands them in.
// ---------------------------------------------------------------------------

type Runtimes = Record<SessionId, SessionRuntime>

export type CompletedGoalRow = {
  sessionId: SessionId
  /** The goal-store key; several fields below come from its record. */
  identity: string
  title: string
  kind: SessionKind
  tabIndex: number
  tabTitle: string
  cwd: string
  goal: string
  completionNote: string
  completedAt: string
  /** Working right now. Listed but never selectable: an agent that is still
   *  doing something is not finished whatever its goal record says. */
  live: boolean
}

/**
 * Whether the command should be offered at all.
 *
 * Metadata only, like Close Idle Orchestration Agents' gate: this backs a
 * palette `when`, evaluated on every render, and completion lives behind an
 * async read. An agent that can report a goal is the cheap, exact-enough
 * precondition; the modal says so when none is complete.
 */
export function hasGoalReportingAgents(state: WorkspaceState): boolean {
  return Object.entries(state.sessions).some(([sessionId, meta]) =>
    isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)
    && (hasReportingDomain(meta.builtInMcpDomains) || tldrIdentityForSession(sessionId, meta) !== undefined))
}

/**
 * Every placed agent session with a goal identity, in tab order.
 *
 * WHY every identity-bearing agent and not only those with Goal on right now:
 * a user who turned Goal off after an agent completed its goal still has a
 * finished agent to close. The identity outlives the domain toggle.
 */
export function goalIdentitiesBySession(state: WorkspaceState): Array<{ sessionId: SessionId; identity: string; tabIndex: number }> {
  const seen = new Set<SessionId>()
  const out: Array<{ sessionId: SessionId; identity: string; tabIndex: number }> = []
  state.tabs.forEach((tab, tabIndex) => {
    for (const sessionId of resolveTabSessions(state, tab.id)) {
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      const meta = state.sessions[sessionId]
      if (!meta || !isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) continue
      const identity = tldrIdentityForSession(sessionId, meta)
      if (identity) out.push({ sessionId, identity, tabIndex })
    }
  })
  return out
}

function isCompleted(record: TldrRecord | undefined): record is TldrRecord & { completedAt: string; completionNote: string } {
  return Boolean(record?.completedAt && record.completionNote)
}

function rowFor(
  state: WorkspaceState,
  runtimes: Runtimes,
  sessionId: SessionId,
  meta: SessionMeta,
  identity: string,
  tabIndex: number,
  record: TldrRecord & { completedAt: string; completionNote: string },
): CompletedGoalRow {
  const tab = state.tabs[tabIndex]
  return {
    sessionId,
    identity,
    title: sessionDisplayTitle(meta),
    kind: meta.kind ?? DEFAULT_PROVIDER,
    tabIndex,
    tabTitle: tab?.title ?? '',
    cwd: meta.cwd,
    goal: record.text,
    completionNote: record.completionNote,
    completedAt: record.completedAt,
    // The same predicate closeSession applies at the kill boundary, so the
    // list can never offer something the executor would then refuse.
    live: isSessionLiveForClose(runtimes, sessionId),
  }
}

/** Placed agents whose goal is complete, most recently completed first: the
 *  one the user just merged is the one they are most likely looking for. */
export function completedGoalRows(
  state: WorkspaceState,
  runtimes: Runtimes,
  goals: Record<string, TldrRecord>,
): CompletedGoalRow[] {
  const rows: CompletedGoalRow[] = []
  for (const { sessionId, identity, tabIndex } of goalIdentitiesBySession(state)) {
    const record = goals[identity]
    const meta = state.sessions[sessionId]
    if (!meta || !isCompleted(record)) continue
    rows.push(rowFor(state, runtimes, sessionId, meta, identity, tabIndex, record))
  }
  // Stable sort; ISO timestamps compare correctly as strings.
  return rows.sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0))
}

/**
 * The kill-boundary re-check for closeGrantedSessions' `onlyIf`.
 *
 * Built over a READER rather than a snapshot of records: the modal's records
 * keep changing while the loop runs (an agent given new work sets a new goal),
 * and the check must see the latest. Synchronous and argument-only, as the
 * bulk-close contract requires.
 *
 * Refuses when the session is gone, no longer placed in a project, no longer
 * completed (its agent set a new goal after the user ticked it), or live —
 * the last one is also enforced by bulkClose itself, but saying it here keeps
 * this function's answer true on its own.
 */
export function currentCompletedGoalTarget(
  readGoals: () => Record<string, TldrRecord>,
): CurrentBulkCloseTarget {
  return (state, runtimes, sessionId): CloseTargetSnapshot | null => {
    const meta = state.sessions[sessionId]
    if (!meta || !isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)) return null
    const tabIndex = state.tabs.findIndex(tab => resolveTabSessions(state, tab.id).includes(sessionId))
    if (tabIndex < 0) return null
    const identity = tldrIdentityForSession(sessionId, meta)
    const record = identity ? readGoals()[identity] : undefined
    if (!identity || !isCompleted(record)) return null
    const row = rowFor(state, runtimes, sessionId, meta, identity, tabIndex, record)
    if (row.live) return null
    return closeTargetFor(row)
  }
}

export function closeTargetFor(row: CompletedGoalRow): CloseTargetSnapshot {
  // Title plus folder, the label the other bulk surfaces use: one feature per
  // agent means several agents often share a title across worktrees.
  const folder = row.cwd.split('/').filter(Boolean).pop() ?? row.cwd
  return { sessionId: row.sessionId, title: `${row.title} · ${folder}`, live: row.live }
}

/**
 * Lanes to remove after the close, highest index first.
 *
 * `before` is the stage captured when the loop started; `after` is live state
 * once it finished.
 *
 * WHY the lane is found from BEFORE the close: closing a session blanks its
 * lane in the same commit (clearTiledLaneSessions — #681's rule that nothing
 * refills a hole), so afterwards there is no id left to look for. The first
 * version of this function searched the post-close stage for the dead ids and
 * found nothing.
 *
 * A lane qualifies only if it showed a session that ACTUALLY closed and is
 * still empty now. The emptiness re-check matters: context-places fills an
 * empty focused lane on spawn, and the user can select an agent into a lane
 * while the loop runs. Either way the slot is in use again and must stay.
 *
 * WHY nothing is removed when the lane count changed: indices are the only
 * lane identity the stage has, and a reshape during the loop (New Lane,
 * Remove Lane, the shape editor) makes every captured index point somewhere
 * else. Leaving a few empty lanes is recoverable with one command; removing
 * the wrong one is not what the user asked for.
 *
 * WHY highest first: removing a lane shifts every later index down by one, so
 * removing from the end keeps the remaining indices valid. The floor (never
 * fewer than one lane) is enforced by removeTiledLane itself; a refused
 * removal simply leaves that lane.
 */
export function laneIndicesToRemove(
  before: WorkspaceState['stage'],
  after: Pick<WorkspaceState, 'stage' | 'sessions'>,
  closed: readonly SessionId[],
): number[] {
  if (before.lanes.length !== after.stage.lanes.length) return []
  const gone = new Set(closed)
  const indices: number[] = []
  before.lanes.forEach((lane, index) => {
    if (lane.selectedSessionId === undefined || !gone.has(lane.selectedSessionId)) return
    const now = after.stage.lanes[index]?.selectedSessionId
    // Empty, or still pointing at the closed (now missing) session.
    if (now === undefined || after.sessions[now] === undefined) indices.push(index)
  })
  return indices.reverse()
}

export type CompletedGoalCloseDeps = {
  /** Live workspace state (the action's refs, not a render snapshot). */
  readState: () => WorkspaceState
  readRuntimes: () => Runtimes
  /** The latest goal records the caller holds; read again at every kill. */
  readGoals: () => Record<string, TldrRecord>
  closeSession: BulkCloseSession
  removeTiledLane: (laneIndex: number) => void
  showToast: (message: string, durationMs?: number) => void
}

function agentsNoun(count: number): string {
  return count === 1 ? 'completed agent' : 'completed agents'
}

/**
 * Close the agents the user ticked, then (optionally) remove their lanes.
 * Returns the outcome, or null when nothing was attempted.
 *
 * WHY no second confirmation: the modal IS the confirmation, as Close Old
 * Agents' is. It shows every row with its goal and completion note, requires
 * ticking, and requires an explicit click; a generic "Close N sessions?" on top
 * would repeat it with less information.
 *
 * WHY rows are re-judged before the loop as well as at each kill: the modal
 * can sit open while an agent is given new work. Dropping those here keeps the
 * count the toast reports honest; the kill-boundary check still covers the
 * ones that change mid-loop.
 */
export async function closeCompletedGoalAgents(
  selection: readonly SessionId[],
  options: { removeLanes: boolean },
  deps: CompletedGoalCloseDeps,
): Promise<PartialCloseOutcome | null> {
  const currentTarget = currentCompletedGoalTarget(deps.readGoals)
  const state = deps.readState()
  const runtimes = deps.readRuntimes()
  const granted = selection
    .map(sessionId => currentTarget(state, runtimes, sessionId))
    .filter((target): target is CloseTargetSnapshot => target !== null)
  if (granted.length === 0) {
    deps.showToast('No completed agents left to close.')
    return null
  }
  // Captured before anything closes: see laneIndicesToRemove.
  const stageBefore = state.stage
  const outcome = await closeGrantedSessions({
    granted,
    sessions: state.sessions,
    closeSession: deps.closeSession,
    currentTarget,
    killCaller: 'bulk.close-completed-agents',
  })
  let lanesRemoved = 0
  if (options.removeLanes && outcome.closed.length > 0) {
    for (const laneIndex of laneIndicesToRemove(stageBefore, deps.readState(), outcome.closed)) {
      const before = deps.readState().stage.lanes.length
      deps.removeTiledLane(laneIndex)
      // removeTiledLane refuses at the one-lane floor without saying so; the
      // count is read back rather than assumed so the toast never claims a
      // lane it did not remove.
      if (deps.readState().stage.lanes.length < before) lanesRemoved += 1
    }
  }
  const closedText = describePartialClose(outcome) ?? `Closed ${outcome.closed.length} ${agentsNoun(outcome.closed.length)}.`
  const laneText = lanesRemoved > 0 ? ` Removed ${lanesRemoved} lane${lanesRemoved === 1 ? '' : 's'}.` : ''
  deps.showToast(`${closedText}${laneText}`, 6000)
  return outcome
}
