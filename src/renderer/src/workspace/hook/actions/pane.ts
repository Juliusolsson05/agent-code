import { DEFAULT_PROVIDER, effectiveProviderRuntime } from '@shared/types/providerKind'
import { enabledAgentProviderChoices } from '@renderer/workspace/providerChoices'
import {
  expandSessionCloseTargets,
  expandTabCloseTargets,
  grantStillMatches,
  isSessionLiveForClose,
  runCloseConfirmationGate,
} from '@renderer/workspace/closeConfirmation'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { CloseExpansionRuntimes, CloseTargetSnapshot } from '@renderer/workspace/closeConfirmation'
import {
  clearRemovedTabTakeovers,
  workspaceWithoutTab,
} from '@renderer/workspace/hook/actions/tabRemoval'
import { requestCloseConfirmation } from '@renderer/workspace/closeConfirmationBroker'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { useCallback, useRef } from 'react'
import { currentCommandChordLabel } from '@renderer/features/command-keybindings/useCommandChord'

import type {
  SessionId,
  SessionKind,
  SessionMeta,
  SessionSpawnSelection,
  SplitDirection,
  Tab,
  TabId,
  TiledDispatchState,
  WorkspaceState,
} from '@renderer/workspace/types'
import type { AgentProviderRuntime } from '@shared/types/providerKind'
import type { KillCaller } from '@shared/lifecycle/events'
import type { ClosedTab, SingleClosedEntry, UndoCloseStack } from '@renderer/lib/undoClose'
import { resolveDispatchSpawnTarget } from '@renderer/workspace/dispatch/dispatchSelectors'
import { fileSessionInProject, workspaceWithoutSessions } from '@renderer/workspace/pool'
import { projectIdOf, resolveTabSessions } from '@renderer/workspace/queries'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  clearTiledLaneSessions,
  withLaneSession,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { BuiltInMcpDomain, BuiltInMcpOverrides } from '@mcp/shared/types'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentRecord,
} from '@mcp/shared/orchestrationTypes'
import { forgetDebugTrace } from '@renderer/features/debug/renderTrace'
import { clearLiveEntryWindowSession } from '@renderer/session-runtime/liveEntryWindow'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetRuntimes,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import {
  killSessionBackendIfOwned,
  type SessionActions,
} from '@renderer/workspace/hook/actions/session'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'
import { enabledAgentProviderKindsSnapshot } from '@renderer/features/providers/store'
import { clearPooledSpawnBadge, markPooledSpawn } from '@renderer/workspace/hook/actions/pooledSpawnBadge'

// -----------------------------------------------------------------------------
// Pane / focus / navigation actions.
//
// Covers: splitFocused, startNewAgentPlacement, the pool creators
// (createDetachedDispatchAgent / createLinkedAgent / createOrchestrationAgent),
// closeFocused, closeSession, closeTab, focusSession, focusSessionInTab,
// openExtensionViewInPane.
// -----------------------------------------------------------------------------

function forgetClosedSessionDebugState(refs: WorkspaceRefs, sessionId: SessionId): void {
  delete refs.seenUuidsRef.current[sessionId]
  // The live-window bookkeeping (trimmed uuids, older-prepend grace) shares
  // the seen-uuid lifecycle by contract — trimmed ⊆ ever-seen (see
  // liveEntryWindow.ts). Every site that deletes/resets a session's seen
  // set must clear it too.
  clearLiveEntryWindowSession(sessionId)
  delete refs.latestScreenRef.current[sessionId]
  // Render traces are intentionally not stored in SessionRuntime: they are
  // large, debug-only forensic buffers populated by DOM/screen capture paths
  // that do not need to re-render the app. That module-level map must still
  // follow the session lifecycle, or every close leaves another bounded-but-
  // permanent trace behind for the life of the renderer process.
  forgetDebugTrace(sessionId)
}

/**
 * Why an approved close stopped before its kill request.
 *
 *   - 'gone': no longer a grid leaf or Dispatch row (closed elsewhere, or
 *     buried — Kill Buried owns that irreversible act, closeSession never does).
 *   - 'linked-session-open': a session still names it as `linkedParentId`.
 *     Killing the parent would orphan that child, so the parent is KEPT. This
 *     covers a child that was never approved (bulk cleanup, or one linked after
 *     the dialog), one that changed and was refused, and one whose kill failed.
 *   - 'changed': it started working, moved project, or no longer satisfies the
 *     caller's `onlyIf` since it was approved.
 */
export type CloseRefusalReason = 'gone' | 'linked-session-open' | 'changed'

/**
 * The ways to skip `closeSession`'s own confirmation.
 *
 * `preConfirmed` is an ASSERTION with a precise meaning: the caller already put
 * the full expanded target set in front of the user, received an explicit
 * approval, and keeps that grant honest at the kill boundary. It grants a
 * SESSION close, never tab intent — only the human root dialog can choose
 * Close Tab. It is deliberately not a convenience for "this close feels safe";
 * omitting it is the gated default.
 *
 * May assert it:
 *   - bulk cleanup (Close Old Agents), and only together with `onlyIf`, which
 *     narrows the grant to the one previewed session and is re-run
 *     synchronously immediately before that session's kill request.
 *
 * No longer asserts it:
 *   - linked cascade children. They used to be re-entered with a bare
 *     `preConfirmed: true`, a reusable boolean that let a child which started
 *     working during an earlier sibling's awaited kill die anyway (#886 review
 *     finding 2). They are now closed inside the parent's `CloseOperation`,
 *     which carries the exact approved ids and the activity the user saw.
 *
 * Must NOT assert it:
 *   - the Agent Activity modal's Close button (one button in a list, no
 *     preview of the cascade it triggers), Dispatch row buttons and keyboard
 *     closes — they omit it and get the scope choice / working-session gate;
 *   - automation (orchestration MCP, Agent Management MCP, the operator
 *     `agents.close` capability): permission to NAME a session is not
 *     permission to kill user-created linked children. They use
 *     `silentIfSoleTarget` / `requireConfirmation` below.
 */
export type CloseSessionOptions = {
  preConfirmed?: boolean
  /** Bulk grants are single-session only. Re-read action-owned state at the
   * kill boundary; refuse any linked cascade rather than widening the user's
   * preview. This callback is intentionally synchronous: no await may separate
   * its verdict from dispatching the ownership-checked kill request. */
  onlyIf?: (state: WorkspaceState, runtimes: Record<SessionId, SessionRuntime>) => boolean
  /**
   * Receive the reason an approved close was refused, instead of a toast.
   *
   * For callers that report outcomes themselves: Close Old Agents buckets a
   * parent kept for a still-open linked child separately from one that changed
   * (#886 review m7), and closeSession's boolean cannot carry that. When this is
   * provided closeSession does not toast the refusal. It is not called for a
   * declined dialog (the user's own choice) or a thrown kill failure (that
   * still rejects, so the caller's `failed` bucket keeps working).
   */
  onRefused?: (reason: CloseRefusalReason) => void
  /**
   * Skip pushing an Undo Close entry for this close. Defaults to capturing.
   *
   * WHY this exists (#672 review): the undo stack is a 10-entry LIFO, and since
   * Dispatch terminals became detached rows EVERY detached close captures one.
   * That is right for a close the user performed — it is the affordance that
   * makes a closed terminal's tmux scrollback recoverable. It is wrong for the
   * bulk and programmatic paths, where a single operation closes N sessions and
   * pushes N entries, silently evicting the pane the user closed by mistake ten
   * minutes ago. ⌘⇧T would then respawn an agent they had deliberately purged
   * instead of restoring the thing they wanted back.
   *
   * It also removes a dangling-reference hazard on cascades. A close operation
   * ends linked children BEFORE recording the parent's entry, so capturing each
   * child would leave a parent with two children as three entries. Undo
   * restores the parent under a NEW session id, and the children's entries
   * carried the OLD `linkedParentId` — so they came back un-nested, stopped
   * cascading, and wrote a dead parent id into workspace.json that nothing
   * scrubs. An operation now records exactly ONE entry for everything it
   * committed — a folded tab entry, a single shape, or a group — and undo
   * re-points restored children at their restored parent through lineage
   * (see recordOperationUndo and UndoLineage). `captureUndo: false` suppresses
   * that one entry for the whole operation.
   */
  captureUndo?: boolean
  /**
   * Skip the dialog ONLY IF this close kills exactly the session named, and
   * confirm with `headline` otherwise.
   *
   * WHY orchestration needs its own mode rather than `preConfirmed`: an
   * orchestrating agent closing children it created is routine housekeeping,
   * and a dialog per close devalues the confirmations that matter. But the
   * ownership gate that authorizes the call only scopes WHICH SESSION MAY BE
   * NAMED — it says nothing about WHICH SESSIONS DIE. `closeSession` kills a
   * SET when linked children exist. A user may attach a linked agent to an
   * orchestration child; that agent has no orchestration ownership fields, so
   * only the expanded close gate can explain the additional impact.
   *
   * History: a tab's SOLE grid leaf used to take every detached session in
   * that tab with it (the caller's siblings, the user's parked agents), so it
   * was the second shape this flag had to confirm. Since #886 a close is
   * session-scoped and promotes the next Dispatch row into the grid instead,
   * so a sole root with detached siblings now expands to exactly itself and
   * closes SILENTLY, promoting a sibling. That is a deliberate automation
   * behavior change (listed in PR #887). Automation never gets the human-only
   * Close Tab choice and cannot turn this flag into tab intent.
   */
  silentIfSoleTarget?: { headline: string }
  /**
   * Confirm even when the policy would let this through silently.
   *
   * For closes a MODEL initiated. `headline` names the requester, so the dialog
   * explains why it appeared — the user did not ask to close anything, and a
   * bare "Close these sessions?" would be a riddle.
   *
   * This is what makes the Agent Management close tool's authorization
   * enforceable. The first attempt put a single-use grant store in main and
   * checked it at the bridge, which was the right instinct in the wrong place:
   * a grant is issued by a USER ACTION, and there is no user action in main
   * that corresponds to "the user asked this agent to close that agent". So
   * nothing ever issued one, every `close_agent` call was denied, and the
   * feature was dead. The renderer CAN ask, at the exact line that mutates.
   */
  requireConfirmation?: { headline: string }
  /**
   * Who is closing, journaled by main on every `kill.request` this close
   * issues — the named session AND each approved linked child (#1135).
   *
   * WHY on the options rather than a separate argument: a close is one
   * approved operation, and the children it ends die because of that same
   * request, so they must carry the same tag. It rides the CloseOperation to
   * the kill boundary for exactly that reason.
   *
   * WHY optional, defaulting to 'unknown' rather than guessing "user close":
   * a close path that forgot to say who it is must appear in the journal as a
   * gap to fix, not be mislabelled as a human gesture.
   */
  killCaller?: KillCaller
}

