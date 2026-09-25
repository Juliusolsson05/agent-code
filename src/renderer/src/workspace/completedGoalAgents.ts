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
// WHY this list does not try to spot "the user wrote to it after it completed"
// (#1184 review): the only runtime clocks for that, turnStartedAt and
// submittedAt, reset to null when a turn goes idle, so an idle agent carries
// no trace of a later turn; the durable answer lives in transcript parsing.
// That case is handled where it happens instead: the prompt hook tells a
// completed agent to set a new goal before any further work
// (enforcement.ts GOAL_COMPLETED_CONTEXT), which removes it from this list.
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
  /**
   * Why this row cannot be ticked, or null when it can.
   *
   * `running`: see `live`. `workers-open`: an orchestration coordinator whose
   * workers are not all closing with it. `coordinator-open`: a worker whose
   * coordinator stays open and may still be waiting on it. Both orchestration
   * rules are Close Idle Orchestration Agents' (#960), for its reason: closing
   * either end of a live run orphans the other (#1184 review).
   */
  blocked: 'running' | 'workers-open' | 'coordinator-open' | null
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
    blocked: null,
  }
}

/** Orchestration workers of `ownerId` still in the workspace. A malformed
 *  self-reference is not a child (same rule as idleOrchestrationAgents). */
function openWorkers(state: WorkspaceState, ownerId: SessionId): SessionId[] {
  return Object.entries(state.sessions)
    .filter(([id, meta]) => id !== ownerId && meta.orchestrationParentId === ownerId)
    .map(([id]) => id)
}

/** The coordinator that still owns this worker, when it is still open. */
function openCoordinator(state: WorkspaceState, meta: SessionMeta, sessionId: SessionId): SessionId | null {
  const parent = meta.orchestrationParentId
  return parent && parent !== sessionId && state.sessions[parent] ? parent : null
}

/**
 * Which of `candidates` may not close, and why, if exactly the rest close
 * together (#1184 review).
 *
 * Orchestration closure, to a fixed point: a coordinator may close only if
 * every open worker of its closes too, and a worker only if its open
 * coordinator closes too. Start from "every non-live candidate closes" and
 * strip the ones that break either rule until nothing changes, so one busy
 * great-grandchild keeps its whole run open — the propagation
 * idleOrchestrationCloseTargets uses, extended to the worker side because a
 * completed worker can sit under a coordinator that is still coordinating.
 *
 * WHY one function for the list AND the pre-loop re-judge: the kill-boundary
 * rule ("no worker left") cannot be used before the loop, because at that
 * point no worker has closed yet — the first version did exactly that and
 * silently dropped every coordinator from its own finished run.
 */
function orchestrationBlocks(
  state: WorkspaceState,
  candidates: readonly SessionId[],
  live: ReadonlySet<SessionId>,
): Map<SessionId, NonNullable<CompletedGoalRow['blocked']>> {
  const reason = new Map<SessionId, NonNullable<CompletedGoalRow['blocked']>>()
  for (const id of candidates) if (live.has(id)) reason.set(id, 'running')
  const candidateSet = new Set(candidates)
  const closable = (id: SessionId) => candidateSet.has(id) && !reason.has(id)
  let changed = true
  while (changed) {
    changed = false
    for (const id of candidates) {
      if (reason.has(id)) continue
      if (openWorkers(state, id).some(worker => !closable(worker))) {
        reason.set(id, 'workers-open'); changed = true
        continue
      }
      const meta = state.sessions[id]
      const coordinator = meta ? openCoordinator(state, meta, id) : null
      if (coordinator && !closable(coordinator)) {
        reason.set(id, 'coordinator-open'); changed = true
      }
    }
  }
  return reason
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
  const reason = orchestrationBlocks(state, rows.map(row => row.sessionId), new Set(rows.filter(row => row.live).map(row => row.sessionId)))
  for (const row of rows) row.blocked = reason.get(row.sessionId) ?? null
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
  granted: ReadonlySet<SessionId> = new Set(),
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
    // Orchestration, judged against LIVE state (#1184 review). Workers close
    // first (bulkClose orders deepest first), so a coordinator reaching its
    // kill with a worker still present means that worker survived — it was
    // unticked, refused or spawned meanwhile — and is still being coordinated.
    if (openWorkers(state, sessionId).length > 0) return null
    // A worker may go only if its coordinator is gone or is going in this same
    // grant: unticking the coordinator means "keep that run", and its workers
    // are part of it. A granted coordinator that started working since the
    // click is coordinating again, so its worker stays too — it is judged
    // before the coordinator (deepest first), and closing it now would take a
    // worker out from under a live run whose own kill is about to be refused.
    const coordinator = openCoordinator(state, meta, sessionId)
    if (coordinator && (!granted.has(coordinator) || isSessionLiveForClose(runtimes, coordinator))) return null
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
  const state = deps.readState()
  const runtimes = deps.readRuntimes()
  // Pre-loop: the listing's rules applied to exactly the selection — still a
  // completed, placed, idle row, and not tied to an orchestration run member
  // that stays open. The kill boundary then re-checks each one live.
  const rows = new Map(completedGoalRows(state, runtimes, deps.readGoals()).map(row => [row.sessionId, row]))
  const candidates = selection.filter(sessionId => rows.has(sessionId))
  const blocked = orchestrationBlocks(state, candidates, new Set(candidates.filter(id => rows.get(id)!.live)))
  const granted = candidates.filter(id => !blocked.has(id)).map(id => closeTargetFor(rows.get(id)!))
  const currentTarget = currentCompletedGoalTarget(deps.readGoals, new Set(granted.map(target => target.sessionId)))
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
  let lanesKept = false
  if (options.removeLanes && outcome.closed.length > 0) {
    const after = deps.readState()
    // Said out loud (#1184 review): the user asked for lanes to go, and a
    // silent no-op would leave them wondering why the grid still has holes.
    lanesKept = stageBefore.lanes.length !== after.stage.lanes.length
    for (const laneIndex of laneIndicesToRemove(stageBefore, after, outcome.closed)) {
      const before = deps.readState().stage.lanes.length
      deps.removeTiledLane(laneIndex)
      // removeTiledLane refuses at the one-lane floor without saying so; the
      // count is read back rather than assumed so the toast never claims a
      // lane it did not remove.
      if (deps.readState().stage.lanes.length < before) lanesRemoved += 1
    }
  }
  const closedText = describePartialClose(outcome) ?? `Closed ${outcome.closed.length} ${agentsNoun(outcome.closed.length)}.`
  const laneText = lanesKept
    ? ' Lanes were left in place because the layout changed meanwhile.'
    : lanesRemoved > 0 ? ` Removed ${lanesRemoved} lane${lanesRemoved === 1 ? '' : 's'}.` : ''
  deps.showToast(`${closedText}${laneText}`, 6000)
  return outcome
}
