import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { AGENT_PROVIDER_CHOICES } from '@renderer/workspace/providerChoices'
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
  dispatchModeAfterSessionRemovals,
  workspaceWithoutTab,
} from '@renderer/workspace/hook/actions/tabRemoval'
import { requestCloseConfirmation, requestRootCloseConfirmation } from '@renderer/workspace/closeConfirmationBroker'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import { useCallback, useRef } from 'react'

import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionKind,
  SessionMeta,
  SessionSpawnSelection,
  SplitDirection,
  Tab,
  TabId,
  TileNode,
  WorkspaceState,
} from '@renderer/workspace/types'
import type { AgentProviderRuntime } from '@shared/types/providerKind'
import { RATIO_DEFAULT } from '@renderer/workspace/types'
import {
  closeLeaf,
  collectLeaves,
  insertBesideLeaf,
  normalizeTree,
  splitLeaf,
  wrapRootWithLeaf,
  wrapRootWithNode,
} from '@renderer/workspace/tile-tree/treeOps'
import { findBestRemainingFocus, findDirectionalNeighbor } from '@renderer/workspace/tile-tree/geometry'
import { findParentSplitInfo } from '@renderer/lib/undoClose'
import type { ClosedTab, ClosedTabDetachedEntry, SingleClosedEntry, UndoCloseStack } from '@renderer/lib/undoClose'
import { titleFromCwd } from '@renderer/workspace/layout/helpers'
import {
  buildVisibleDispatchRows,
  detachedDispatchSessionIdsForTab,
  resolveDispatchSpawnTarget,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  clearTiledLaneSessions,
  withLaneSession,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { PlacementTarget } from '@renderer/features/workspace/lib/newAgentPlacement'
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
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import {
  killSessionBackendIfOwned,
  type SessionActions,
} from '@renderer/workspace/hook/actions/session'

// -----------------------------------------------------------------------------
// Pane / focus / navigation actions.
//
// Covers: splitFocused, startNewAgentPlacement, commitNewAgentPlacement,
// closeFocused, closeSession, requestBuryFocused, buryFocused,
// reviveBuried, killBuried, focusSession, focusSessionInTab, navigate.
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
}

type DetachedTabChildren = {
  records: DetachedSessionRecord[]
  ids: SessionId[]
}

function detachedTabChildren(state: WorkspaceState, tabId: string): DetachedTabChildren {
  // WHY projectTabId is authoritative here: detached sessions deliberately
  // have no tile-tree leaf. Their persisted projectTabId is the only ownership
  // edge tying them to the tab whose final visible pane is being removed.
  // Ignoring that edge creates an invisible orphan; the save-time ownership
  // sanitizer then correctly prunes it, turning a UI action into data loss.
  const records = Object.values(state.detachedSessions)
    .filter(entry => entry.projectTabId === tabId)

  return {
    records,
    ids: records.map(entry => entry.sessionId),
  }
}

/**
 * The next displayed Dispatch row becomes the grid root. Object insertion
 * order is not row order after persistence/undo; reuse the list's ordering so
 * closing the first agent does not shuffle the remaining project.
 *
 * `excluded` must be EVERY session the current close operation has approved
 * and not yet finished — not just the session whose leaf is being removed.
 * #886 review finding 3: parent P (detached) with linked child C as the tab's
 * sole grid leaf. Closing P closes C first; C's promotion used to exclude only
 * C, so it promoted P into the root, and P's own close then deleted P's
 * metadata while the tab's root and focus still named it — a tab rooted at a
 * deleted session. A session the operation is about to kill can never be the
 * survivor that keeps a project alive.
 */
function detachedRootReplacement(
  state: WorkspaceState,
  tabId: TabId,
  excluded: ReadonlySet<SessionId>,
): DetachedSessionRecord | undefined {
  const id = detachedDispatchSessionIdsForTab(state, tabId).find(id => !excluded.has(id))
  return id === undefined ? undefined : state.detachedSessions[id]
}

/**
 * Where a session lives right now. Buried sessions resolve to null on purpose:
 * closeSession never ends them (Kill Buried owns that irreversible act).
 */
type SessionPlacement =
  | { kind: 'grid'; tab: Tab; tabIndex: number }
  | { kind: 'detached'; record: DetachedSessionRecord }

function sessionPlacement(state: WorkspaceState, sessionId: SessionId): SessionPlacement | null {
  const tabIndex = state.tabs.findIndex(tab => collectLeaves(tab.root).includes(sessionId))
  if (tabIndex >= 0) return { kind: 'grid', tab: state.tabs[tabIndex], tabIndex }
  const record = state.detachedSessions[sessionId]
  return record ? { kind: 'detached', record } : null
}

/** A session's project: the tab owning its grid leaf, or its Dispatch row's
 *  projectTabId. The approved plan records this so a session moved to another
 *  project under the dialog (attach, merge) is refused rather than killed. */