/**
 * Where a session lives right now: the project its row names, if that project
 * exists. A session whose project is gone is unowned metadata, not something
 * a close may act on — it resolves to null exactly as an unknown id does.
 *
 * Until #992 this had two arms ('grid': the tab whose tile tree held its leaf;
 * 'detached': its detachedSessions record), a third state it deliberately
 * returned null for (buried), and two helpers beside it that existed only to
 * keep the tree valid while closing: `detachedTabChildren` (the rows a tab
 * owned outside its tree) and `detachedRootReplacement` (which Dispatch row
 * to PROMOTE into the tree when its last leaf closed, because a tab's root
 * could not be empty). With ownership on the row there is nothing to promote:
 * a project with sessions left simply still has them.
 */
type SessionPlacement = { tab: Tab; tabIndex: number }

function sessionPlacement(state: WorkspaceState, sessionId: SessionId): SessionPlacement | null {
  const projectId = projectIdOf(state, sessionId)
  if (projectId === undefined) return null
  const tabIndex = state.tabs.findIndex(tab => tab.id === projectId)
  return tabIndex >= 0 ? { tab: state.tabs[tabIndex], tabIndex } : null
}

/** A session's project. The approved plan records this so a session moved to
 *  another project under the dialog (a merge) is refused rather than killed. */
function placementProjectTabId(placement: SessionPlacement | null): TabId | null {
  return placement ? placement.tab.id : null
}

function linkedChildIds(state: WorkspaceState, parentId: SessionId): SessionId[] {
  // A malformed self-link is not a child: a session cannot orphan itself, and
  // counting it would make that session permanently uncloseable.
  return Object.entries(state.sessions)
    .filter(([id, meta]) => id !== parentId && meta.linkedParentId === parentId)
    .map(([id]) => id)
}

/** Distance to the top of a linked chain, cycle-safe. Deeper sessions close
 *  first so a tab-scope operation reaches children before their parents. */
function linkedDepth(state: WorkspaceState, sessionId: SessionId): number {
  const seen = new Set<SessionId>()
  let current = sessionId
  while (state.sessions[current]?.linkedParentId && !seen.has(current)) {
    seen.add(current)
    current = state.sessions[current].linkedParentId!
  }
  return seen.size
}

type ApprovedCloseTarget = {
  /** Activity the approver saw. Idle then + working now = refused. */
  live: boolean
  /** Project at approval; see placementProjectTabId. */
  projectTabId: TabId | null
  /** Captured at approval for the operation's Undo Close entry: by the time the
   *  top-level target records undo, each member's own close has already deleted
   *  its row from state. The row carries its own membership (`projectId`,
   *  `joinedAt`), which is everything undo needs to put it back. */
  meta: SessionMeta | undefined
}

/**
 * One approved close, carried through every kill it performs.
 *
 * WHY an explicit operation instead of re-entering closeSession per child with
 * `preConfirmed: true` (what linked cascades used to do): that boolean was a
 * grant with no memory. #886 review finding 2 — approve closing P with idle
 * linked children C1 and C2; hold C1's backend kill pending; submit work to C2.
 * When C1 resolved, C2 was killed on the strength of a dialog that showed it
 * idle, and P died too. A child linked to P after the dialog survived while P
 * was killed. The same gap existed on main; bulk cleanup alone was protected by
 * its `onlyIf`.
 *
 * The invariants this carries:
 *   - `approved` is exactly what the user (or the policy) authorized, with the
 *     activity and project each session had then. Nothing outside it is ever
 *     killed; each member is re-judged against it synchronously right before
 *     its own kill request (`closeRefusal`), using the same liveness rule as
 *     bulk cleanup and the caller's `onlyIf` when there is one.
 *   - Linked children close before their parent, and a parent is KEPT while any
 *     linked child still exists afterwards — refused, failed, never approved,
 *     or linked after the snapshot. Never orphan a lifecycle-bound child.
 *   - A project is removed only by the commit that takes its LAST session,
 *     decided against the live store at that commit (workspaceWithoutSessions).
 *     So a member kept after its siblings closed — it changed, a sibling kept
 *     it, its kill threw — always still has a project to be filed under.
 *     (#886 review round 2 N1 was the v2 form of this: a member kept after an
 *     eager tab removal was left filed under a deleted tab — invisible,
 *     dropped by the next autosave, backend still running. v2 defended against
 *     it by PROMOTING a pending member into the tab's tile tree; with
 *     ownership on the row the defect cannot be constructed.)
 *   - Undo and the outcome toast describe `commits`, i.e. what actually
 *     happened, not what was approved: a partial operation records and reports
 *     exactly the members that closed (see recordOperationUndo).
 *   - `visited` makes traversal cycle-safe: a malformed parent loop leaves both
 *     sides kept instead of recursing forever.
 */
type CloseOperation = {
  /** The session the caller named, or null for the Close Tab command, which
   *  names a project. Never re-entered as someone's child. */
  rootId: SessionId | null
  approved: ReadonlyMap<SessionId, ApprovedCloseTarget>
  /** Each approved session's project as it stood at approval. A project this
   *  operation removes is recorded for undo from THIS snapshot — its title and
   *  position — because by the removing commit the earlier members are gone. */
  approvalTabs: ReadonlyMap<TabId, { tab: Tab; tabIndex: number }>
  admit?: CloseSessionOptions['onlyIf']
  /** Tag for every kill this operation issues; see CloseSessionOptions.killCaller. */
  killCaller: KillCaller
  visited: Set<SessionId>
  pending: Set<SessionId>
  /** What actually committed, in commit order: the only input to the
   *  operation's undo entry and its outcome toast. */
  commits: CommittedMember[]
  refused: Map<SessionId, CloseRefusalReason>
  failed: Set<SessionId>
  startedAt: number
}

type CommittedMember = {
  sessionId: SessionId
  meta: SessionMeta | undefined
  outcome: CommittedClose
}

function beginCloseOperation(
  state: WorkspaceState,
  rootId: SessionId | null,
  approvedTargets: readonly CloseTargetSnapshot[],
  admit: CloseSessionOptions['onlyIf'],
  killCaller: KillCaller,
): CloseOperation {
  const approved = new Map<SessionId, ApprovedCloseTarget>()
  const approvalTabs = new Map<TabId, { tab: Tab; tabIndex: number }>()
  for (const target of approvedTargets) {
    const projectTabId = placementProjectTabId(sessionPlacement(state, target.sessionId))
    approved.set(target.sessionId, {
      live: target.live,
      projectTabId,
      meta: state.sessions[target.sessionId],
    })
    const tabIndex = projectTabId ? state.tabs.findIndex(tab => tab.id === projectTabId) : -1
    if (tabIndex >= 0) approvalTabs.set(state.tabs[tabIndex].id, { tab: state.tabs[tabIndex], tabIndex })
  }
  return {
    rootId,
    approved,
    approvalTabs,
    admit,
    killCaller,
    visited: new Set(),
    pending: new Set(approved.keys()),
    commits: [],
    refused: new Map(),
    failed: new Set(),
    startedAt: Date.now(),
  }
}

/**
 * The kill-boundary verdict. MUST stay synchronous and be called with no await
 * between it and `killSessionBackendIfOwned`: an await there reopens exactly
 * the window finding 2 exploited.
 */
function closeRefusal(
  state: WorkspaceState,
  runtimes: Record<SessionId, SessionRuntime>,
  operation: CloseOperation,
  sessionId: SessionId,
): CloseRefusalReason | null {
  const placement = sessionPlacement(state, sessionId)
  if (!placement || !state.sessions[sessionId]) return 'gone'
  if (linkedChildIds(state, sessionId).length > 0) return 'linked-session-open'
  const approved = operation.approved.get(sessionId)
  if (!approved) return 'changed'
  if (placementProjectTabId(placement) !== approved.projectTabId) return 'changed'
  if (isSessionLiveForClose(runtimes, sessionId) && !approved.live) return 'changed'
  if (operation.admit && !operation.admit(state, runtimes)) return 'changed'
  return null
}

// What one member's commit did to the workspace.
//
// Until #992 there were five outcomes, three of them about the tile tree:
// 'pane' (a split collapsed — undo needed the split's direction/ratio/side),
// 'detached' (a Dispatch row's record was deleted) and 'promoted' (the last
// leaf closed and a detached survivor was moved into the tree to keep the tab
// valid). A session is one kind of thing now, so a close either removed a
// session or removed a session AND the project it emptied.
type CommittedClose =
  | { kind: 'gone' }
  | { kind: 'session' }
  | { kind: 'tab-removed'; tab: Tab; tabIndex: number }

// WHY a function and not a constant: the hint names Undo Close's CHORD, and
// that chord is the user's (Settings → Commands & Shortcuts). A module
// constant froze the default "⌘⇧T" into every close toast forever (plan H4).
// Read at toast time so a rebind shows up on the next close. Unbound →
// name the command instead of inventing a chord.
function undoHint(): string {
  const chord = currentCommandChordLabel('undo-close')
  return chord
    ? ` — ${chord} Undo Close; repeat for earlier closes`
    : ' — run Undo Close to restore; repeat for earlier closes'
}

/** Approval uses the list the user SAW for liveness. A gate returns its
 *  post-dialog re-enumeration, whose liveness is NOW; a session approved while
 *  working may idle and work again without invalidating the decision, while one
 *  approved idle must not be killed once it works. */
function withShownLiveness(
  current: readonly CloseTargetSnapshot[],
  shown: readonly CloseTargetSnapshot[],
): CloseTargetSnapshot[] {
  const shownLive = new Set(shown.filter(target => target.live).map(target => target.sessionId))
  return current.map(target => (shownLive.has(target.sessionId) ? { ...target, live: true } : target))
}

/**
 * The ClosedTab for a project this operation removed: its title and original
 * position from the approval snapshot, plus every member this operation closed
 * that was filed under it, in index order.
 *
 * WHY the approval snapshot and not the removing commit's tab: they are the
 * same title, but only the snapshot's INDEX is meaningful — it is where the
 * project sat when the user decided, before anything in the operation ran.
 */
function removedTabUndo(
  operation: CloseOperation,
  removed: { tab: Tab; tabIndex: number },
  closedAt: number,
): ClosedTab | null {
  const snapshot = operation.approvalTabs.get(removed.tab.id) ?? removed
  const sessions = operation.commits.flatMap(commit => {
    const approved = operation.approved.get(commit.sessionId)
    // A member with no captured metadata cannot be respawned; leave it out
    // rather than record a lie.
    if (approved?.projectTabId !== removed.tab.id || !approved.meta) return []
    return [{ sessionId: commit.sessionId, meta: approved.meta }]
  })
  if (sessions.length === 0) return null
  // Index order, so the restored project lists its sessions as it used to.
  sessions.sort((a, b) => (a.meta.joinedAt ?? 0) - (b.meta.joinedAt ?? 0))
  return {
    type: 'tab',
    closedAt,
    tab: { id: snapshot.tab.id, title: snapshot.tab.title },
    tabIndex: snapshot.tabIndex,
    sessions,
  }
}

/**
 * Record ONE Undo Close entry for everything an operation committed. Returns
 * whether an entry was recorded.
 *
 * Runs after every kill and commit, never before: an entry pushed before a kill
 * that then throws describes a close that never happened, and undo would
 * respawn a duplicate of a session that is still running (round 1 moved the
 * session path; round 2 found the Close Tab command still did it).
 *
 * Shape rules:
 *   - A project the operation REMOVED becomes one ClosedTab (removedTabUndo),
 *     emitted at the commit that removed it; the members filed under it fold in.
 *   - Every other commit becomes a ClosedSession carrying its old id (so group
 *     undo can re-anchor linked children through lineage) and its row.
 *   - One unit is pushed as itself; several as one ClosedGroup in commit order.
 *     That is what makes a PARTIAL operation recoverable (#886 review round 2):
 *     a parent kept because a child changed while its other children already
 *     closed used to leave those children with no entry at all.
 *
 * WHY every session gets an entry, terminals above all: a closed terminal's
 * tmux session survives, and the next launch's reconcile would kill it as an
 * orphan without an entry carrying `tmuxName` (#671,
 * src/main/tmux/tmuxRecovery.ts). The row is stored verbatim so `joinedAt` —
 * the only thing ordering rows inside a project — survives.
 */
function recordOperationUndo(stack: UndoCloseStack, operation: CloseOperation): boolean {
  const closedAt = Date.now()
  const removedTabIds = new Set(operation.commits.flatMap(commit =>
    commit.outcome.kind === 'tab-removed' ? [commit.outcome.tab.id] : []))
  const units: SingleClosedEntry[] = []
  for (const { sessionId, meta, outcome } of operation.commits) {
    const approved = operation.approved.get(sessionId)
    if (outcome.kind === 'tab-removed') {
      const unit = removedTabUndo(operation, outcome, closedAt)
      if (unit) units.push(unit)
      continue
    }
    // Filed under a project this operation removed: folded into that project's
    // entry. Nothing filed there can commit after the removal — a project is
    // removed only by the commit that takes its last session.
    if (approved?.projectTabId && removedTabIds.has(approved.projectTabId)) continue
    if (!meta || outcome.kind !== 'session') continue
    units.push({ type: 'session', closedAt, sessionId, sessionMeta: meta })
  }
  if (units.length === 0) return false
  stack.push(units.length === 1 ? units[0] : { type: 'group', closedAt, entries: units })
  return true
}

/** The toast for one committed unit, when the operation closed everything it
 *  approved. A closed session toasts with or without a recorded undo entry
 *  (what a Dispatch row always did — and every session is one now); a removed
 *  project toasts only when there is an entry to point at. */
function describeCommittedClose(commit: CommittedMember, undoRecorded: boolean): string | null {
  const { meta, outcome } = commit
  const kindLabel = meta?.kind ?? DEFAULT_PROVIDER
  const cwdBase = meta?.cwd.split('/').filter(Boolean).pop() ?? meta?.cwd ?? 'session'
  const hint = undoRecorded ? undoHint() : ''
  if (outcome.kind === 'session') return `Closed ${kindLabel} session (${cwdBase})${hint}`
  if (!undoRecorded) return null
  if (outcome.kind === 'tab-removed') return `Closed “${outcome.tab.title}”${hint}`
  return null
}

/**
 * One toast for what an operation actually did.
 *
 * WHY one message naming both sides (#886 review round 2, Codex 3 / Claude N4):
 * when earlier approved members closed and the named session was then kept or
 * failed, round 1 reported only the refusal ("Kept “Parent” open…") and the
 * user never learned that a child had been destroyed. A partial operation is
 * not a refusal: it says how many of the listed sessions closed and why the
 * rest stayed open. Returns null when nothing closed — a plain refusal, decline
 * or kill failure, which closeSession reports (or rethrows) itself.
 */
function describeCloseOperation(
  operation: CloseOperation,
  named: { id: SessionId; title: string; closed: boolean } | null,
  undoRecorded: boolean,
): string | null {
  const leftOpen = [...operation.refused.keys(), ...operation.failed].filter(id => id !== named?.id)
  const namedLeftOpen = named !== null && !named.closed
  if (!namedLeftOpen && leftOpen.length === 0) {
    const commit = named
      ? operation.commits.find(candidate => candidate.sessionId === named.id)
      : operation.commits.at(-1)
    return commit ? describeCommittedClose(commit, undoRecorded) : null
  }
  if (operation.commits.length === 0) return null
  const reasons: string[] = []
  if (named && namedLeftOpen) {
    const refusal = operation.refused.get(named.id)
    reasons.push(operation.failed.has(named.id)
      ? `“${named.title}” failed to close`
      : refusal === 'linked-session-open'
        ? `kept “${named.title}” open because a linked session is still open`
        : refusal === 'gone'
          ? `“${named.title}” was already gone`
          : `kept “${named.title}” open because it changed`)
  }
  if (leftOpen.length > 0) {
    const count = leftOpen.length
    reasons.push(`${count} ${named ? 'other ' : ''}${count === 1 ? 'session' : 'sessions'} stayed open because ${count === 1 ? 'it' : 'they'} changed or failed to close`)
  }
  return `Closed ${operation.commits.length} of ${operation.approved.size} listed sessions — ${reasons.join('; ')}${undoRecorded ? undoHint() : ''}`
}

/**
 * Every session closing `targetId` would end: itself and its linked cascade.
 *
 * A close is SESSION-scoped, always. Until #992 this took a `scope` and could
 * return a whole tab, because closing a tab's final tile leaf was offered as a
 * choice between "close this agent" and "close the tab" (the tree could not be
 * empty, so the alternative was promoting a Dispatch row into it). No session
 * is structurally special now; ending a whole project is the Close Tab
 * command's job and nobody else's. Keeping the expansion here prevents the old
 * preview-one / terminate-project mismatch from reappearing in another close
 * entry point.
 */
function paneCloseTargets(
  state: WorkspaceState,
  runtimes: CloseExpansionRuntimes,
  targetId: SessionId,
): CloseTargetSnapshot[] {
  return expandSessionCloseTargets(state, runtimes, targetId)
}

/**
 * The session Close Focused Session would end, captured ONCE. closeSession
 * carries that id through any dialog rather than rereading whichever row
 * gains focus later.
 *
 * WHY this is strict and has NO fallback (#886 review finding 1, a blocker):
 * `commandTargetSessionIdForState` deliberately returns null for an empty
 * lane or a lane holding a dead id — visually "no agent is selected here".
 * The first version of this helper then fell through to the active tab's
 * tree focus, so pressing Close Focused Session on an empty lane killed an
 * agent the user could not see (silently when idle, taking the project with
 * it when it was the sole leaf). A destructive command must target what is
 * highlighted or nothing.
 *
 * Two fallbacks used to live below the strict read and are gone with #992:
 * classic Dispatch's "classic focus, then grid focus, then first visible row"
 * ladder, and the grid's own `Tab.focusedSessionId`. Neither surface exists.
 * The function is kept, rather than inlined at its one call site, because
 * this comment is the record of why "just fall back to something sensible"
 * is the wrong instinct here.
 */
function resolveFocusedCloseTarget(state: WorkspaceState): SessionId | undefined {
  return commandTargetSessionIdForState(state) ?? undefined
}

/**
 * Why a close stopped, phrased for a toast.
 *
 * A silent no-op after the user clicked "Close" is indistinguishable from a
 * broken button. 'declined' is the user's own choice and needs no message.
 */
const CLOSE_CHANGED_TOAST =
  'Close cancelled — these sessions changed while the dialog was open. Try again.'

// Put a newly spawned session on the lane the user was commanding
// (target.laneIndex) — but ONLY if that lane is EMPTY. This is the
// context-places rule (#992 §4.3, the option the operator chose by name):
// spawning from an empty focused lane fills it, which is one of the two
// continuity writes U2 allows besides the user naming an occupant. An
// OCCUPIED lane is never displaced — that would be the #681 healer wearing a
// spawn costume. The session is still in the pool and reachable from every
// index; placement is one click.
//
// The emptiness test happens HERE, at commit time, not in the spawn-target
// resolver: the lane index was resolved BEFORE an awaited spawn, and a lane
// that was empty when the chord was struck may have been filled by the time
// the backend answers. Displacing that later occupant would be a surprise
// ordered before it existed. (The reverse race — lane emptied while the
// spawn was in flight — is fine: the fill was the intent all along.)
//
// The lane index is also re-validated for the same reason as before: an index
// that no longer exists leaves the stage untouched rather than being clamped
// onto whichever lane now sits at the edge. When the lane is refused, focus
// does NOT move either — "nothing on screen moves" is half the rule; moving
// the cursor to advertise the pool row would be the healer again, in a
// cheaper costume.
//
// (This also set a classic-Dispatch `focusedSessionId` until #992, "to keep
// classic focus coherent if the user later exits the tiled view". There is no
// other view to exit to.)
function applyDispatchSpawnFocus(
  state: WorkspaceState,
  sessionId: SessionId,
  laneIndex: number | null,
): TiledDispatchState {
  const stage = state.stage
  if (laneIndex === null || laneIndex < 0 || laneIndex >= stage.lanes.length) return stage
  // Occupied means `selectedSessionId` is set and resolves. A lane pointing
  // at a GONE session reads empty to the user and is treated as fillable:
  // that is exactly the shape a mid-operation close leaves behind, and the
  // stale pointer is dropped by the same write that fills the lane.
  const occupant = stage.lanes[laneIndex]?.selectedSessionId
  if (occupant !== undefined && state.sessions[occupant] !== undefined) return stage
  const lanes = stage.lanes.map((lane, i) =>
    i === laneIndex ? withLaneSession(lane, sessionId) : lane,
  )
  return { ...stage, lanes, focusedLane: laneIndex }
}

// markPooledSpawn moved to pooledSpawnBadge.ts, beside the clear it pairs
// with (#1013 review B).

export type OpenExtensionViewOptions = {
  /** Put the view on screen even when the focused lane is occupied, reusing a
   *  view of the same id that already exists. See revealExtensionView. */
  reveal?: boolean
}