function placementProjectTabId(placement: SessionPlacement | null): TabId | null {
  if (!placement) return null
  return placement.kind === 'grid' ? placement.tab.id : placement.record.projectTabId
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

function closeNoun(meta: SessionMeta | undefined): 'agent' | 'terminal' {
  return meta?.kind === 'terminal' ? 'terminal' : 'agent'
}

function sameTargetIds(a: readonly CloseTargetSnapshot[], b: readonly CloseTargetSnapshot[]): boolean {
  if (a.length !== b.length) return false
  const ids = new Set(b.map(target => target.sessionId))
  return a.every(target => ids.has(target.sessionId))
}

type ApprovedCloseTarget = {
  /** Activity the approver saw. Idle then + working now = refused. */
  live: boolean
  /** Project at approval; see placementProjectTabId. */
  projectTabId: TabId | null
  /** Captured at approval for the operation's Undo Close entry: by the time the
   *  top-level target records undo, each member's own close has already deleted
   *  its metadata and Dispatch record from state. */
  meta: SessionMeta | undefined
  record: DetachedSessionRecord | undefined
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
 *   - Root promotion PREFERS a Dispatch row the operation is not about to
 *     close, but falls back to a pending member rather than remove a tab that
 *     still files one; a tab is removed only when no Dispatch row is filed
 *     under it. Every member re-resolves its placement from the live store at
 *     commit, so a promoted pending member that then closes promotes the next
 *     row or removes the tab itself, and one that is then kept simply stays
 *     placed. (#886 review round 2 N1: round 1 excluded pending members
 *     outright. A member kept AFTER that removal — it changed, a sibling kept
 *     it, its kill threw — was left filed under a deleted tab: invisible in
 *     Dispatch, dropped by the next autosave, backend still running.)
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
  /** Each approved session's project tab as it stood at approval. A tab this
   *  operation removes is recorded for undo from THIS snapshot — its whole tile
   *  tree and position — because by the time the removing commit happens the
   *  earlier members' commits have already reshaped it. */
  approvalTabs: ReadonlyMap<TabId, { tab: Tab; tabIndex: number }>
  admit?: CloseSessionOptions['onlyIf']
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
): CloseOperation {
  const approved = new Map<SessionId, ApprovedCloseTarget>()
  const approvalTabs = new Map<TabId, { tab: Tab; tabIndex: number }>()
  for (const target of approvedTargets) {
    const projectTabId = placementProjectTabId(sessionPlacement(state, target.sessionId))
    approved.set(target.sessionId, {
      live: target.live,
      projectTabId,
      meta: state.sessions[target.sessionId],
      record: state.detachedSessions[target.sessionId],
    })
    const tabIndex = projectTabId ? state.tabs.findIndex(tab => tab.id === projectTabId) : -1
    if (tabIndex >= 0) approvalTabs.set(state.tabs[tabIndex].id, { tab: state.tabs[tabIndex], tabIndex })
  }
  return {
    rootId,
    approved,
    approvalTabs,
    admit,
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

type CommittedClose =
  | { kind: 'gone' }
  | { kind: 'detached'; record: DetachedSessionRecord }
  | { kind: 'pane'; tabId: TabId; parentInfo: NonNullable<ReturnType<typeof findParentSplitInfo>> }
  | { kind: 'promoted'; tab: Tab; tabIndex: number; survivor: DetachedSessionRecord }
  | { kind: 'tab-removed'; tab: Tab; tabIndex: number }

const UNDO_HINT = ' — ⌘⇧T Undo Close; repeat for earlier closes'

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
 * The ClosedTab for a project this operation removed, built from the approval
 * snapshot: the original tile tree pruned to the leaves that closed, plus every
 * closed member filed under that project as a Dispatch row.
 *
 * WHY the approval snapshot and not the removing commit's tab: members close
 * one at a time, so by the time the last leaf removes the tab the earlier
 * commits have already collapsed its splits and promoted rows. Recording that
 * final one-leaf tab (round 1's shape) made undo bring back whichever session
 * happened to close last as the root; recording the approval tree brings back
 * the project the user closed.
 */
function removedTabUndo(
  operation: CloseOperation,
  removed: { tab: Tab; tabIndex: number },
  removerId: SessionId,
  closedAt: number,
): ClosedTab | null {
  const closed = new Set(operation.commits.map(commit => commit.sessionId))
  const snapshot = operation.approvalTabs.get(removed.tab.id) ?? removed
  let root: TileNode | null = snapshot.tab.root
  for (const leaf of collectLeaves(snapshot.tab.root)) {
    if (root && !closed.has(leaf)) root = closeLeaf(root, leaf)
  }
  const tree: TileNode = root ?? { type: 'leaf', sessionId: removerId }
  const leaves = collectLeaves(tree)
  const sessionMetas: Record<SessionId, SessionMeta> = {}
  for (const leaf of leaves) {
    const meta = operation.approved.get(leaf)?.meta
    // A leaf with no captured metadata cannot be respawned; the entry would be
    // judged stale at undo time anyway, so do not record a lie.
    if (!meta) return null
    sessionMetas[leaf] = meta
  }
  const detachedEntries: ClosedTabDetachedEntry[] = operation.commits.flatMap(commit => {
    const approved = operation.approved.get(commit.sessionId)
    if (leaves.includes(commit.sessionId) || approved?.projectTabId !== removed.tab.id || !approved.meta) return []
    // A row keeps its detachedAt so it returns to its position; a session that
    // was a grid leaf elsewhere at approval sorts after the project's own rows,
    // where createLinkedAgent files a new child.
    return [{ sessionId: commit.sessionId, meta: approved.meta, detachedAt: approved.record?.detachedAt ?? operation.startedAt }]
  })
  return {
    type: 'tab',
    closedAt,
    tab: {
      ...snapshot.tab,
      root: tree,
      focusedSessionId: leaves.includes(snapshot.tab.focusedSessionId) ? snapshot.tab.focusedSessionId : leaves[0],
    },
    tabIndex: snapshot.tabIndex,
    sessionMetas,
    detachedEntries: detachedEntries.length > 0 ? detachedEntries : undefined,
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
 *   - Every other commit becomes the entry of its own shape: a split pane, a
 *     Dispatch row, or a root replaced by a promoted row. Each keeps its
 *     session id / anchors so group undo can re-anchor it through lineage.
 *   - One unit is pushed as itself; several as one ClosedGroup in commit order.
 *     That is what makes a PARTIAL operation recoverable (#886 review round 2):
 *     a parent kept because a child changed while its other children already
 *     closed used to leave those children with no entry at all.
 *
 * WHY this does not WHY-duplicate the per-shape rationale: the detached shape
 * exists because a closed Dispatch TERMINAL's tmux session survives and the
 * next launch's reconcile would kill it as an orphan without an entry carrying
 * `tmuxName` (#671, src/main/tmux/tmuxRecovery.ts); the record is stored
 * verbatim so `detachedAt` — the only thing ordering rows inside a project
 * group — survives. A promoted root's row keeps its approval-time detachedAt
 * when it had one, for the same reason.
 */
function recordOperationUndo(stack: UndoCloseStack, operation: CloseOperation): boolean {
  const closedAt = Date.now()
  const removedTabIds = new Set(operation.commits.flatMap(commit =>
    commit.outcome.kind === 'tab-removed' ? [commit.outcome.tab.id] : []))
  const units: SingleClosedEntry[] = []
  for (const { sessionId, meta, outcome } of operation.commits) {
    const approved = operation.approved.get(sessionId)
    if (outcome.kind === 'tab-removed') {
      const unit = removedTabUndo(operation, outcome, sessionId, closedAt)
      if (unit) units.push(unit)
      continue
    }
    // Filed under a project this operation removed: folded into that tab's
    // entry. Placement checks guarantee nothing filed there commits after the
    // removal (a tab is removed only when no row is left under it).
    if (approved?.projectTabId && removedTabIds.has(approved.projectTabId)) continue
    if (!meta) continue
    if (outcome.kind === 'pane') {
      units.push({
        type: 'pane',
        closedAt,
        tabId: outcome.tabId,
        sessionId,
        sessionMeta: meta,
        direction: outcome.parentInfo.direction,
        ratio: outcome.parentInfo.ratio,
        side: outcome.parentInfo.side,
        siblingLeafId: outcome.parentInfo.siblingLeafId,
      })
    } else if (outcome.kind === 'detached') {
      units.push({ type: 'detached', closedAt, sessionMeta: meta, record: outcome.record })
    } else if (outcome.kind === 'promoted') {
      // The project survives. Undo restores this session within that project
      // and never respawns the promoted survivor or duplicates the whole tab.
      units.push({
        type: 'detached',
        closedAt,
        sessionMeta: meta,
        record: {
          ...detachedDispatchRecord(sessionId, outcome.tab, outcome.tabIndex),
          ...(approved?.record ? { detachedAt: approved.record.detachedAt } : {}),
        },
        replacedRoot: outcome.survivor,
      })
    }
  }
  if (units.length === 0) return false
  stack.push(units.length === 1 ? units[0] : { type: 'group', closedAt, entries: units })
  return true
}

/** The toast for one committed unit, when the operation closed everything it
 *  approved. Without a recorded undo entry only a Dispatch row still toasts —
 *  the long-standing behavior for bulk and fleet closes of other shapes. */
function describeCommittedClose(commit: CommittedMember, undoRecorded: boolean): string | null {
  const { meta, outcome } = commit
  const kindLabel = meta?.kind ?? DEFAULT_PROVIDER
  const cwdBase = meta?.cwd.split('/').filter(Boolean).pop() ?? meta?.cwd ?? 'session'
  const hint = undoRecorded ? UNDO_HINT : ''
  if (outcome.kind === 'detached') return `Closed detached ${kindLabel} session (${cwdBase})${hint}`
  if (!undoRecorded) return null
  if (outcome.kind === 'pane') return `Closed ${kindLabel} pane (${cwdBase})${hint}`
  if (outcome.kind === 'promoted') return `Closed ${closeNoun(meta)}${hint}`
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
  return `Closed ${operation.commits.length} of ${operation.approved.size} listed sessions — ${reasons.join('; ')}${undoRecorded ? UNDO_HINT : ''}`
}

/**
 * The confirmation and the mutation share an explicit scope. Session is the
 * default even for the final grid leaf: layout ownership does not authorize
 * killing its detached siblings. Only the human root-scope dialog can choose
 * tab scope. Keeping that distinction here prevents the old preview-one /
 * terminate-project mismatch from reappearing in another close entry point.
 */
function paneCloseTargets(
  state: WorkspaceState,
  runtimes: CloseExpansionRuntimes,
  targetId: SessionId,
  scope: 'session' | 'tab' = 'session',
): CloseTargetSnapshot[] {
  const owningTab = state.tabs.find(tab => collectLeaves(tab.root).includes(targetId))
  // A detached target, or a pane inside a split: the tab survives, so only the
  // linked cascade dies.
  if (scope === 'session' || !owningTab || findParentSplitInfo(owningTab.root, targetId)) {
    return expandSessionCloseTargets(state, runtimes, targetId)
  }
  return expandTabCloseTargets(
    state,
    runtimes,
    [targetId],
    detachedTabChildren(state, owningTab.id).ids,
  )
}

/**
 * The session Close Focused Session would end, captured ONCE. closeSession
 * carries that id through any dialog rather than rereading whichever row
 * gains focus later.
 *
 * WHY Dispatch Mode never falls back to grid focus (#886 review finding 1,
 * a blocker): `Tab.focusedSessionId` is grid-only, and in Tiled Dispatch the
 * grid is hidden. `commandTargetSessionIdForState` deliberately returns null
 * for an empty lane, a lane holding a dead id, or a lane holding a session
 * outside the visible scope — visually "no agent is selected here". The first
 * version of this helper then fell through to the active tab's grid focus, so
 * pressing Close Focused Session on an empty lane killed the hidden grid agent
 * (silently when idle, taking the project with it when it was the sole leaf).
 * Main's old closeFocused had an `if (snapshot.dispatchMode) return` guard;
 * this is that guard, stated where the target is chosen.
 *
 * In CLASSIC Dispatch the strict resolver still yields a row when
 * `dispatchMode.focusedSessionId` is stale (after a scope switch, rehydrate
 * miss or rapid close): it applies the same fallback DispatchLayout uses to
 * highlight a row — classic focus, then grid focus, then the first visible
 * row — so the highlighted row and the destructive target cannot diverge. Only
 * Tiled Dispatch's lanes are strict, because an empty lane is a real visual
 * state there. Outside Dispatch the command target already includes a
 * visibly selected related child; the grid focus is its own fallback.
 */
function resolveFocusedCloseTarget(state: WorkspaceState): SessionId | undefined {
  const commandTarget = commandTargetSessionIdForState(state)
  if (commandTarget) return commandTarget
  if (state.dispatchMode) return undefined
  return state.tabs.find(tab => tab.id === state.activeTabId)?.focusedSessionId
}

/**
 * Why a close stopped, phrased for a toast.
 *
 * A silent no-op after the user clicked "Close" is indistinguishable from a
 * broken button. 'declined' is the user's own choice and needs no message.
 */
const CLOSE_CHANGED_TOAST =
  'Close cancelled — these sessions changed while the dialog was open. Try again.'

// Update dispatchMode after a new dispatch agent is spawned. In Tiled
// Dispatch the new agent takes over the lane the user is commanding
// (target.laneIndex) so it appears where they were looking; in classic
// Dispatch it becomes the single focus. Setting focusedSessionId in both
// cases keeps classic focus coherent if the user later exits the tiled view.
// The lane index is re-validated here (a stale resolution could outrun a
// concurrent count change), falling back to a plain focus update.
function applyDispatchSpawnFocus(
  dispatchMode: DispatchModeState | null,
  sessionId: SessionId,
  laneIndex: number | null,
): DispatchModeState | null {
  if (!dispatchMode) return dispatchMode
  const tiled = dispatchMode.tiled
  if (laneIndex !== null && tiled && laneIndex >= 0 && laneIndex < tiled.lanes.length) {
    const lanes = tiled.lanes.map((lane, i) =>
      i === laneIndex ? withLaneSession(lane, sessionId) : lane,
    )
    return {
      ...dispatchMode,
      focusedSessionId: sessionId,
      tiled: { ...tiled, lanes, focusedLane: laneIndex },
    }
  }
  return { ...dispatchMode, focusedSessionId: sessionId }
}

/**
 * The durable record that files a session as a Dispatch row for a project.
 *
 * WHY this is one helper instead of the literal being written at each spawn
 * site: `splitFocused`'s Dispatch branch and `createDetachedDispatchAgent`
 * built byte-identical objects, and the shape is a persistence contract —
 * `projectTabId` drives Dispatch grouping, cwd defaults, and attach targeting,
 * while `detachedAt` is the ONLY thing that orders rows inside a project group
 * (see buildDispatchGroups). Two hand-written copies of a durable shape is how
 * one of them silently drifts.
 *
 * `projectTabIndex` is a display ordinal that buildDispatchGroups recomputes
 * from `state.tabs` on every render; it is seeded here only so a record read
 * before the next render has something sane, which is why a missing tab
 * collapses to 0 rather than refusing to build the record.
 */
function detachedDispatchRecord(
  sessionId: SessionId,
  tab: Tab,
  tabIndex: number,
): DetachedSessionRecord {
  return {
    sessionId,
    surface: 'dispatch',
    projectTabId: tab.id,
    projectTabTitle: tab.title,
    projectTabIndex: tabIndex >= 0 ? tabIndex : 0,
    detachedAt: Date.now(),
  }
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
    detachedSessions: Record<SessionId, DetachedSessionRecord>
    dispatchMode: DispatchModeState | null
    sessions: Record<SessionId, SessionMeta>
    tabs: Tab[]
  },
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setSpotlight: WorkspaceSetSpotlight,
  setTileTabs: WorkspaceSetTileTabs,
  // Reader Mode joins the other takeover setters so an emptied tab is cleaned
  // up by the same tail as the Close Tab command (tabRemoval.ts), instead of
  // leaving a Reader takeover on a removed tab for an effect to heal later.
  setReaderMode: WorkspaceSetReaderMode,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  openBuryPrompt: (sessionId: SessionId) => void,
  closeBuryPrompt: () => void,
  openNewAgentPlacement: () => void,
  closeNewAgentPlacement: () => void,
  sessionActions: SessionActions,
): {
  splitFocused: (
    direction: SplitDirection,
    kind?: SessionKind,
    continuation?: SplitFocusedContinuation,
  ) => Promise<void>
  startNewAgentPlacement: () => void
  commitNewAgentPlacement: (selection: SessionSpawnSelection, target: PlacementTarget) => Promise<void>
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
    selection: SessionSpawnSelection & { kind: Exclude<SessionKind, 'terminal'> },
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
  attachDetachedToGrid: (sessionId: SessionId, targetTabId: string, target: PlacementTarget) => Promise<void>
  attachAllDetachedForTab: (tabId: string) => Promise<void>
  detachSessionToDispatch: (sessionId: SessionId) => void
  detachFocusedToDispatch: () => void
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
  requestBuryFocused: () => void
  buryFocused: (note?: string, targetSessionId?: SessionId) => void
  reviveBuried: (buriedId: string) => Promise<void>
  killBuried: (buriedId: string) => Promise<void>
  focusSession: (sessionId: SessionId) => void
  focusSessionInTab: (tabId: string, sessionId: SessionId) => void
  navigate: (direction: 'left' | 'right' | 'up' | 'down') => void
} {
  const closeSessionRef = useRef<
    ((targetId: SessionId, options?: CloseSessionOptions) => Promise<boolean>) | null
  >(null)

  // Spawns a new session in the parent pane's cwd, inserts a new
  // leaf under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (
      direction: SplitDirection,
      kind: SessionKind = 'claude',
      continuation?: SplitFocusedContinuation,
    ) => {
      const resumeSessionId = continuation?.resumeSessionId
      const builtInMcpOverrides = continuation?.builtInMcpOverrides
      const providerRuntime = continuation?.providerRuntime
      const dispatchSnapshot = refs.stateRef.current
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
      if (dispatchSnapshot.dispatchMode) {
        // Same target resolution as createDetachedDispatchAgent: follow the
        // focused lane in Tiled Dispatch so cwd and projectTab agree on the
        // project the user is commanding (issue #266 / #248). Routing terminals
        // through this same resolver is what preserves #366 — project tab and
        // cwd come from the focused lane, never from a stale activeTabId —
        // without needing a terminal-specific resolver to keep in sync.
        const target = resolveDispatchSpawnTarget(dispatchSnapshot)
        const tab = dispatchSnapshot.tabs.find(t => t.id === target.tabId)
        if (!tab) return

        const leafIds = collectLeaves(tab.root)
        // WHY a caller may override the visually focused project cwd: lifecycle commands can
        // target a selected related/orchestration child that is rendered inside a physical parent
        // pane but intentionally runs in another worktree. Its transcript id, enabled MCP domains,
        // and cwd are one continuation identity. Mixing the child's domains with the parent's cwd
        // would mint a fresh token for the wrong project scope.
        const cwd =
          continuation?.cwd ??
          (target.cwdSessionId ? dispatchSnapshot.sessions[target.cwdSessionId]?.cwd : null) ??
          dispatchSnapshot.sessions[tab.focusedSessionId]?.cwd ??
          leafIds.map(id => dispatchSnapshot.sessions[id]?.cwd).find(Boolean)
        if (!cwd) {
          showToast(
            kind === 'terminal'
              ? 'Could not create dispatch terminal: no project directory found'
              : 'Could not create dispatch agent: no project directory found',
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
            kind,
            ...(providerRuntime ? { providerRuntime } : {}),
            resumeSessionId,
            builtInMcpOverrides,
          })
        } catch (err) {
          showToast(
            err instanceof Error && err.message.length > 0
              ? err.message
              : kind === 'terminal'
                ? 'Failed to create dispatch terminal'
                : 'Failed to create dispatch agent',
          )
          return
        }

        // Did the record actually get written? The resolved tab can be closed
        // between the awaited spawn and this commit, in which case `spawn` has
        // already registered a live backend that would then belong to no tile
        // tree and no detached record — an unreachable session leaking in
        // renderer and main state. The terminal branch used to guard this and
        // the agent branch did not; merging keeps the guard and extends it to
        // both kinds rather than preserving the leak in the shared path.
        //
        // Reading a flag set inside the updater is only sound because setState
        // is the zustand store setter, which applies the updater synchronously.
        // If this ever becomes a React useState setter the flag would still be
        // false here and every spawn would be killed on the spot.
        let filed = false
        setState(prev => {
          const latestTab = prev.tabs.find(t => t.id === tab.id)
          if (!latestTab) return prev
          const projectTabIndex = prev.tabs.findIndex(t => t.id === tab.id)
          filed = true

          // WHY splitFocused owns this Dispatch detour instead of making every
          // keybinding and command-palette entry remember Dispatch Mode:
          // `splitFocused` is the old "make me a new session" primitive. Before
          // detached sessions, routing that through the tile tree was correct.
          // In Dispatch Mode it is now wrong: the command-center surface can
          // create many sessions, and those must not mutate the normal grid
          // just because the user used the familiar Option-D/Option-C/Option-T
          // grammar. Keeping the rule here makes all callers agree: normal mode
          // splits the grid; Dispatch Mode creates a detached dispatch row and
          // focuses it immediately.
          return {
            ...prev,
            activeTabId: latestTab.id,
            detachedSessions: {
              ...prev.detachedSessions,
              [sessionId]: detachedDispatchRecord(sessionId, latestTab, projectTabIndex),
            },
            dispatchMode: applyDispatchSpawnFocus(prev.dispatchMode, sessionId, target.laneIndex),
          }
        })

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
            kind,
            ...(providerRuntime ? { providerRuntime } : {}),
            cwd,
          })
            .catch(() => undefined)
          await sessionActions.killSession(sessionId)
          return
        }
        closeNewAgentPlacement()
        return
      }

      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const parentSessionId = tab.focusedSessionId
      const spawnCwd = continuation?.cwd ?? state.sessions[parentSessionId]?.cwd
      if (!spawnCwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await sessionActions.spawn(spawnCwd, {
          kind,
          ...(providerRuntime ? { providerRuntime } : {}),
          resumeSessionId,
          builtInMcpOverrides,
        })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to split pane',
        )
        return
      }

      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: splitLeaf(t.root, parentSessionId, direction, newSessionId),
            focusedSessionId: newSessionId,
          }
        }),
      }))
    },
    [
      closeNewAgentPlacement,
      refs.stateRef,
      sessionActions,
      setState,
      showToast,
      state.activeTabId,
      state.sessions,
      state.tabs,
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
      if (!tab) return null

      const leafIds = collectLeaves(tab.root)
      // A native continuation owns its cwd; the project only owns placement.
      // Reusing the anchor cwd here can resume a transcript in another repo.
      const cwd = continuation?.cwd ??
        (target.cwdSessionId ? snapshot.sessions[target.cwdSessionId]?.cwd : null) ??
        // Do NOT fall back to tab.focusedSessionId: in Tiled Dispatch that's
        // stale grid focus (the focused lane's session is already
        // target.cwdSessionId via resolveDispatchSpawnTarget). Fall back to any
        // leaf cwd of the resolved tab — all are valid project dirs for it.
        leafIds.map(id => snapshot.sessions[id]?.cwd).find(Boolean)
      if (!cwd) {
        showToast('Could not create dispatch agent: no project directory found')
        return null
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(cwd, { kind, providerRuntime, resumeSessionId: continuation?.resumeSessionId, builtInMcpOverrides: continuation?.builtInMcpOverrides })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create dispatch agent',
        )
        return null
      }

      let placed = false
      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === tab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === tab.id)
        if (!latestTab) return prev
        placed = true
        // Detached sessions are live workspace sessions with project affinity,
        // not children of Dispatch Mode. We deliberately do not insert this id
        // into latestTab.root, because the whole point is that creating ten
        // command-center agents must not explode the normal grid when Dispatch
        // Mode is turned off.
        return {
          ...prev,
          // Detached describes grid membership, not focus. UI creation has
          // always selected the captured lane; external operators can preserve
          // the entire current view, then explicitly assign the returned ID to
          // a chosen lane using a fresh layout revision.
          activeTabId: placement?.selectCreated === false ? prev.activeTabId : latestTab.id,
          detachedSessions: {
            ...prev.detachedSessions,
            [sessionId]: detachedDispatchRecord(sessionId, latestTab, projectTabIndex),
          },
          dispatchMode: placement?.selectCreated === false ? prev.dispatchMode : applyDispatchSpawnFocus(prev.dispatchMode, sessionId, target.laneIndex),
        }
      })
      // A caller needs the exact spawned ID; comparing a before/after census
      // could accidentally claim an agent created concurrently by the UI.
      // If the owning project disappeared during spawn, retire only this new
      // process instead of leaving an unowned live session behind.
      if (!placed) {
        await sessionActions.killSession(sessionId, { cwd, kind, providerRuntime })
        return null
      }
      if (placement?.selectCreated !== false) closeNewAgentPlacement()
      return sessionId
    },
    [closeNewAgentPlacement, refs.stateRef, sessionActions, setState, showToast],
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
      selection: SessionSpawnSelection & { kind: Exclude<SessionKind, 'terminal'> },
      parentId: SessionId,
    ) => {
      const { kind, providerRuntime } = selection
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[parentId]
      if (!parentMeta) {
        showToast('Could not create linked agent: parent agent is gone')
        return
      }
      // If the parent is ITSELF a linked agent, anchor the new agent
      // to the same top-level parent — linked agents never chain, so
      // the dispatch nesting stays exactly one level deep (see the
      // note on SessionMeta.linkedParentId).
      const rootParentId = parentMeta.linkedParentId ?? parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta
      const tiled = snapshot.dispatchMode?.tiled
      const focusedLane = tiled?.focusedLane ?? null
      const targetLaneIndex =
        focusedLane !== null &&
        tiled?.lanes[focusedLane]?.selectedSessionId === parentId
          ? focusedLane
          : null

      // Resolve the parent's tab: a detached parent carries its tab
      // id on the detachedSessions record; a grid parent is found by
      // the tab whose tile tree contains its leaf.
      const parentDetached = snapshot.detachedSessions[rootParentId]
      const parentTab = parentDetached
        ? snapshot.tabs.find(t => t.id === parentDetached.projectTabId)
        : snapshot.tabs.find(t => collectLeaves(t.root).includes(rootParentId))
      if (!parentTab) {
        showToast('Could not create linked agent: parent tab not found')
        return
      }

      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(rootParentMeta.cwd, { kind, providerRuntime })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create linked agent',
        )
        return
      }

      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === parentTab.id)
        if (!latestTab) return prev
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
            },
          },
          // A linked agent is a detached dispatch agent — same record
          // shape as createDetachedDispatchAgent, just anchored to the
          // parent's tab instead of the active one.
          detachedSessions: {
            ...prev.detachedSessions,
            [sessionId]: detachedDispatchRecord(sessionId, latestTab, projectTabIndex),
          },
          // Focus the new agent in dispatch — the user spawned it to
          // immediately hand it a prompt (typically a review prompt).
          //
          // WHY the lane index is captured before await:
          // spawn() crosses IPC and may take long enough for the user to move
          // focus. The command was initiated from a specific visual lane, so
          // that lane is the one that should flip to the child. Using the
          // latest focusedLane here would make an unrelated lane change race
          // with the child spawn and steal the next prompt target.
          dispatchMode: applyDispatchSpawnFocus(prev.dispatchMode, sessionId, targetLaneIndex),
        }
      })
    },
    [refs.stateRef, sessionActions, setState, showToast],
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
      if (!AGENT_PROVIDER_CHOICES.some(choice => choice.kind === params.kind && choice.providerRuntime === params.providerRuntime)) {
        throw new Error(`${params.kind} does not support the requested ${params.providerRuntime ?? 'structured'} runtime`)
      }
      const snapshot = refs.stateRef.current
      const parentMeta = snapshot.sessions[params.parentId]
      if (!parentMeta) {
        throw new Error('Could not create orchestration agent: parent agent is gone')
      }

      const rootParentId = parentMeta.orchestrationRootId ?? params.parentId
      const rootParentMeta = snapshot.sessions[rootParentId] ?? parentMeta
      const parentDetached = snapshot.detachedSessions[rootParentId]
      const parentTab = parentDetached
        ? snapshot.tabs.find(t => t.id === parentDetached.projectTabId)
        : snapshot.tabs.find(t => collectLeaves(t.root).includes(rootParentId))
      if (!parentTab) {
        throw new Error('Could not create orchestration agent: parent tab not found')
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
        ...(params.providerRuntime ? { providerRuntime: params.providerRuntime } : {}),
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

      setState(prev => {
        const latestTab = prev.tabs.find(t => t.id === parentTab.id)
        const projectTabIndex = prev.tabs.findIndex(t => t.id === parentTab.id)
        if (!latestTab) return prev
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
            },
          },
          detachedSessions: {
            ...prev.detachedSessions,
            [sessionId]: detachedDispatchRecord(sessionId, latestTab, projectTabIndex),
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

      return agent
    },
    [refs.stateRef, sessionActions, setState],
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
      await killSessionBackendIfOwned(refs, targetId)

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
        // have promoted a row or emptied the tab before it (finding 3).
        const placement = sessionPlacement(prev, targetId)
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        if (!placement) return prev.sessions[targetId] ? { ...prev, sessions } : prev
        if (placement.kind === 'detached') {
          committed.value = { kind: 'detached', record: placement.record }
          const detachedSessions = { ...prev.detachedSessions }
          delete detachedSessions[targetId]
          const next = { ...prev, sessions, detachedSessions }
          return { ...next, dispatchMode: dispatchModeAfterSessionRemoval(prev, next, targetId) }
        }
        const { tab, tabIndex } = placement
        const tabs = [...prev.tabs]
        const nextRoot = closeLeaf(tab.root, targetId)
        if (nextRoot) {
          const parentInfo = findParentSplitInfo(tab.root, targetId)
          if (parentInfo) committed.value = { kind: 'pane', tabId: tab.id, parentInfo }
          tabs[tabIndex] = {
            ...tab,
            root: nextRoot,
            focusedSessionId: findBestRemainingFocus(tab.root, nextRoot, targetId) ?? collectLeaves(nextRoot)[0],
          }
          const next = { ...prev, tabs, sessions }
          return { ...next, dispatchMode: dispatchModeAfterSessionRemoval(prev, next, targetId) }
        }
        // A nonempty project must keep its identity. Promote an existing
        // detached backend into the mandatory grid leaf; never spawn a shell or
        // restart a working agent just to satisfy the layout type.
        //
        // Prefer a row this operation is NOT about to close (finding 3: never
        // pick a session the operation will delete when a real survivor
        // exists). But fall back to a pending member before removing the tab:
        // that member's own verdict has not happened yet, and if it is then
        // kept — it changed, a sibling kept it, its kill threw — it must still
        // have a project to be filed under (#886 review round 2 N1). If it does
        // go on to close, it re-resolves itself as this grid leaf and promotes
        // the next row or removes the tab then.
        const survivor =
          detachedRootReplacement(prev, tab.id, new Set([targetId, ...operation.pending]))
          ?? detachedRootReplacement(prev, tab.id, new Set([targetId]))
        if (survivor) {
          committed.value = { kind: 'promoted', tab, tabIndex, survivor }
          tabs[tabIndex] = {
            ...tab,
            root: { type: 'leaf', sessionId: survivor.sessionId },
            focusedSessionId: survivor.sessionId,
          }
          const detachedSessions = { ...prev.detachedSessions }
          delete detachedSessions[survivor.sessionId]
          const next = { ...prev, tabs, sessions, detachedSessions }
          return { ...next, dispatchMode: dispatchModeAfterSessionRemoval(prev, next, targetId) }
        }
        committed.value = { kind: 'tab-removed', tab, tabIndex }
        return workspaceWithoutTab(prev, tab.id, [targetId])
      })

      operation.pending.delete(targetId)
      const outcome = committed.value
      operation.commits.push({ sessionId: targetId, meta: sessionMeta, outcome })
      if (outcome.kind === 'tab-removed') {
        clearRemovedTabTakeovers({ setTileTabs, setSpotlight, setReaderMode }, outcome.tab.id)
      }
      return { closed: true }
    },
    [refs, setReaderMode, setRuntimes, setSpotlight, setState, setTileTabs],
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

  // Promote a detached dispatch session into the grid at a chosen placement
  // target.
  //
  // WHY this wakes before the state move:
  // Detached sessions are "live" only inside a single app process. After a full
  // Agent Code restart, rehydrate intentionally keeps their SessionMeta but
  // does not respawn their provider PTY; otherwise a workspace with dozens of
  // parked agents would fork-bomb on launch. Attaching one back to the grid is
  // the explicit user action that makes it live again. We wake under the same
  // SessionId before inserting the leaf so every relationship pointer
  // (orchestrationParentId/rootId, linkedParentId, tiled lanes, pins) remains
  // intact and the pane never becomes visibly commandable while main would drop
  // writes for a missing session.
  //
  // The target tab need not equal the detached record's projectTabId.
  // projectTabId was always *affinity* (cwd defaults / dispatch
  // grouping / terminal selection), never *ownership*. Letting the
  // user pin a project-A detached agent into project-B's grid is the
  // whole point of having a placement step.
  const attachDetachedToGrid = useCallback(
    async (sessionId: SessionId, targetTabId: string, target: PlacementTarget) => {
      try {
        await sessionActions.ensureSessionLive(sessionId, 'pane.attach-detached')
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not wake detached session before attaching it.',
        )
        return
      }
      setState(prev => {
        const detached = prev.detachedSessions[sessionId]
        if (!detached) return prev
        const targetTab = prev.tabs.find(t => t.id === targetTabId)
        if (!targetTab) return prev
        // For a split-leaf target, the anchor must still exist in the
        // chosen tab's tree. The placement overlay computes targets from
        // a snapshot of the tree, so a stale target after a concurrent
        // tab close would silently no-op via insertBesideLeaf returning
        // the input. Bail with no state change so the user can re-open
        // the picker rather than getting a confusing "I clicked place
        // and nothing happened."
        if (target.kind === 'split-leaf') {
          const anchorStillThere = collectLeaves(targetTab.root).includes(target.targetSessionId)
          if (!anchorStillThere) return prev
        }
        const detachedSessions = { ...prev.detachedSessions }
        delete detachedSessions[sessionId]
        return {
          ...prev,
          // WHY activeTabId follows the explicit attach target:
          // attaching into a tab is a visible grid-focus change. Classic
          // Dispatch used to make this incidental because row focus synced
          // activeTabId before the overlay opened; Tiled Dispatch does not
          // touch activeTabId when a lane is selected. Capturing the tab in the
          // attach intent and committing it here keeps the grid focus context
          // aligned with the actual insertion tab instead of whatever tab was
          // active before the user entered global Tiled Dispatch.
          activeTabId: targetTabId,
          detachedSessions,
          tabs: prev.tabs.map(currentTab => {
            if (currentTab.id !== targetTabId) return currentTab
            return {
              ...currentTab,
              root:
                target.kind === 'wrap-root'
                  ? wrapRootWithLeaf(
                      currentTab.root,
                      target.direction,
                      target.side,
                      sessionId,
                    )
                  : insertBesideLeaf(
                      currentTab.root,
                      target.targetSessionId,
                      target.direction,
                      RATIO_DEFAULT,
                      target.side,
                      sessionId,
                    ),
              focusedSessionId: sessionId,
            }
          }),
          // Drop dispatch focus if it was pointing at this session —
          // the session now lives in the grid, and grid focus on the
          // active tab is what owns selection going forward. Leaving
          // the dispatch focus pointing at a now-grid-placed session
          // would make the dispatch list highlight a row that has
          // moved out of detachedSessions on the next render.
          dispatchMode:
            prev.dispatchMode?.focusedSessionId === sessionId
              ? { ...prev.dispatchMode, focusedSessionId: undefined }
              : prev.dispatchMode,
        }
      })
    },
    [sessionActions, setState, showToast],
  )

  const attachAllDetachedForTab = useCallback(
    async (tabId: string) => {
      let attachedCount = 0
      const snapshot = refs.stateRef.current
      const detachedIds = detachedDispatchSessionIdsForTab(snapshot, tabId)
      if (detachedIds.length === 0) return
      const liveIds: SessionId[] = []
      for (const sessionId of detachedIds) {
        try {
          await sessionActions.ensureSessionLive(sessionId, 'pane.attach-all-detached')
          liveIds.push(sessionId)
        } catch (err) {
          console.warn('[workspace] failed to wake detached session before bulk attach:', err)
        }
      }
      if (liveIds.length === 0) {
        showToast('Could not wake any detached sessions for this tab')
        return
      }
      setState(prev => {
        const tab = prev.tabs.find(t => t.id === tabId)
        if (!tab) return prev
        const attachableIds = liveIds.filter(sessionId => prev.detachedSessions[sessionId])
        if (attachableIds.length === 0) return prev
        attachedCount = attachableIds.length

        const detachedSessions = { ...prev.detachedSessions }
        for (const sessionId of attachableIds) {
          delete detachedSessions[sessionId]
        }

        // Bulk attach deliberately creates one new subtree for the
        // incoming Dispatch sessions and hard-normalizes ONLY that
        // subtree. The existing tab root is preserved byte-for-byte
        // below a single wrapper split; its internal ratios and pane
        // arrangement are not flattened. This gives users a predictable
        // "pin all background work beside my current grid" action
        // without punishing the layout they already curated.
        const attachedSubtree = normalizeTree(attachableIds)
        const nextRoot = wrapRootWithNode(
          tab.root,
          'vertical',
          'b',
          attachedSubtree,
        )
        const focusedSessionId = attachableIds[0]

        return {
          ...prev,
          activeTabId: tabId,
          detachedSessions,
          tabs: prev.tabs.map(currentTab =>
            currentTab.id === tabId
              ? {
                  ...currentTab,
                  root: nextRoot,
                  focusedSessionId,
                }
              : currentTab,
          ),
          // The attached sessions stop being detached records, but the first
          // one is still the user's target for the bulk attach action. Keep
          // Dispatch focus explicit so the highlighted row and command target
          // do not depend on selectVisibleDispatchRow's grid-focus fallback.
          dispatchMode: prev.dispatchMode
            ? { ...prev.dispatchMode, focusedSessionId }
            : prev.dispatchMode,
        }
      })
      if (attachedCount > 0) {
        showToast(
          `Attached ${attachedCount} Dispatch ${attachedCount === 1 ? 'session' : 'sessions'} to grid`,
        )
      }
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  // The reverse direction: take the focused grid pane out of the tile
  // tree without killing its session, and add it to the dispatch
  // detached bucket.
  //
  // Refuses in two cases, each surfaced as a toast so the user
  // understands why nothing happened:
  //   1. No focused session — nothing to detach.
  //   2. The focused pane is the only leaf in its tab — closeLeaf would
  //      return null and the tab.root type cannot represent an empty
  //      tree. We don't want to silently close the tab either, so we
  //      refuse and ask the user to add another pane first.
  const detachSessionToDispatch = useCallback((sessionId: SessionId) => {
    const snapshot = refs.stateRef.current
    const meta = snapshot.sessions[sessionId]
    if (!meta) return
    const tab = snapshot.tabs.find(t => collectLeaves(t.root).includes(sessionId))
    if (!tab) {
      // WHY detached rows no-op here instead of re-detaching:
      // This action means "move the grid pane out to Dispatch." A detached
      // session is already there; treating it as success would hide a stale
      // command-target bug, while trying to mutate it would duplicate the
      // ownership record. The attach command owns the reverse direction.
      showToast('Session is already detached to Dispatch')
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length <= 1) {
      showToast('Cannot detach the last pane in a tab — add another pane first')
      return
    }
    const tabIndex = snapshot.tabs.findIndex(t => t.id === tab.id)

    setState(prev => {
      const latestTab = prev.tabs.find(t => t.id === tab.id)
      if (!latestTab) return prev
      const nextRoot = closeLeaf(latestTab.root, sessionId)
      // Defensive guard: closeLeaf returning null here would mean a
      // race against a concurrent close emptied the tab between the
      // snapshot read and the setState. The leaves.length check above
      // already filtered the common case; this is for race-window
      // safety so the type stays sound.
      if (!nextRoot) return prev
      const nextLeafIds = collectLeaves(nextRoot)
      const nextFocus =
        latestTab.focusedSessionId === sessionId
          ? nextLeafIds[0] ?? ''
          : latestTab.focusedSessionId

      return {
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === tab.id
            ? { ...t, root: nextRoot, focusedSessionId: nextFocus }
            : t,
        ),
        detachedSessions: {
          ...prev.detachedSessions,
          [sessionId]: detachedDispatchRecord(sessionId, latestTab, tabIndex),
        },
        // If Dispatch is currently active, focus the freshly detached
        // session so the user sees the result of their action. If
        // Dispatch is not active, leave dispatchMode alone — toggling
        // into Dispatch later will pick this up via the existing
        // first-row fallback in selectActiveRow.
        dispatchMode: prev.dispatchMode
          ? { ...prev.dispatchMode, focusedSessionId: sessionId }
          : prev.dispatchMode,
      }
    })
    const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? 'session'
    showToast(`Detached "${cwdBase}" to Dispatch`)
  }, [refs.stateRef, setState, showToast])


  const detachFocusedToDispatch = useCallback(() => {
    const id = commandTargetSessionIdForState(refs.stateRef.current)
    if (id) detachSessionToDispatch(id)
    else showToast('No focused session to detach')
  }, [refs.stateRef, detachSessionToDispatch, showToast])

  const commitNewAgentPlacement = useCallback(
    async (selection: SessionSpawnSelection, target: PlacementTarget) => {
      const { kind, providerRuntime } = selection
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const anchorSessionId = tab.focusedSessionId
      const cwd = state.sessions[anchorSessionId]?.cwd
      if (!cwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await sessionActions.spawn(cwd, { kind, providerRuntime })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create pane',
        )
        return
      }
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(currentTab => {
          if (currentTab.id !== prev.activeTabId) return currentTab
          return {
            ...currentTab,
            root:
              target.kind === 'wrap-root'
                ? wrapRootWithLeaf(
                    currentTab.root,
                    target.direction,
                    target.side,
                    newSessionId,
                  )
                : insertBesideLeaf(
                    currentTab.root,
                    target.targetSessionId,
                    target.direction,
                    RATIO_DEFAULT,
                    target.side,
                    newSessionId,
                  ),
            focusedSessionId: newSessionId,
          }
        }),
      }))
      closeNewAgentPlacement()
    },
    [
      closeNewAgentPlacement,
      sessionActions,
      setState,
      showToast,
      state.activeTabId,
      state.sessions,
      state.tabs,
    ],
  )

  // One close implementation owns both row buttons and the keyboard command.
  // The former focused-grid copy silently made the sole leaf a tab close;
  // delegating by stable ID ensures every human entry sees the scope choice.
  // A missing Dispatch target closes NOTHING — see resolveFocusedCloseTarget.
  const closeFocused = useCallback(async () => {
    const targetId = resolveFocusedCloseTarget(refs.stateRef.current)
    if (targetId) await closeSessionRef.current?.(targetId)
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
      let scope: 'session' | 'tab' = 'session'
      let approved: readonly CloseTargetSnapshot[] | null = null
      const rootTab = initial.tabs.find(tab => tab.root.type === 'leaf' && tab.root.sessionId === targetId)
      if (rootTab && detachedTabChildren(initial, rootTab.id).ids.length > 0 &&
          !options?.preConfirmed && !options?.silentIfSoleTarget && !options?.requireConfirmation) {
        const agentTargets = paneCloseTargets(initial, refs.latestRuntimesRef.current, targetId)
        const tabTargets = paneCloseTargets(initial, refs.latestRuntimesRef.current, targetId, 'tab')
        // WHY the three-way choice is skipped when both scopes name the same
        // sessions (#886 review n4): a root whose only Dispatch rows are its own
        // linked children ends the identical set either way, and two buttons
        // that close the same sessions are noise. The ordinary gate below lists
        // them once. Undo is not worse for it: those children were the
        // project's last rows, so the session-scoped operation removes the tab
        // and folds them into one tab entry (recordOperationUndo).
        if (!sameTargetIds(agentTargets, tabTargets)) {
          const choice = await requestRootCloseConfirmation({
            required: true, reason: 'multi', targets: tabTargets,
            summary: `“${rootTab.title}” contains ${tabTargets.length} sessions.`,
            agentOnly: {
              title: agentTargets[0]?.title ?? targetId,
              targets: agentTargets,
              noun: closeNoun(initial.sessions[targetId]),
            },
          })
          if (!choice) return false
          scope = choice === 'tab' ? 'tab' : 'session'
          const shown = choice === 'tab' ? tabTargets : agentTargets
          const current = refs.stateRef.current
          // A changed root role/tab invalidates even an unchanged list of IDs.
          // Never let the scope choice transfer to another project under a dialog.
          if (!current.tabs.some(tab => tab.id === rootTab.id && tab.root.type === 'leaf' && tab.root.sessionId === targetId) ||
              !grantStillMatches(shown, paneCloseTargets(current, refs.latestRuntimesRef.current, targetId, scope))) {
            return refuse('changed')
          }
          approved = shown
        }
      }
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
            paneCloseTargets(refs.stateRef.current, refs.latestRuntimesRef.current, targetId, scope),
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
      const operation = beginCloseOperation(refs.stateRef.current, targetId, approved, options?.onlyIf)
      if (scope === 'tab') {
        // Close Tab executes the SAME plan the dialog listed (#886 review
        // finding 5). The dialog expands every linked descendant transitively,
        // including a child attached into ANOTHER project's grid; the first
        // version of this branch killed only the root and this tab's Dispatch
        // rows, so that child was listed as ending and survived with a dead
        // parent. Members close deepest-first through the same executor, each
        // revalidated at its own kill boundary, and the root comes last: if
        // every member closed, its close removes the emptied tab; if one
        // changed or failed, the root promotes that survivor instead of
        // deleting a nonempty project.
        const approvalState = refs.stateRef.current
        await closeOperationMembers(operation, [...operation.approved.keys()]
          .filter(id => id !== targetId)
          .sort((a, b) => linkedDepth(approvalState, b) - linkedDepth(approvalState, a)))
      }

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
  // end every session the project owns — its grid leaves, its Dispatch rows, and
  // every linked descendant of either, wherever that descendant is attached.
  //
  // WHY it lives here and runs the same operation as the root dialog's Close Tab
  // (#886 review round 2, Codex majors 1 and 2, Claude N2): the command's own
  // copy in tab.ts listed that expanded set in its dialog but killed only the
  // tab's leaves and rows, pushed its undo entry and "Closed" toast BEFORE
  // killing, and killed with Promise.all. So a cross-project linked child was
  // promised dead and survived with a dead parent, and one rejected kill left a
  // tab whose tree named a deleted session plus an undo entry for a tab that
  // was never removed. Here the approved list IS the kill list; members close
  // deepest-first with the tab's grid leaves last, each re-judged at its own
  // kill boundary; undo and the toast describe only what committed; and a
  // partial close leaves the tab rooted and focused on a survivor.
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
            ? expandTabCloseTargets(
                state,
                refs.latestRuntimesRef.current,
                collectLeaves(tab.root),
                detachedTabChildren(state, tabId).ids,
              )
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
      const operation = beginCloseOperation(approvalState, null, withShownLiveness(gate.targets, shown), undefined)
      // Grid leaves last. While another leaf remains, closing one is a plain
      // split collapse; the final leaf's commit removes the tab only when no
      // Dispatch row is left under it, and otherwise promotes that survivor.
      const gridLeaves = collectLeaves(tab.root).filter(id => operation.approved.has(id))
      const members = [...operation.approved.keys()]
        .filter(id => !gridLeaves.includes(id))
        .sort((a, b) => linkedDepth(approvalState, b) - linkedDepth(approvalState, a))
      await closeOperationMembers(operation, [...members, ...gridLeaves])
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

  // Bury: remove the focused pane from the visible layout without
  // killing the underlying session. The session keeps running in
  // the background and remains eligible for revive.
  //
  // WHY commandTargetSessionIdForState instead of tab.focusedSessionId:
  // tab.focusedSessionId has a "must be a leaf in tab.root" invariant —
  // it's grid-only. In Dispatch Mode the user has a row selected, not
  // a grid focus, and reading tab.focusedSessionId silently opens the
  // bury prompt on whatever grid pane is focused underneath the
  // visible dispatch row — exactly the bug class issue #94 tracks.
  // Routing through commandTargetSessionIdForState makes Bury agree
  // with every other "act on the visible thing" command (close,
  // copy-assistant, scroll-to-latest, switch-provider, reload, rewind,
  // soft-reload-view — all already use this resolver).
  const requestBuryFocused = useCallback(() => {
    const snapshot = refs.stateRef.current
    const sessionId = commandTargetSessionIdForState(snapshot)
    if (!sessionId) return
    // Bury moves a GRID PANE out of the layout: `buryFocused` resolves the
    // owning tab, records the split position needed to revive it, and bails
    // when the target has no tab. A detached Dispatch row has none, so the
    // prompt would open, accept a note, and then silently do nothing.
    //
    // WHY the check is here rather than in `buryFocused`: failing at confirm
    // time means the user has already typed the note. Refusing before the
    // modal opens is the same judgement, made where it still costs nothing.
    //
    // WHY a toast rather than hiding the command: bury is a reasonable thing
    // to WANT for a Dispatch row, and detached sessions are already parked
    // out of the layout, so the honest answer is "this does not apply here" —
    // not a command that vanishes with no explanation. This became reachable
    // for terminals when Dispatch terminals stopped being grid leaves (#671);
    // detached agents always had it.
    if (!snapshot.tabs.some(tab => collectLeaves(tab.root).includes(sessionId))) {
      showToast('Bury applies to grid panes — this session is already parked in Dispatch')
      return
    }
    openBuryPrompt(sessionId)
  }, [openBuryPrompt, refs.stateRef, showToast])

  const buryFocused = useCallback(
    (note?: string, targetSessionId?: SessionId) => {
      // The bury prompt is modal on a specific session, not a
      // specific tab. It can outlive a tab switch: user opens the
      // prompt on pane X in tab A, switches to tab B, then hits
      // Enter. Earlier we resolved `tab` via `state.activeTabId`,
      // which meant that confirm-after-switch mutated tab B's tree
      // even though targetId still pointed at pane X in tab A.
      // Resolve the owning tab from the target session instead.
      const snapshot = refs.stateRef.current
      const activeTab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
      // The `?? activeTab?.focusedSessionId` fallback is intentionally
      // defensive belt-and-suspenders: every current caller passes an
      // explicit `targetSessionId` (the bury-prompt modal in App.tsx
      // owns the resolved id at confirm time; requestBuryFocused
      // resolves it via commandTargetSessionIdForState before opening
      // the prompt). The fallback exists so a future caller that
      // forgets to pass an id doesn't no-op silently — but it MUST
      // NOT become the primary path, because activeTab.focusedSessionId
      // is grid-only and would re-introduce the Dispatch-misses-target
      // bug from #94.
      const targetId = targetSessionId ?? activeTab?.focusedSessionId
      if (!targetId) return

      const owningTab = snapshot.tabs.find(t => collectLeaves(t.root).includes(targetId))
      if (!owningTab) return

      const sessionMeta = snapshot.sessions[targetId]
      if (!sessionMeta) return

      const parentInfo = findParentSplitInfo(owningTab.root, targetId)
      const tabIndex = snapshot.tabs.findIndex(t => t.id === owningTab.id)
      const buriedAt = Date.now()
      const buriedRecord: BuriedPaneRecord = {
        id: targetId,
        sessionId: targetId,
        sessionMeta,
        buriedAt,
        sourceTabId: owningTab.id,
        sourceTabTitle: owningTab.title,
        sourceTabIndex: tabIndex,
        direction: parentInfo?.direction,
        ratio: parentInfo?.ratio,
        side: parentInfo?.side,
        siblingLeafId: parentInfo?.siblingLeafId,
        note: note?.trim() ? note.trim() : undefined,
      }
      const detachedChildren = parentInfo
        ? { records: [], ids: [] }
        : detachedTabChildren(snapshot, owningTab.id)
      // WHY last-pane bury transfers detached children into the buried archive
      // instead of killing them: Bury is explicitly the non-destructive close.
      // Once the source tab disappears, leaving its dispatch children detached
      // would make them ownerless and the persistence sanitizer would discard
      // them on the next save. Giving every live child an archive record keeps
      // it discoverable and revivable while preserving its running backend.
      const detachedBuriedRecords: BuriedPaneRecord[] = detachedChildren.records
        .flatMap(entry => {
          const meta = snapshot.sessions[entry.sessionId]
          if (!meta) return []
          return [{
            id: entry.sessionId,
            sessionId: entry.sessionId,
            sessionMeta: meta,
            buriedAt,
            sourceTabId: owningTab.id,
            sourceTabTitle: owningTab.title,
            sourceTabIndex: tabIndex,
          }]
        })

      const kindLabel = sessionMeta.kind ?? DEFAULT_PROVIDER
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Buried ${kindLabel} pane (${cwdBase})`)

      setState(prev => {
        const tabs = [...prev.tabs]
        const tabIdx = tabs.findIndex(t => t.id === owningTab.id)
        // Tab may have been closed between prompt-open and confirm.
        // Treat that as a no-op rather than mutating an unrelated tab.
        if (tabIdx === -1) return prev

        const currentTab = tabs[tabIdx]
        const nextRoot = closeLeaf(currentTab.root, targetId)
        if (nextRoot === null) {
          const remaining = tabs.filter((_, i) => i !== tabIdx)
          const detachedSessions = { ...prev.detachedSessions }
          for (const id of detachedChildren.ids) delete detachedSessions[id]
          const buriedSessionIds = new Set([
            targetId,
            ...detachedBuriedRecords.map(entry => entry.sessionId),
          ])
          const hiddenSessionIds = new Set([targetId, ...detachedChildren.ids])
          // Only retarget activeTabId if we just removed the active
          // tab. Burying a pane in a background tab must not yank
          // the user out of the tab they're currently looking at.
          const nextActiveTabId = prev.activeTabId === owningTab.id
            ? (remaining[Math.max(0, tabIdx - 1)]?.id ?? '')
            : prev.activeTabId
          return {
            ...prev,
            tabs: remaining,
            activeTabId: nextActiveTabId,
            detachedSessions,
            buried: [
              ...prev.buried.filter(entry => !buriedSessionIds.has(entry.sessionId)),
              buriedRecord,
              ...detachedBuriedRecords,
            ],
            // A buried session is hidden from the dispatch rows, so a tiled
            // lane still pointing at it would dangle; clear it so the lane
            // re-homes cleanly instead of bouncing to tile 0.
            dispatchMode: dispatchModeAfterSessionRemovals(
              prev.dispatchMode,
              hiddenSessionIds,
            ),
          }
        }

        const nextFocused =
          findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
          collectLeaves(nextRoot)[0]
        tabs[tabIdx] = {
          ...currentTab,
          root: nextRoot,
          focusedSessionId: nextFocused,
        }
        return {
          ...prev,
          tabs,
          buried: [
            ...prev.buried.filter(entry => entry.sessionId !== targetId),
            buriedRecord,
          ],
          // See above: clear any tiled lane pointing at the buried session.
          dispatchMode: clearTiledLaneSessions(prev.dispatchMode, targetId),
        }
      })
      setSpotlight(prev => (prev?.tabId === owningTab.id ? null : prev))
      closeBuryPrompt()
    },
    [closeBuryPrompt, refs.stateRef, setSpotlight, setState, showToast],
  )

  // Restores a buried session into the most plausible visible
  // location. First choice is the original sibling anchor, then the
  // original tab, then the best current tab by cwd/kind/title
  // affinity, and finally a fresh single-pane tab if no good target
  // exists.
  const reviveBuried = useCallback(
    async (buriedId: string) => {
      const initialEntry = refs.stateRef.current.buried.find(item => item.id === buriedId)
      if (!initialEntry) return
      try {
        await sessionActions.ensureSessionLive(initialEntry.sessionId, 'pane.revive-buried')
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not wake buried session before reviving it.',
        )
        return
      }

      // WHY re-read after wake: ensureSessionLive can update runtime metadata,
      // clear stale backend errors, or lose a race to another revive/kill action.
      // Placement should be based on the workspace that actually exists after
      // the backend is live, not the pre-wake snapshot we used only to discover
      // which session needed waking.
      const current = refs.stateRef.current
      const entry = current.buried.find(item => item.id === buriedId)
      if (!entry) return

      const chooseFallbackTab = (): Tab | null => {
        const scored = current.tabs
          .map(tab => {
            let score = 0
            if (tab.id === entry.sourceTabId) score += 100
            if (tab.title === entry.sourceTabTitle) score += 20
            const leafIds = collectLeaves(tab.root)
            for (const leafId of leafIds) {
              const meta = current.sessions[leafId]
              if (!meta) continue
              if (meta.cwd === entry.sessionMeta.cwd) score += 15
              if ((meta.kind ?? DEFAULT_PROVIDER) === (entry.sessionMeta.kind ?? DEFAULT_PROVIDER)) score += 5
            }
            return { tab, score }
          })
          .filter(candidate => candidate.score > 0)
          .sort((a, b) => b.score - a.score)
        return scored[0]?.tab ?? current.tabs[0] ?? null
      }

      const anchorTab = entry.siblingLeafId
        ? current.tabs.find(tab => collectLeaves(tab.root).includes(entry.siblingLeafId!))
        : null
      const targetTab = anchorTab ?? chooseFallbackTab()

      setState(prev => {
        const nextBuried = prev.buried.filter(item => item.id !== buriedId)

        if (!targetTab) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const target = prev.tabs.find(tab => tab.id === targetTab.id)
        if (!target) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const leafIds = collectLeaves(target.root)
        const cwdLeaf =
          leafIds.find(leafId => prev.sessions[leafId]?.cwd === entry.sessionMeta.cwd) ?? null
        const anchorLeafId =
          (entry.siblingLeafId && leafIds.includes(entry.siblingLeafId))
            ? entry.siblingLeafId
            : (cwdLeaf ?? target.focusedSessionId ?? leafIds[0] ?? null)

        if (!anchorLeafId) {
          const tabId = crypto.randomUUID()
          const title = titleFromCwd(entry.sessionMeta.cwd)
          const revivedTab: Tab = {
            id: tabId,
            title,
            root: { type: 'leaf', sessionId: entry.sessionId },
            focusedSessionId: entry.sessionId,
          }
          return {
            ...prev,
            tabs: [...prev.tabs, revivedTab],
            activeTabId: tabId,
            buried: nextBuried,
          }
        }

        const revivedRoot = insertBesideLeaf(
          target.root,
          anchorLeafId,
          entry.direction ?? 'vertical',
          entry.ratio ?? RATIO_DEFAULT,
          entry.side ?? 'b',
          entry.sessionId,
        )

        return {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === target.id
              ? {
                  ...tab,
                  root: revivedRoot,
                  focusedSessionId: entry.sessionId,
                }
              : tab,
          ),
          activeTabId: target.id,
          buried: nextBuried,
        }
      })
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  const killBuried = useCallback(
    async (buriedId: string) => {
      const snapshot = refs.stateRef.current
      const entry = snapshot.buried.find(item => item.id === buriedId)
      if (!entry) return

      // SECOND CONFIRMATION. The buried picker is already an explicit,
      // deliberate selection — but this is the one close in the app with NO
      // undo at all: a buried session is not on the undo-close stack, so the
      // kill is final. The picker's own selection is not consent to that.
      //
      // Confirmation is unconditional, unlike the ordinary close paths. There
      // is no cheap idle case to protect here, because there is no recovery
      // even when the session is idle.
      const buriedConfirmed = await requestCloseConfirmation({
        required: true,
        // Its OWN reason. Borrowing 'running' made the dialog title an idle
        // buried session "Close a working session?", contradicting both its
        // body and the actual state — on the one close with no undo, where the
        // dialog's credibility is the entire mechanism.
        reason: 'irreversible',
        targets: [{
          sessionId: entry.sessionId,
          // A buried entry always carries its own sessionMeta, even after the
          // session has left `sessions` entirely — so read from there rather
          // than the (possibly absent) live sessions record (#865).
          title: sessionDisplayTitle(entry.sessionMeta),
          live: isSessionLiveForClose(refs.latestRuntimesRef.current, entry.sessionId),
        }],
        summary: 'Killing a buried session is permanent — Undo Close cannot restore it.',
      })
      if (!buriedConfirmed) return

      // Buried panes are live sessions removed from every visible tab
      // tree. `closeSession` intentionally only handles visible panes
      // because it needs tree geometry and undo-close placement data;
      // using it here would no-op. Killing a buried pane is a different
      // operation: terminate the hidden backend and delete the buried
      // record directly, without briefly reviving or mutating layout.
      await killSessionBackendIfOwned(refs, entry.sessionId)

      setRuntimes(prev => {
        const next = { ...prev }
        delete next[entry.sessionId]
        return next
      })
      forgetClosedSessionDebugState(refs, entry.sessionId)
      const bootstrapTimer = refs.bootstrapTimersRef.current.get(entry.sessionId)
      if (bootstrapTimer) {
        clearTimeout(bootstrapTimer)
        refs.bootstrapTimersRef.current.delete(entry.sessionId)
      }
      const paneToastTimer = refs.paneToastTimers.current[entry.sessionId]
      if (paneToastTimer) {
        clearTimeout(paneToastTimer)
        delete refs.paneToastTimers.current[entry.sessionId]
      }

      setState(prev => {
        const sessions = { ...prev.sessions }
        delete sessions[entry.sessionId]
        return {
          ...prev,
          sessions,
          buried: prev.buried.filter(item => item.id !== buriedId),
        }
      })

      const kindLabel = entry.sessionMeta.kind ?? DEFAULT_PROVIDER
      const cwdBase = entry.sessionMeta.cwd.split('/').filter(Boolean).pop() ?? entry.sessionMeta.cwd
      showToast(`Killed buried ${kindLabel} pane (${cwdBase})`)
    },
    [
      refs.bootstrapTimersRef,
      refs.latestScreenRef,
      refs.paneToastTimers,
      refs.seenUuidsRef,
      refs.stateRef,
      setRuntimes,
      setState,
      showToast,
    ],
  )

  const focusSession = useCallback(
    (sessionId: SessionId) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
      setSpotlight(prev => (
        prev && prev.tabId === refs.stateRef.current.activeTabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
    },
    [refs.stateRef, setSpotlight, setState],
  )

  const focusSessionInTab = useCallback(
    (tabId: string, sessionId: SessionId) => {
      setState(prev => ({
        ...prev,
        activeTabId: tabId,
        tabs: prev.tabs.map(t =>
          t.id === tabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
      setSpotlight(prev => (
        prev && prev.tabId === tabId
          ? { ...prev, focusedSessionId: sessionId }
          : prev
      ))
      setTileTabs(prev => (
        prev && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
    },
    [setSpotlight, setState, setTileTabs],
  )

  const navigate = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const next = findDirectionalNeighbor(tab.root, tab.focusedSessionId, direction)
      if (next) focusSession(next)
    },
    [focusSession, state.activeTabId, state.tabs],
  )

  return {
    splitFocused,
    startNewAgentPlacement,
    commitNewAgentPlacement,
    // Shells and agents share detached placement and post-spawn ownership
    // checks. Preserve the narrower agent entry point for existing pickers.
    createDetachedSession: createDetachedDispatchAgent,
    createDetachedDispatchAgent,
    createLinkedAgent,
    createOrchestrationAgent,
    attachDetachedToGrid,
    attachAllDetachedForTab,
    detachSessionToDispatch,
    detachFocusedToDispatch,
    closeFocused,
    closeSession,
    closeTab,
    requestBuryFocused,
    buryFocused,
    reviveBuried,
    killBuried,
    focusSession,
    focusSessionInTab,
    navigate,
  }
}

function dispatchModeAfterSessionRemoval(
  before: WorkspaceState,
  after: WorkspaceState,
  removedSessionId: SessionId,
): DispatchModeState | null {
  // Always clear the removed session out of any TILED LANE first. A lane can
  // hold a session that is NOT the classic dispatch focus, so the
  // focusedSessionId short-circuit below must not skip lane cleanup — otherwise
  // the lane dangles at a dead id and the layout's auto-fill effect bounces it
  // to the first agent. clearTiledLaneSessions is a no-op (same ref) when there
  // is no tiled layout or no lane held the removed session.
  const cleared = clearTiledLaneSessions(after.dispatchMode, removedSessionId)
  if (!cleared || cleared.focusedSessionId !== removedSessionId) {
    // The user wasn't visibly commanding this row — leave Dispatch focus alone.
    //
    // This short-circuit matters because closeSession is also reached from
    // the Agent Activity modal, which kills *background* panes by id. Without
    // this branch, killing a stranger row would shuffle the user's visible
    // Dispatch selection on every removal.
    return cleared
  }

  // Row-by-index successor selection.
  //
  // The previous version of this helper picked "first row in the same project
  // tab, else first row globally," which made closing row 6 of a project jump
  // visibly to row 1 — there is no list-UI convention where a delete moves
  // the cursor to the start of the list. Native list pickers (Finder, mail
  // clients, IDE file lists) all keep the cursor at the same visual position
  // after delete, falling back to the previous row when the deleted row was
  // last. We mirror that here so close-and-keep-going feels predictable.
  //
  // Why diff against `before` instead of just picking afterRows[0]:
  //   - The "same visual position" is only meaningful relative to where the
  //     removed row USED to be. We need the index from the pre-removal list
  //     to project it back into the post-removal list.
  //   - When removedIndex is past the end of afterRows (closed the last
  //     row), we fall back to afterRows[removedIndex - 1] so the cursor
  //     trails behind the deletion instead of leaping to the top.
  //
  // When removedIndex is -1 (the closed session wasn't in the visible scope
  // — e.g. project-scope close that collapsed the active tab and switched
  // activeTabId to a different project) we deliberately clear focus instead
  // of inventing a row. The DispatchLayout fallback effect will pick a sane
  // first-row default on the next render in the new scope.
  const beforeRows = buildVisibleDispatchRows(before)
  const afterRows = buildVisibleDispatchRows(after)
  const removedIndex = beforeRows.findIndex(row => row.sessionId === removedSessionId)

  // Project-first successor selection (issue #261).
  //
  // In this codebase a "project" IS a tab — every Dispatch row carries a
  // `tabId`, and that is the ONLY reliable project key (cwd is not: two tabs
  // can share a directory, and a tab's cwd can change). The old logic picked
  // the successor purely by flat-list position
  // (`afterRows[removedIndex] ?? afterRows[removedIndex - 1]`). That is fine
  // mid-project, but when the closed row was its project's LAST row,
  // `afterRows[removedIndex]` is the FIRST row of the *next* project, so focus
  // silently jumped across the project boundary and the user lost the context
  // they were working in. We never want a single close to evict you from your
  // project unless the project itself is now gone.
  //
  // So: as long as the closed row's project still has any rows, keep the
  // cursor INSIDE that project — prefer the next pane down (first surviving
  // same-project row at or after the removed index, preserving the "cursor
  // trails the deletion" feel), and only when nothing survives below do we
  // fall back to the last same-project pane above (the bottom-of-project
  // close — the actual bug being fixed here).
  //
  // Only when the project is fully emptied (e.g. closing a single-pane
  // project) do we defer to the legacy GLOBAL fallback and let focus leave the
  // project — there is no in-project row left to land on, so the flat-list
  // neighbour is the sane "same visual position" choice.
  //
  // removedIndex < 0 stays unchanged: the closed session wasn't in the visible
  // scope, so we clear focus (undefined successor) and let DispatchLayout's
  // fallback effect pick a first-row default in the new scope.
  let successor: DispatchAgentRow | undefined
  if (removedIndex >= 0) {
    const removedTabId = beforeRows[removedIndex].tabId
    const sameProjectAfter = afterRows.filter(row => row.tabId === removedTabId)
    if (sameProjectAfter.length > 0) {
      // Project survives: never cross the boundary. Next pane down in-project,
      // else nearest pane up in-project.
      successor =
        sameProjectAfter.find(row => afterRows.indexOf(row) >= removedIndex) ??
        sameProjectAfter[sameProjectAfter.length - 1]
    } else {
      // Project is now empty: only NOW may focus leave the project. Legacy
      // global "same visual position, trailing on last-row close" rule.
      successor = afterRows[removedIndex] ?? afterRows[removedIndex - 1]
    }
  }

  return {
    ...cleared,
    focusedSessionId: successor?.sessionId,
  }
}