/**
 * Bring an EXISTING session of `viewId` on screen, or return null when there
 * is none. A view already in a lane just takes focus. A pooled one goes into
 * the focused lane, whose occupant returns to the pool alive, exactly as an
 * index click does (selectTiledLaneSession). An extension view has no process,
 * so there is nothing to wake first.
 *
 * WHY reuse instead of opening another (#1013 parity review, MAJOR): a legacy
 * action command opens the view only to get a frame to run in. Minting a
 * fresh session per press piled up identical views, and under
 * context-places every one of them landed in the pool, invisible.
 */
function revealExtensionView(state: WorkspaceState, viewId: string): WorkspaceState | null {
  const stage = state.stage
  const existing = Object.entries(state.sessions)
    .filter(([, meta]) => meta.kind === 'extension-view' && meta.extensionViewId === viewId)
    .map(([id]) => id as SessionId)
  if (existing.length === 0) return null
  const laneIndex = stage.lanes.findIndex(lane => lane.selectedSessionId !== undefined && existing.includes(lane.selectedSessionId))
  if (laneIndex >= 0) {
    return stage.focusedLane === laneIndex ? state : { ...state, stage: { ...stage, focusedLane: laneIndex } }
  }
  const sessionId = existing[0]!
  const focusedLane = stage.focusedLane
  if (!stage.lanes[focusedLane]) return null
  const projectId = state.sessions[sessionId]?.projectId
  return {
    ...state,
    activeTabId: projectId ?? state.activeTabId,
    stage: { ...stage, lanes: stage.lanes.map((lane, i) => (i === focusedLane ? withLaneSession(lane, sessionId) : lane)) },
  }
}

// `detachedDispatchRecord` lived here until #992: the one helper that built the
// durable record filing a session under a project (`projectTabId`,
// `detachedAt`, and two display copies of the tab's title and index). Its
// reason for being one helper — two hand-written copies of a durable shape is
// how one of them drifts — carries over to `fileSessionInProject` (pool.ts),
// which stamps the same two facts onto the row itself.

/**
 * A directory to start a new session in when nothing under the cursor offers
 * one: the first session of the project that has a cwd. A project has no
 * directory of its own, so its sessions are the only source.
 */
function projectCwd(state: WorkspaceState, tabId: TabId): string | undefined {
  return resolveTabSessions(state, tabId)
    .map(id => state.sessions[id]?.cwd)
    .find((cwd): cwd is string => Boolean(cwd))
}

type SplitFocusedContinuation = {
  // WHY cwd and resumeSessionId are required together: this object represents a provider
  // continuation, not generic split preferences. Making the scope cwd optional recreates the exact
  // class of bug where a related child's transcript is resumed with its physical parent's token.
  resumeSessionId: string
  cwd: string
  /** Per-domain MCP choices the clone should adopt. The source pane's effective
   * capability list is deliberately not carried: a clone is a new provider
   * process and resolves these against current Settings. */
  builtInMcpOverrides?: BuiltInMcpOverrides
  /** Preserve an alternate provider transport when cloning a conversation. */
  providerRuntime?: AgentProviderRuntime
}

export function usePaneActions(
  state: {
    activeTabId: string
    sessions: Record<SessionId, SessionMeta>
    tabs: Tab[]
  },
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setSpotlight: WorkspaceSetSpotlight,
  // Reader Mode joins the other takeover setters so an emptied tab is cleaned
  // up by the same tail as the Close Tab command (tabRemoval.ts), instead of
  // leaving a Reader takeover on a removed tab for an effect to heal later.
  setReaderMode: WorkspaceSetReaderMode,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  openNewAgentPlacement: () => void,
  closeNewAgentPlacement: () => void,
  sessionActions: SessionActions,
): {
  splitFocused: (
    kind?: SessionKind,
    continuation?: SplitFocusedContinuation,
  ) => Promise<void>
  startNewAgentPlacement: () => void
  createDetachedSession: (selection: SessionSpawnSelection, projectOverride?: { tabId: TabId; anchorSessionId: SessionId }, continuation?: SplitFocusedContinuation, placement?: { selectCreated: boolean }) => Promise<SessionId | null>
  // WHY `kind` is the full SessionKind here (unlike createLinkedAgent right
  // below, which stays narrowed to agent providers): Dispatch's "New Agent…"
  // picker now offers Terminal (#865), and files it through this exact
  // creator so the project-header "+" override (`projectOverride`, honored
  // here and NOT by splitFocused) applies to shells too. This was a type-only
  // restriction, not a runtime one — proof is two lines below the useCallback:
  // `createDetachedSession: createDetachedDispatchAgent` exposes the SAME
  // function under a second name, and that name's declared type (just above,
  // unchanged) already accepted every SessionKind — `control/terminals.ts`'s
  // `terminals.create` capability has been passing `{ kind: 'terminal' }`
  // through it since terminals existed. Narrowing only THIS name's type was
  // an artifact of when this alias was agent-only; it never matched what the
  // underlying implementation actually does.
  createDetachedDispatchAgent: (
    selection: SessionSpawnSelection,
    projectOverride?: { tabId: TabId; anchorSessionId: SessionId },
    continuation?: SplitFocusedContinuation,
    placement?: { selectCreated: boolean },
  ) => Promise<SessionId | null>
  createLinkedAgent: (
    selection: SessionSpawnSelection & { kind: AgentProviderKind },
    parentId: SessionId,
  ) => Promise<void>
  createOrchestrationAgent: (params: {
    parentId: SessionId
    kind: OrchestrationAgentKind
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
  }) => Promise<OrchestrationAgentRecord>
  closeFocused: () => Promise<void>
  /**
   * Resolves true exactly when the NAMED session's close committed.
   *
   * false means the named session is still there, or never was: it did not
   * exist, the user declined, or the close was refused because the session
   * changed after approval or a linked session is still open. That includes a
   * PARTIAL operation, where approved linked children closed first and the named
   * parent was then kept — that work is reported in one toast and recorded as one
   * Undo Close entry, but the agent the caller named is still running (#886
   * review round 2). Callers that follow a close with a dependent mutation
   * (Close Agent and Remove Lane shrinking a lane, automation reporting closed
   * ids) must branch on this rather than assume success — a cancelled confirm
   * would otherwise leave the layout changed with the agent still alive.
   *
   * true also covers a root close that promoted a Dispatch row into the grid,
   * and a Close Tab choice in which another listed session stayed open. Rejects
   * when the named session's own backend kill throws.
   */
  closeSession: (targetId: SessionId, options?: CloseSessionOptions) => Promise<boolean>
  /** The Close Tab command: end the project's approved plan through the same
   *  executor as closeSession (see its implementation's WHY). */
  closeTab: (tabId: TabId) => Promise<void>
  focusSessionInTab: (tabId: string, sessionId: SessionId) => void
  openExtensionViewInPane: (viewId: string, options?: OpenExtensionViewOptions) => void
} {
  const closeSessionRef = useRef<
    ((targetId: SessionId, options?: CloseSessionOptions) => Promise<boolean>) | null
  >(null)

  // Spawns a new session in the parent pane's cwd, inserts a new
  // leaf under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (
      kind: SessionKind = 'claude',
      continuation?: SplitFocusedContinuation,
    ) => {
      const resumeSessionId = continuation?.resumeSessionId
      const builtInMcpOverrides = continuation?.builtInMcpOverrides
      const providerRuntime = continuation?.providerRuntime
      const dispatchSnapshot = refs.stateRef.current
      // #1102 central guard (review finding #2): the DEFAULT kind bypassed
      // every per-command enablement gate because per-kind commands are
      // generated with the default filtered out. Resolve the effective spawn
      // kind HERE — a disabled default falls back to the first enabled agent
      // kind, and with none enabled the split declines instead of silently
      // spawning a provider the user turned off. Callers that pass an explicit
      // kind keep the per-command `when:` gates; an explicitly-passed disabled
      // kind still declines (spawn validation covers it) rather than being
      // silently redirected.
      // AGENT kinds only (final review, blockers 1+2): 'terminal' and
      // 'extension-view' are SessionKinds but not providers — the guard used
      // to swallow them into the first enabled agent, turning ⌥T into a
      // Claude spawn, and its no-providers throw blocked terminal splits in a
      // world this very PR makes reachable. Non-agent kinds pass through.
      const effectiveKind: SessionKind = !AGENT_PROVIDER_KINDS.includes(kind as AgentProviderKind)
        ? kind
        : (() => {
          const enabledAgentKinds = enabledAgentProviderKindsSnapshot()
          if (enabledAgentKinds.size === 0) {
            throw new Error('No providers are enabled. Enable one in Settings → Providers.')
          }
          // The default kind resolves to the first ENABLED kind when the
          // stored default is disabled — spawn something the user allows, or
          // decline when nothing is allowed; never the disabled default.
          return enabledAgentKinds.has(kind as AgentProviderKind)
            ? kind
            : [...AGENT_PROVIDER_KINDS].find(candidate => enabledAgentKinds.has(candidate))!
        })()
      // ONE Dispatch creation flow for every session kind.
      //
      // WHY terminals no longer take a separate path: they used to be inserted
      // into the owning tab's GRID tree while Dispatch agents became detached
      // rows. `buildDispatchGroups` emits every project group as
      // `[...gridSessionIds, ...detachedSessionIds]`, so a Dispatch terminal was
      // STRUCTURALLY guaranteed to sort above every agent no matter when it was
      // created. That concatenation is the whole cause and it is sufficient on
      // its own — the terminal's position WITHIN the grid slice never mattered,
      // because the entire grid slice precedes the detached rows the user's
      // agents live in. See #671.
      //
      // The old justification was that a shell's durable shape is leaf-based
      // (tmux name, resize lifecycle, undo/close history, persistence). Every
      // one of those is SESSION-scoped, not grid-scoped, and a detached
      // terminal was already a reachable, supported state: `detachFocusedToDispatch`
      // never excluded terminals, `renderWorkspaceLeaf` renders `kind ===
      // 'terminal'` inside a Dispatch lane, `TerminalLeaf` wakes its own backend
      // on mount through `ensureSessionLive` (which passes `recoverTmuxName`),
      // and `undoClose` already threads `recoverTmuxName` for detached entries.
      //
      // The one real consequence is that a Dispatch terminal now hibernates
      // across restart like any other detached session: rehydrate deliberately
      // does not respawn detached sessions (the anti-fork-bomb policy), so its
      // shell re-attaches when its lane first renders rather than at launch.
      // That is the existing behaviour for a hand-detached terminal and is
      // strictly better than spawning shells nobody asked for.
      //
      // Terminals created OUTSIDE Dispatch still split the grid — see the
      // normal-mode path below. Only the Dispatch creation surface changed.
      // Same target resolution as createDetachedDispatchAgent: follow the
      // focused lane in Tiled Dispatch so cwd and projectTab agree on the
      // project the user is commanding (issue #266 / #248). Routing terminals
      // through this same resolver is what preserves #366 — project tab and
      // cwd come from the focused lane, never from a stale activeTabId —
      // without needing a terminal-specific resolver to keep in sync.
      const target = resolveDispatchSpawnTarget(dispatchSnapshot)
      const tab = dispatchSnapshot.tabs.find(t => t.id === target.tabId)
      if (!tab) return

      // WHY a caller may override the visually focused project cwd: lifecycle commands can
      // target a selected related/orchestration child that is rendered inside a physical parent
      // pane but intentionally runs in another worktree. Its transcript id, enabled MCP domains,
      // and cwd are one continuation identity. Mixing the child's domains with the parent's cwd
      // would mint a fresh token for the wrong project scope.
      const cwd =
        continuation?.cwd ??
        (target.cwdSessionId ? dispatchSnapshot.sessions[target.cwdSessionId]?.cwd : null) ??
        projectCwd(dispatchSnapshot, tab.id)
      if (!cwd) {
        showToast(
          kind === 'terminal'
            ? 'Could not create dispatch terminal: no project folder found.'
            : 'Could not create dispatch agent: no project folder found.',
        )
        return
      }

      let sessionId: SessionId
      try {
        // Resume identity, runtime flavor, and built-in MCP domains are
        // passed through unguarded, but they are NOT symmetric and it is
        // worth being precise about which is which:
        //
        //  - `builtInMcpOverrides` really is dropped for a terminal —
        //    `sessionActions.spawn` gates the resolved capability list it
        //    produces behind `isAgentProviderKind`.
        //  - `resumeSessionId` is NOT dropped. It is forwarded to
        //    `window.api.spawnSession` for every kind; only the value written
        //    back into the durable `SessionMeta` is kind-gated. It is inert
        //    for a terminal because main re-gates on kind before resolving a
        //    transcript, not because anything here filtered it.
        //  - `providerRuntime` is validated by main against the chosen
        //    provider factory. It is present when a transcript clone must
        //    remain OpenCode Terminal instead of reverting to rendered
        //    OpenCode.
        //
        // Neither can be reached today regardless: `continuation` is only
        // supplied by agent-gated callers, so no terminal spawn carries one.
        // Adding a local guard would state a rule this call site does not
        // actually own, which is exactly the kind of comment that outlives
        // the code it describes.
        sessionId = await sessionActions.spawn(cwd, {
          kind: effectiveKind,
          ...(providerRuntime ? { providerRuntime } : {}),
          resumeSessionId,
          builtInMcpOverrides,
        })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : kind === 'terminal'
              ? 'Could not create dispatch terminal.'
              : 'Could not create dispatch agent.',
        )
        return
      }

      // Did the session actually get FILED? The resolved project can be closed
      // between the awaited spawn and this commit, in which case `spawn` has
      // already registered a live backend whose row names no project — an
      // unreachable session leaking in renderer and main state. The terminal branch used to guard this and
      // the agent branch did not; merging keeps the guard and extends it to
      // both kinds rather than preserving the leak in the shared path.
      //
      // Reading a flag set inside the updater is only sound because setState
      // is the zustand store setter, which applies the updater synchronously.
      // If this ever becomes a React useState setter the flag would still be
      // false here and every spawn would be killed on the spot.
      let filed = false
      // Whether the spawn took a lane. Decided INSIDE the updater so it reads
      // the same `prev` the placement read — a lane freed during the awaited
      // spawn is fillable, one filled since is not — and readable outside
      // because the zustand setter applies updaters synchronously (the same
      // contract the `filed` flag relies on).
      let pooled = false
      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === tab.id)
        if (!latestTab) return prev
        filed = true
        const stage = applyDispatchSpawnFocus(prev, sessionId, target.laneIndex)
        // Refused placement returns the stage by reference; that reference
        // identity IS the fill/refuse answer (see applyDispatchSpawnFocus).
        pooled = stage === prev.stage

        return {
          ...prev,
          activeTabId: latestTab.id,
          // Filing IS ownership (pool.ts): the row `spawn` wrote becomes a
          // member of this project, last in its index.
          sessions: fileSessionInProject(prev.sessions, sessionId, latestTab.id),
          stage,
        }
      })

      if (filed && pooled) markPooledSpawn(setRuntimes, sessionId)
      if (!filed) {
        // Kill the backend with the kind/cwd THIS call already resolved
        // rather than leaving it to killSession's ownership proof, which
        // re-reads them from `refs.stateRef`.
        //
        // History: that ref used to be a RENDER-BODY mirror (assigned while
        // the workspace hook rendered). Immediately after an awaited spawn
        // React had not re-rendered, so the ref lacked the new session, the
        // proof bailed on missing metadata, and the kill silently no-opped —
        // this guard never actually reclaimed anything. #886 subscribed
        // stateRef to the store synchronously, so the proof would now see the
        // session; the explicit owner stays as defense in depth, because this
        // reclaim must not depend on how the ref happens to be wired.
        // killSession still runs for the renderer-side cleanup; its own
        // ownership check may then find the backend already gone, harmlessly.
        await window.api.killOwnedSession({
          sessionId,
          kind: effectiveKind,
          ...(providerRuntime ? { providerRuntime } : {}),
          cwd,
          caller: 'spawn.unplaced',
        })
          .catch(() => undefined)
        await sessionActions.killSession(sessionId, 'spawn.unplaced')
        return
      }
      closeNewAgentPlacement()
      // A tile-tree branch followed this one until #992, and `direction`
      // parameterized it. The tree is gone, the stage is required, and the
      // argument went with it (#992 stage 4): every spawn is one flow — fill
      // the focused lane when it is empty, else pool.
    },
    [
      closeNewAgentPlacement,
      refs.stateRef,
      sessionActions,
      setState,
      showToast,
    ],
  )

  const startNewAgentPlacement = useCallback(() => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    openNewAgentPlacement()
  }, [openNewAgentPlacement, state.activeTabId, state.tabs])

  const createDetachedDispatchAgent = useCallback(
    async (
      selection: SessionSpawnSelection,
      // Explicit project override, supplied by the Dispatch header "+".
      //
      // WHY it must override BOTH halves rather than just the tab: cwd is
      // derived from the FOCUSED session below, which belongs to a different
      // project when the user clicked "+" on a project they are not focused
      // on. Overriding the tab alone would file the agent correctly and then
      // spawn it in the wrong directory — or fail outright, since a project
      // whose grid leaves are all closed has no leaf cwd to fall back on and
      // Dispatch agents are never inserted into tab.root.
      projectOverride?: { tabId: TabId; anchorSessionId: SessionId },
      continuation?: SplitFocusedContinuation,
      placement?: { selectCreated: boolean },
    ) => {
      const { kind, providerRuntime } = selection
      const snapshot = refs.stateRef.current
      // Resolve the target project ONCE so cwd and projectTab agree. In Tiled
      // Dispatch this follows the focused lane, not the stale active tab —
      // reading cwd from focusedSessionId while filing under activeTabId is the
      // bug this fixes (issue #266 / #248). See resolveDispatchSpawnTarget.
      //
      // laneIndex is deliberately kept from the resolver even when a project
      // override is present: the override says WHICH PROJECT, while the lane
      // is about where the new agent should appear in Tiled Dispatch, which is
      // still a function of the user's current focus.
      const resolved = resolveDispatchSpawnTarget(snapshot)
      const target = projectOverride
        ? { ...resolved, tabId: projectOverride.tabId, cwdSessionId: projectOverride.anchorSessionId }
        : resolved
      const tab = snapshot.tabs.find(t => t.id === target.tabId)
      if (!tab) {
        // WHY this says something instead of returning quietly (#863): a bare
        // `return null` here is the primary creation command failing with NO
        // feedback at all. The cause that made it reachable (a row still bound
        // to a closed project) is fixed in `workspaceWithoutSessions`, so this
        // should be unreachable; it stays because the next stale target must be
        // visible rather than silent.
        //
        // WHY it also CLOSES the overlay, and unconditionally: a toast alone
        // left the user in the dead end it was describing. The overlay only
        // closes on a successful spawn, and `NewAgentPlacementOverlay` latches
        // `committingRef` before calling this and clears it only in its `open`
        // effect — so after a failure the overlay is still up with every
        // gesture latched off, and Escape is the only way out. Advice the user
        // cannot act on is worse than silence, not better.
        //
        // The copy splits on `projectOverride` because the callers are not
        // alike: without one the project came from the focused LANE (Dispatch
        // "+" on the grid, splitFocused), so "try another lane" is actionable.
        // With one, the caller named the project outright — the Dispatch
        // header's per-project "+", the New Agent In dialog, MCP
        // `agents.create` — and there is no lane in the story at all.
        showToast(projectOverride
          ? 'New Agent could not find that project. It may have just closed.'
          : 'New Agent could not find the project this lane is pointing at. Try another lane, or pick a project.')
        closeNewAgentPlacement()
        return null
      }

      // A native continuation owns its cwd; the project only owns placement.
      // Reusing the anchor cwd here can resume a transcript in another repo.
      const cwd = continuation?.cwd ??
        (target.cwdSessionId ? snapshot.sessions[target.cwdSessionId]?.cwd : null) ??
        // No agent under the cursor to borrow from: any session of the
        // resolved project will do — all are valid directories for it.
        projectCwd(snapshot, tab.id)
      if (!cwd) {
        showToast('Could not create dispatch agent: no project folder found.')
        return null
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(cwd, { kind, providerRuntime, resumeSessionId: continuation?.resumeSessionId, builtInMcpOverrides: continuation?.builtInMcpOverrides })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not create dispatch agent.',
        )
        return null
      }

      let placed = false
      // Pooled = the spawn took no lane (context-places). Same synchronous-
      // updater trick as `placed`: readable after setState, decided against
      // the exact `prev` the placement read. A selectCreated:false caller
      // asked for no view change, so its spawn is pooled BY REQUEST and still
      // badges — the caller places the returned ID itself, and until it does
      // the badge is the honest state of that row.
      let pooled = placement?.selectCreated === false
      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === tab.id)
        if (!latestTab) return prev
        placed = true
        if (!pooled) {
          const stage = applyDispatchSpawnFocus(prev, sessionId, target.laneIndex)
          pooled = stage === prev.stage
          return {
            ...prev,
            // Filing is membership, not focus. UI creation has always selected
            // the captured lane; external operators can preserve the entire
            // current view, then explicitly assign the returned ID to a chosen
            // lane using a fresh layout revision.
            activeTabId: latestTab.id,
            sessions: fileSessionInProject(prev.sessions, sessionId, latestTab.id),
            stage,
          }
        }
        return {
          ...prev,
          activeTabId: prev.activeTabId,
          sessions: fileSessionInProject(prev.sessions, sessionId, latestTab.id),
          stage: prev.stage,
        }
      })
      if (placed && pooled) markPooledSpawn(setRuntimes, sessionId)
      // A caller needs the exact spawned ID; comparing a before/after census
      // could accidentally claim an agent created concurrently by the UI.
      // If the owning project disappeared during spawn, retire only this new
      // process instead of leaving an unowned live session behind.
      if (!placed) {
        await sessionActions.killSession(sessionId, 'spawn.unplaced', { cwd, kind, providerRuntime })
        return null
      }
      if (placement?.selectCreated !== false) closeNewAgentPlacement()
      return sessionId
    },
    [closeNewAgentPlacement, refs.stateRef, sessionActions, setState, setRuntimes, showToast],
  )

  // Spawn a "linked agent" — a normal detached dispatch agent that
  // records `parentId` as its `linkedParentId`. It lands in the
  // PARENT's project tab (not necessarily the active tab), which is
  // what lets the dispatch list render it indented under the parent;
  // and the close path cascade-closes it when the parent goes away.
  //
  // WHY this is a sibling of createDetachedDispatchAgent rather than
  // a flag on it: ordinary detached creation resolves a spawn target
  // from the current Dispatch/grid focus; linked creation is anchored
  // to the explicit parent selected when the command ran. The common
  // behavior is the post-spawn Dispatch focus patch, which both paths
  // route through applyDispatchSpawnFocus so Tiled lanes and classic
  // focus cannot drift.
  const createLinkedAgent = useCallback(
    async (
      selection: SessionSpawnSelection & { kind: AgentProviderKind },
      parentId: SessionId,
    ) => {
      const { kind, providerRuntime } = selection
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[parentId]
      if (!parentMeta) {
        showToast('Could not create linked agent: parent agent is gone.')
        return
      }
      // If the parent is ITSELF a linked agent, anchor the new agent
      // to the same top-level parent — linked agents never chain, so
      // the dispatch nesting stays exactly one level deep (see the
      // note on SessionMeta.linkedParentId).
      const rootParentId = parentMeta.linkedParentId ?? parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta
      // No lane capture. This used to aim the child at the focused lane WHEN
      // that lane showed the parent — "spawned to immediately hand it a
      // prompt". Under context-places (#992 §4.3) a lane showing the parent is
      // an OCCUPIED lane, and an occupied lane is never displaced; a lane not
      // showing the parent was never a target. Both branches of the capture
      // are dead, so it is gone. The child lands in the pool, nested under
      // its parent in every index that lists it.

      // The child is filed in its parent's project.
      const parentTab = sessionPlacement(snapshot, rootParentId)?.tab
      if (!parentTab) {
        showToast('Could not create linked agent: parent tab not found.')
        return
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(rootParentMeta.cwd, { kind, providerRuntime })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not create linked agent.',
        )
        return
      }

      let filed = false
      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        if (!latestTab) return prev
        filed = true
        return {
          ...prev,
          activeTabId: latestTab.id,
          // Stamp the parent link onto the freshly-spawned child's
          // meta. spawn() already inserted sessions[sessionId]; we
          // patch that entry rather than racing spawn's own setState.
          sessions: {
            ...prev.sessions,
            [sessionId]: {
              ...(prev.sessions[sessionId] ?? {
                cwd: rootParentMeta.cwd,
                kind,
                ...(providerRuntime ? { providerRuntime } : {}),
              }),
              linkedParentId: rootParentId,
              // Filed in the PARENT's project rather than the active one, last
              // in its index (the index then nests it under its parent).
              projectId: latestTab.id,
              joinedAt: Date.now(),
            },
          },
          // Pool-only placement (context-places): the child is filed under
          // the parent's project and shown in NO lane. See the note above the
          // spawn for why the old "focus the child in the parent's lane"
          // behavior is gone; passing null keeps the stage byte-identical.
          stage: applyDispatchSpawnFocus(prev, sessionId, null),
        }
      })
      if (filed) markPooledSpawn(setRuntimes, sessionId)
    },
    [refs.stateRef, sessionActions, setState, setRuntimes, showToast],
  )

  const createOrchestrationAgent = useCallback(
    async (params: {
      parentId: SessionId
      kind: OrchestrationAgentKind
      providerRuntime?: AgentProviderRuntime
      cwd?: string
      title?: string
      role?: string
      runId?: string
      builtInMcpDomains?: BuiltInMcpDomain[]
      inheritParentContext?: boolean
    }): Promise<OrchestrationAgentRecord> => {
      // WHY also check the renderer launch choices: this action can be called
      // without the MCP bridge. Reuse the picker's supported combinations so
      // direct calls cannot silently launch a structured child after the user
      // requested a TUI. Main separately validates the actual factory.
      // #1102: enablement also gates orchestration children — a disabled
      // provider must not come back through the MCP create_agent door.
      //
      // WHY the EFFECTIVE runtime, not the raw request: a terminal-only
      // provider (Pi) has exactly one runtime, so a caller that names only
      // `{ kind: 'pi' }` asked for it. Comparing the raw, absent runtime with
      // the choice's 'terminal' refused every kind-only Pi create even though
      // main would have normalized it (Astra review, finding 3). OpenCode is
      // untouched: its absent runtime still means the structured one.
      const providerRuntime = effectiveProviderRuntime(params.kind, params.providerRuntime)
      if (!enabledAgentProviderChoices().some(choice => choice.kind === params.kind && choice.providerRuntime === providerRuntime)) {
        throw new Error(`${params.kind} does not support the requested ${providerRuntime ?? 'structured'} runtime`)
      }
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[params.parentId]
      if (!parentMeta) {
        throw new Error('Could not create orchestration agent: parent agent is gone.')
      }

      const rootParentId = parentMeta.orchestrationRootId ?? params.parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta
      const parentTab = sessionPlacement(snapshot, rootParentId)?.tab
      if (!parentTab) {
        throw new Error('Could not create orchestration agent: parent tab not found.')
      }

      const cwd = params.cwd ?? rootParentMeta.cwd
      const resumeSessionId: string | undefined = undefined

      // WHY context inheritance is commented out instead of quietly deleted:
      // this is the exact behavior a follow-up issue should rebuild, but the
      // current implementation is too flawed to keep behind a tool flag. It
      // relied on duplicating or translating the parent's provider transcript,
      // then resuming the child from that file. In real orchestration runs that
      // produced unstable identity, stale parent answers being reported as
      // child output, and provider-specific race edges around cloned/resumed
      // conversations. Until there is a more stable contract, orchestration
      // children must start clean and the parent must put required context in
      // the prompt it sends.
      //
      // Disabled implementation sketch:
      //
      // if (
      //   params.inheritParentContext !== false &&
      //   (parentMeta.kind === 'claude' || parentMeta.kind === 'codex') &&
      //   parentMeta.providerSessionId
      // ) {
      //   if (parentMeta.kind === params.kind) {
      //     const duplicate = await window.api.duplicateSession({
      //       provider: parentMeta.kind,
      //       sourceProviderSessionId: parentMeta.providerSessionId,
      //       cwd,
      //       sourceCwd: parentMeta.cwd,
      //       targetCwd: cwd,
      //     })
      //     resumeSessionId = duplicate.newProviderSessionId
      //   } else {
      //     const switched = await window.api.switchProvider({
      //       sourceKind: parentMeta.kind,
      //       sourceProviderSessionId: parentMeta.providerSessionId,
      //       cwd,
      //       sourceCwd: parentMeta.cwd,
      //       targetCwd: cwd,
      //     })
      //     resumeSessionId = switched.targetProviderSessionId
      //   }
      // }

      const sessionId = await sessionActions.spawn(cwd, {
        kind: params.kind,
        ...(providerRuntime ? { providerRuntime } : {}),
        resumeSessionId,
        builtInMcpDomains: params.builtInMcpDomains,
      })

      const agent: OrchestrationAgentRecord = {
        sessionId,
        kind: params.kind,
        cwd,
        ...(params.title ? { title: params.title } : {}),
        orchestrationParentId: params.parentId,
        orchestrationRootId: rootParentId,
        ...(params.runId ? { orchestrationRunId: params.runId } : {}),
        ...(params.role ? { orchestrationRole: params.role } : {}),
      }

      let filed = false
      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        if (!latestTab) return prev
        filed = true
        return {
          ...prev,
          sessions: {
            ...prev.sessions,
            [sessionId]: {
              ...(prev.sessions[sessionId] ?? { cwd, kind: params.kind }),
              cwd,
              kind: params.kind,
              ...(params.title ? { title: params.title } : {}),
              orchestrationParentId: params.parentId,
              orchestrationRootId: rootParentId,
              ...(params.runId ? { orchestrationRunId: params.runId } : {}),
              ...(params.role ? { orchestrationRole: params.role } : {}),
              // Filed in the root parent's project; see createLinkedAgent.
              projectId: latestTab.id,
              joinedAt: Date.now(),
            },
          },
          // WHY orchestration agents intentionally do not steal focus:
          // the MCP caller already gets `sessionId` back as the control handle,
          // and the user may be reading or editing the parent while the new
          // worker boots. Reusing Dispatch's visual nesting is correct, but
          // reusing its manual "new agent means jump to it" focus semantics is
          // wrong for orchestration because one prompt can create many agents.
          // Keeping the active tab and focused dispatch row unchanged preserves
          // the user's review surface while still linking the child into the
          // same project tree.
        }
      })
      // Orchestrated children are the purest pooled spawn: many can arrive
      // from one prompt, none of them takes a lane, and the parent's pane is
      // the surface the user is reading (#992 §4.3 names orchestration
      // explicitly). The badge is the only on-screen trace that they arrived.
      if (filed) markPooledSpawn(setRuntimes, sessionId)

      return agent
    },
    [refs.stateRef, sessionActions, setState, setRuntimes],
  )

  // Execute ONE member of an approved CloseOperation: its approved linked
  // children first, then the synchronous kill-boundary verdict, the
  // ownership-checked kill, and a state commit that re-resolves placement from
  // the live store. See CloseOperation for the invariants.
  //
  // Linked agents are lifecycle-bound to their parent, so children still close
  // first — but only children the operation APPROVED. Re-prompting per child
  // would ask N times about one decision; re-entering closeSession with
  // `preConfirmed: true` (the previous shape) spent the parent's grant on
  // whatever each child had become by the time its turn came. The named
  // function expression lets children recurse through this same executor.
  //
  // It records WHAT committed on the operation and nothing else — no undo entry,
  // no toast. Those are decided once, after the whole operation (by
  // recordOperationUndo and describeCloseOperation), because only then is it
  // known whether this member's close was the whole story or part of a partial
  // operation whose named session stayed open (#886 review round 2).
  const closeApprovedTarget = useCallback(
    async function closeTarget(
      targetId: SessionId,
      operation: CloseOperation,
    ): Promise<{ closed: boolean }> {
      if (operation.visited.has(targetId)) return { closed: false }
      operation.visited.add(targetId)

      // Children come from LIVE state, not the approval snapshot: a child
      // linked after the dialog is found here, is not approved, is skipped, and
      // then keeps its parent open through closeRefusal below.
      for (const childId of linkedChildIds(refs.stateRef.current, targetId)) {
        if (childId === operation.rootId || !operation.approved.has(childId)) continue
        try {
          await closeTarget(childId, operation)
        } catch (error) {
          // A child whose backend kill threw keeps its metadata, so the parent
          // verdict below keeps the parent as well. Recorded for the summary
          // rather than rejecting a whole operation from inside its cascade.
          operation.pending.delete(childId)
          operation.failed.add(childId)
          console.warn('[workspace] linked session failed to close; keeping its parent open:', error)
        }
      }

      // ---- Kill boundary: synchronous from this verdict to the kill request ----
      const state = refs.stateRef.current
      const refusal = closeRefusal(state, refs.latestRuntimesRef.current, operation, targetId)
      if (refusal) {
        operation.pending.delete(targetId)
        operation.refused.set(targetId, refusal)
        return { closed: false }
      }
      const sessionMeta = state.sessions[targetId]
      // killSessionBackendIfOwned issues window.api.killOwnedSession before its
      // first await, so the verdict above and main's atomic ownership check
      // judge the same workspace. Its boolean is deliberately not a refusal:
      // main rejecting an ownership-conflict pane still lets the renderer drop
      // that stale pane (paneRecoveryOwnership tests), as it always has.
      await killSessionBackendIfOwned(refs, targetId, operation.killCaller)

      setRuntimes(prev => {
        const next = { ...prev }
        delete next[targetId]
        return next
      })
      forgetClosedSessionDebugState(refs, targetId)
      // The Close Tab command used to end sessions through sessionActions
      // .killSession, which also cancels a pending bootstrap debounce. Both
      // Close Tab entry points now come through here, so keep that release:
      // the deferred flip would otherwise fire against a session that is gone.
      const bootstrapTimer = refs.bootstrapTimersRef.current.get(targetId)
      if (bootstrapTimer) {
        clearTimeout(bootstrapTimer)
        refs.bootstrapTimersRef.current.delete(targetId)
      }

      // Holder object, not a `let`: TypeScript keeps a `let` narrowed to its
      // initial value across the updater call. Reading it back is sound only
      // because setState is the synchronous zustand setter.
      const committed: { value: CommittedClose } = { value: { kind: 'gone' } }
      setState(prev => {
        // Placement is re-resolved from `prev`, never from the pre-kill
        // snapshot: the kill was an await, and this member's own children may
        // have emptied the project before it (finding 3).
        const placement = sessionPlacement(prev, targetId)
        // One removal for the whole workspace (pool.ts): the row, its lanes,
        // its pin, and its project IF this was the project's last session.
        //
        // Until #992 this was four hand-written branches — delete a detached
        // record; collapse a split; promote a Dispatch row into an emptied
        // tree; or remove the tab — and the tab-removing one had to choose its
        // survivor carefully enough to need two review rounds (#886 N1).
        const next = workspaceWithoutSessions(prev, [targetId])
        if (placement) {
          committed.value = next.tabs.some(tab => tab.id === placement.tab.id)
            ? { kind: 'session' }
            : { kind: 'tab-removed', tab: placement.tab, tabIndex: placement.tabIndex }
        }
        return next
      })

      operation.pending.delete(targetId)
      const outcome = committed.value
      operation.commits.push({ sessionId: targetId, meta: sessionMeta, outcome })
      if (outcome.kind === 'tab-removed') {
        clearRemovedTabTakeovers({ setSpotlight, setReaderMode }, outcome.tab.id)
      }
      return { closed: true }
    },
    [refs, setReaderMode, setRuntimes, setSpotlight, setState],
  )

  // Close several approved members one at a time, in the order given. A member
  // whose backend kill throws stays open and is recorded as failed; the loop
  // goes on, because the rest of an approved plan is still approved and a
  // parent waiting on that member is kept by its own verdict anyway.
  //
  // WHY sequential and not Promise.all (the old Close Tab command): every kill
  // must be preceded by its own synchronous verdict against the workspace the
  // previous commit left, and a rejected kill must leave state that describes
  // exactly what died. Concurrent kills made both impossible — one rejection
  // abandoned the tab removal while sibling kills kept deleting metadata.
  const closeOperationMembers = useCallback(
    async (operation: CloseOperation, memberIds: readonly SessionId[]) => {
      for (const memberId of memberIds) {
        try {
          await closeApprovedTarget(memberId, operation)
        } catch (error) {
          operation.pending.delete(memberId)
          operation.failed.add(memberId)
          console.warn('[workspace] a session in a close operation failed to close; it stays open:', error)
        }
      }
    },
    [closeApprovedTarget],
  )

  // attachDetachedToGrid, attachAllDetachedForTab, detachSessionToDispatch,
  // detachFocusedToDispatch and commitNewAgentPlacement lived here until the
  // unified layout (#992). All five moved a session between a tile tree and
  // the pool, or spawned one at a chosen split. There is no tree: every
  // session is a pool member and is shown by selecting it into a lane.

  // One close implementation owns both row buttons and the keyboard command.
  // The former focused-grid copy silently made the sole leaf a tab close;
  // delegating by stable ID ensures every human entry sees the scope choice.
  // A missing Dispatch target closes NOTHING — see resolveFocusedCloseTarget.
  const closeFocused = useCallback(async () => {
    const targetId = resolveFocusedCloseTarget(refs.stateRef.current)
    if (targetId) await closeSessionRef.current?.(targetId, { killCaller: 'close.focused' })
  }, [refs.stateRef])

  // Mirrors closeFocused but operates on a caller-specified session
  // instead of the active tab's focused pane. Exists so UI surfaces
  // that list multiple panes at once (e.g. the Agent Activity
  // modal) can close stale sessions without first having to
  // focus-then-close, which would jank the visible layout for every
  // close and race with React's batched setState.
  //
  // Uses stateRef.current for the same reason buryFocused does: the
  // caller's action isn't bound to whatever happens to be active.
  const closeSession = useCallback(
    async (targetId: SessionId, options?: CloseSessionOptions) => {
      // Cheap existence check first, so we never open a dialog about a session
      // that has already gone.
      const initial = refs.stateRef.current
      if (!sessionPlacement(initial, targetId)) return false

      // One place turns a refusal into what the caller sees. A silent no-op
      // after the user approved a close is indistinguishable from a broken
      // button, so human paths get a toast; callers that report outcomes
      // themselves (onRefused) get the reason instead.
      const refuse = (reason: CloseRefusalReason): false => {
        if (options?.onRefused) {
          options.onRefused(reason)
        } else if (reason === 'changed') {
          showToast(CLOSE_CHANGED_TOAST)
        } else if (reason === 'linked-session-open') {
          const meta = refs.stateRef.current.sessions[targetId] ?? initial.sessions[targetId]
          showToast(`Kept “${meta ? sessionDisplayTitle(meta) : 'this session'}” open — a linked session is still open.`)
        }
        return false
      }

      // CONFIRMATION GATE. This path was previously ungated entirely, which
      // made it the way around the policy rather than an implementation of it:
      // the Agent Activity modal's Close button and every MCP-driven close ran
      // straight through, cascade and all, with no dialog. `closeFocused`
      // delegates here for every surface, so they ask exactly once.
      //
      // Every branch below ends in ONE value: `approved`, the exact snapshot
      // list the user (or the policy) authorized, with the activity they saw.
      // The operation then executes that list and nothing else.
      let approved: readonly CloseTargetSnapshot[] | null = null
      // A three-way "Close agent / Close tab / Cancel" dialog opened here until
      // #992, for ONE structural case: the target was its tab's sole tile leaf
      // while the tab still held Dispatch rows. The tree could not be empty,
      // so the honest options were "promote a row into the tree" or "end the
      // whole project", and the user had to pick. No session is a root now:
      // closing any session leaves the rest of its project exactly as it was,
      // so there is no second scope to offer, and Close Tab is its own command.
      // Resolve the automation modes HERE, where paneCloseTargets is in scope —
      // it is the only code that computes the full set a close destroys, which
      // is exactly what the caller cannot know from the outside.
      let force = options?.requireConfirmation
      if (!approved && options?.preConfirmed) {
        // A preConfirmed grant is exactly as wide as the session it NAMES
        // (#886 review round 2 N7). Its only production caller, bulk cleanup,
        // already narrows it with onlyIf; before this change a bare
        // `preConfirmed: true` silently approved the whole linked expansion —
        // the one thing the contract above says nobody may assert — and tests
        // using it as a dialog shortcut were a template for doing exactly that.
        // Naming one session cannot approve its children, so they keep it open.
        approved = paneCloseTargets(refs.stateRef.current, refs.latestRuntimesRef.current, targetId)
          .filter(target => target.sessionId === targetId)
      } else if (!approved && options?.silentIfSoleTarget) {
        const expanded = paneCloseTargets(refs.stateRef.current, refs.latestRuntimesRef.current, targetId)
        if (expanded.length === 1 && expanded[0]?.sessionId === targetId) approved = expanded
        else force = options.silentIfSoleTarget
      }
      if (!approved) {
        let shown: readonly CloseTargetSnapshot[] = []
        const gate = await runCloseConfirmationGate({
          enumerate: () =>
            paneCloseTargets(refs.stateRef.current, refs.latestRuntimesRef.current, targetId),
          ask: request => {
            shown = request.targets
            return requestCloseConfirmation(request)
          },
          force,
        })
        if (!gate.ok) return gate.reason === 'changed' ? refuse('changed') : false
        approved = withShownLiveness(gate.targets, shown)
      }

      // Built synchronously after approval, so the recorded project and meta of
      // every approved session describe the workspace the user approved.
      const operation = beginCloseOperation(
        refs.stateRef.current,
        targetId,
        approved,
        options?.onlyIf,
        options?.killCaller ?? 'unknown',
      )
      // The named session itself. A thrown kill is recorded like any member's
      // and rethrown only AFTER the operation is recorded and reported, so bulk
      // cleanup's `failed` bucket and orchestration's catch keep working while
      // the children that already closed are still recoverable and named.
      let closed = false
      let thrown: { error: unknown } | null = null
      try {
        closed = (await closeApprovedTarget(targetId, operation)).closed
      } catch (error) {
        operation.pending.delete(targetId)
        operation.failed.add(targetId)
        thrown = { error }
      }
      const undoRecorded = options?.captureUndo !== false &&
        recordOperationUndo(refs.undoStackRef.current, operation)
      const namedMeta = initial.sessions[targetId]
      const message = describeCloseOperation(
        operation,
        { id: targetId, title: namedMeta ? sessionDisplayTitle(namedMeta) : 'this session', closed },
        undoRecorded,
      )
      if (thrown) {
        if (message && !options?.onRefused) showToast(message)
        throw thrown.error
      }
      if (!closed) {
        // PARTIAL, not a refusal (#886 review round 2): approved members before
        // the named session really closed. The toast names both sides and the
        // entry recorded above covers them. The named session is still open,
        // so the result stays false — see closeSession's return doc.
        if (operation.commits.length > 0 && !options?.onRefused) {
          if (message) showToast(message)
          return false
        }
        const reason = operation.refused.get(targetId)
        return reason ? refuse(reason) : false
      }
      if (message) showToast(message)
      return true
    },
    [closeApprovedTarget, closeOperationMembers, refs.latestRuntimesRef, refs.stateRef, refs.undoStackRef, showToast],
  )
  closeSessionRef.current = closeSession

  // The Close Tab command (⌘⇧W, the tab bar ×, the `close-tab` palette entry):
  // end every session the project owns, and every linked descendant of one,
  // whichever project that descendant is filed under.
  //
  // WHY it lives here and runs the same operation as the root dialog's Close Tab
  // (#886 review round 2, Codex majors 1 and 2, Claude N2): the command's own
  // copy in tab.ts listed that expanded set in its dialog but killed only the
  // tab's leaves and rows, pushed its undo entry and "Closed" toast BEFORE
  // killing, and killed with Promise.all. So a cross-project linked child was
  // promised dead and survived with a dead parent, and one rejected kill left a
  // tab whose tree named a deleted session plus an undo entry for a tab that
  // was never removed. Here the approved list IS the kill list; members close
  // deepest-first, each re-judged at its own kill boundary; undo and the toast
  // describe only what committed; and a partial close leaves the project
  // holding its survivors.
  const closeTab = useCallback(
    async (tabId: TabId) => {
      if (!refs.stateRef.current.tabs.some(tab => tab.id === tabId)) return
      let shown: readonly CloseTargetSnapshot[] = []
      const gate = await runCloseConfirmationGate({
        // Live state on every call: the gate re-enumerates after the dialog and
        // refuses a plan that changed under it.
        enumerate: () => {
          const state = refs.stateRef.current
          const tab = state.tabs.find(candidate => candidate.id === tabId)
          return tab
            ? expandTabCloseTargets(state, refs.latestRuntimesRef.current, resolveTabSessions(state, tabId))
            : []
        },
        ask: request => {
          shown = request.targets
          return requestCloseConfirmation(request)
        },
      })
      if (!gate.ok) {
        if (gate.reason === 'changed') {
          showToast('Close cancelled — this tab changed while the dialog was open. Try again.')
        }
        return
      }
      const approvalState = refs.stateRef.current
      const tab = approvalState.tabs.find(candidate => candidate.id === tabId)
      if (!tab || gate.targets.length === 0) return
      const operation = beginCloseOperation(
        approvalState,
        null,
        withShownLiveness(gate.targets, shown),
        undefined,
        'close.tab',
      )
      // Deepest linked descendants first, so a child always closes before the
      // parent that would otherwise be kept open for it. The project itself
      // leaves with whichever commit takes its last session; if a member
      // changed or failed, that commit never happens and the project stays,
      // holding exactly the sessions that are still alive. (Until #992 the
      // tab's tile leaves had to be ordered LAST so the tree stayed valid.)
      const members = [...operation.approved.keys()]
        .sort((a, b) => linkedDepth(approvalState, b) - linkedDepth(approvalState, a))
      await closeOperationMembers(operation, members)
      const undoRecorded = recordOperationUndo(refs.undoStackRef.current, operation)
      const message = describeCloseOperation(operation, null, undoRecorded)
      if (message) {
        showToast(message)
      } else if (operation.commits.length === 0 && (operation.failed.size > 0 || operation.refused.size > 0)) {
        // Nothing closed after the user approved: say so rather than go silent,
        // which reads as a broken command.
        showToast(`Close Tab did not close “${tab.title}” — its sessions changed or failed to close.`)
      }
    },
    [closeOperationMembers, refs.latestRuntimesRef, refs.stateRef, refs.undoStackRef, showToast],
  )

  // requestBuryFocused / buryFocused / reviveBuried / killBuried lived here
  // until #992. Bury took a pane out of the tree and kept it alive in an
  // archive; in the pool-first workspace that is simply an unplaced session,
  // so there is nothing to bury into, revive from, or kill separately.
  // Persisted `buried` records become ordinary pool rows when an old file is
  // migrated (legacyWorkspaceV2.ts legacyMemberships).

  // `focusSession(sessionId)` lived here until #992: it wrote the active tab's
  // tree focus. It had no caller left once the tree stopped rendering.

  // Make a session's project the active one, and follow it inside Spotlight.
  //
  // This does NOT put the session on screen — it never did on the stage. Its
  // job used to be "move the tile tree's focus to this leaf", which showed
  // the agent because the tree rendered it. A caller that wants an agent
  // SHOWN uses focusAgentBySessionId (existing lane, else the focused lane,
  // waking it first). What is left here is what the two remaining callers
  // need: Spotlight's leaf asking for focus, and keeping the active project —
  // a label (U4) — pointed at where the user is working.
  const focusSessionInTab = useCallback(
    (tabId: string, sessionId: SessionId) => {
      setState(prev => (prev.activeTabId === tabId ? prev : { ...prev, activeTabId: tabId }))
      setSpotlight(prev => (
        prev && prev.tabId === tabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
    },
    [setSpotlight, setState],
  )


  // Open a contributed extension view as a PANE (a tile leaf), not a modal.
  //
  // Unlike every other pane this creates NO backing process: an extension view is
  // pure renderer UI reconstructed from SessionMeta.extensionViewId by
  // ExtensionViewLeaf. So it deliberately does NOT call sessionActions.spawn (which
  // mints the SessionId in MAIN by starting a PTY/agent). It mints its own id — the
  // one place the renderer is allowed to, the same as tab ids — writes the meta
  // directly, and splits beside the focused pane. collectLiveProcessIds excludes
  // 'extension-view', so rehydrate reconstructs this leaf from metadata and never
  // tries to recover a process for it.
  const openExtensionViewInPane = useCallback(
    (viewId: string, options?: OpenExtensionViewOptions) => {
      // Resolve placement INSIDE the synchronous workspace update. There is no
      // process await here, so metadata, ownership and visible focus can land as
      // one change rather than leaving a session whose split silently failed.
      let openedId: SessionId | null = null
      let revealedId: SessionId | null = null
      let pooled = false
      setState(prev => {
        if (options?.reveal) {
          const revealed = revealExtensionView(prev, viewId)
          if (revealed) {
            revealedId = revealed.stage.lanes[revealed.stage.focusedLane]?.selectedSessionId ?? null
            return revealed
          }
        }
        const sessionId = crypto.randomUUID() as SessionId
        // (This block sat behind `if (dispatchMode)` until #992, with a
        // tile-tree branch — split beside the focused leaf — after it.)
        //
        // The visible target may be a row of a different project from the
        // active one. Follow the same placement contract as new
        // terminals/agents: file the view under the visible target's project,
        // and fill the focused lane only when it is empty (context-places).
        const target = resolveDispatchSpawnTarget(prev)
        const tab = prev.tabs.find(t => t.id === target.tabId)
        if (!tab) return prev
        openedId = sessionId
        const cwd = (target.cwdSessionId ? prev.sessions[target.cwdSessionId]?.cwd : undefined)
          ?? projectCwd(prev, tab.id)
          ?? ''
        // A plain "Open view" follows context-places: it fills an empty
        // focused lane and otherwise waits in the pool with a "new" badge.
        // A reveal is a caller that needs the view ON SCREEN (a legacy action
        // command runs only inside a mounted frame), so it takes the focused
        // lane. Its occupant returns to the pool alive, as with an index click.
        const focusedLane = prev.stage.focusedLane
        const stage = options?.reveal && prev.stage.lanes[focusedLane]
          ? {
              ...prev.stage,
              lanes: prev.stage.lanes.map((lane, i) => (i === focusedLane ? withLaneSession(lane, sessionId) : lane)),
            }
          : applyDispatchSpawnFocus(prev, sessionId, target.laneIndex)
        pooled = stage === prev.stage
        return {
          ...prev,
          activeTabId: tab.id,
          sessions: {
            ...prev.sessions,
            // Written already FILED: there is no spawn to write the row first.
            [sessionId]: {
              cwd, kind: 'extension-view', extensionViewId: viewId,
              projectId: tab.id, joinedAt: Date.now(),
            },
          },
          stage,
        }
      })
      if (openedId !== null && pooled) markPooledSpawn(setRuntimes, openedId)
      if (revealedId !== null) clearPooledSpawnBadge(setRuntimes, revealedId)
    },
    [setRuntimes, setState],
  )

  return {
    splitFocused,
    startNewAgentPlacement,
    // Shells and agents share detached placement and post-spawn ownership
    // checks. Preserve the narrower agent entry point for existing pickers.
    createDetachedSession: createDetachedDispatchAgent,
    createDetachedDispatchAgent,
    createLinkedAgent,
    createOrchestrationAgent,
    closeFocused,
    closeSession,
    closeTab,
    focusSessionInTab,
    openExtensionViewInPane,
  }
}

// `dispatchModeAfterSessionRemoval` lived here until #992. It did two jobs:
// clear the closed session out of any lane, then pick a SUCCESSOR for the
// classic-Dispatch single focus (project-first, same visual position; #261).
// The second job existed because classic Dispatch showed exactly one agent, so
// closing it had to show another. The stage has no such field: a lane that
// loses its occupant goes EMPTY and stays empty until the user names a new one
// (U2, #681) — refilling it with a neighbour is precisely the displacement
// #681 removed. So the whole helper reduced to `clearTiledLaneSessions`, which
// the three close commits now call directly.
