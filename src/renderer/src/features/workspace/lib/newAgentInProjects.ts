import {
  focusedLaneBoundProjectTabIds,
  resolveDispatchSpawnTarget,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId, TabId, WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// Project list for New Agent In… (#852).
//
// The command exists because filling an empty Grid Dispatch lane used to need
// a navigational detour: plain New Agent… files the agent under whatever
// project the spawn resolver derives from focus, so the only way to aim it at
// project C was to go select some unrelated agent in C first. This module
// answers "which projects can the picker offer, and how would each one be
// spawned into?" as a pure function of workspace state, so the dialog stays a
// dumb list and the rules below are testable without React.
// ---------------------------------------------------------------------------

export type NewAgentInProject = {
  tabId: TabId
  /**
   * A/B/C — the tab's position in the FULL tab list, never re-lettered after
   * row-binding filtering. The Dispatch index, pane labels and the row-project
   * picker all name projects this way; a picker that called project C "B"
   * because B was filtered out would contradict every other surface.
   */
  label: string
  title: string
  /**
   * The existing session whose cwd the new agent borrows, or null when the
   * project has none.
   *
   * WHY an anchor session at all: a Tab has no directory of its own — cwd lives
   * on sessions — and `createDetachedDispatchAgent` deliberately takes the
   * override as `{ tabId, anchorSessionId }` for exactly this reason (see the
   * WHY on `newAgentProjectIntent` in uiShell/types.ts).
   */
  anchorSessionId: SessionId | null
  /** Set exactly when `anchorSessionId` is null; shown on the disabled row. */
  disabledReason: string | null
}

export type NewAgentInModel = {
  projects: NewAgentInProject[]
  /** Row to highlight when the project step opens; null when none is enabled. */
  initialTabId: TabId | null
}

const NO_ANCHOR_REASON = 'No agent in this project to take a working directory from'

/**
 * First session of the project that has a directory to borrow.
 *
 * Order comes from `resolveTabSessions`: grid leaves first, then detached rows
 * by `detachedAt`. That is the same order the Dispatch project header's "+"
 * reaches for (it passes the group's first row), so the two entry points spawn
 * a given project into the same directory. Grid leaves first also matters on
 * its own: they are usually the project's root checkout, while detached rows
 * are where worktree agents live — borrowing a worktree path would start the
 * new agent inside someone else's task branch.
 *
 * A grid leaf can outlive its SessionMeta (resolveTabSessions does not filter
 * grid ids by existence), and a meta can carry an empty cwd; both are skipped
 * rather than trusted, because `createDetachedDispatchAgent` would otherwise
 * fail late with a toast instead of the picker saying so up front.
 */
function anchorFor(state: WorkspaceState, tabId: TabId): SessionId | null {
  for (const sessionId of resolveTabSessions(state, tabId)) {
    if (state.sessions[sessionId]?.cwd) return sessionId
  }
  return null
}

export function buildNewAgentInModel(state: WorkspaceState): NewAgentInModel {
  // Row bindings restrict the offer. A binding says "this row holds these
  // projects" and the row's own index only lists them; spawning another
  // project's agent into one of its lanes would put an agent where its own
  // index cannot show it. The spawn resolver honours the same selector.
  const bound = new Set(focusedLaneBoundProjectTabIds(state))

  const projects: NewAgentInProject[] = []
  state.tabs.forEach((tab, tabIndex) => {
    // Iterate TABS (not the binding) so the list keeps tab order: the binding
    // is a set the user built by clicking, and its insertion order means
    // nothing to someone scanning A, B, C.
    if (bound.size > 0 && !bound.has(tab.id)) return
    const anchorSessionId = anchorFor(state, tab.id)
    projects.push({
      tabId: tab.id,
      label: tabIndexLabel(tabIndex),
      title: tab.title,
      anchorSessionId,
      disabledReason: anchorSessionId ? null : NO_ANCHOR_REASON,
    })
  })

  // Start on the project plain New Agent… would have used, so Enter, Enter is
  // never worse than the command it sits beside — the new command only adds
  // the ability to point somewhere else. When that project is not on offer (a
  // bound row whose lane still shows another project's agent) or cannot be
  // anchored, fall back to the first project that can actually take an agent.
  const spawnTabId = resolveDispatchSpawnTarget(state).tabId
  const enabled = projects.filter(project => project.anchorSessionId !== null)
  const initialTabId =
    enabled.find(project => project.tabId === spawnTabId)?.tabId ??
    enabled[0]?.tabId ??
    null

  return { projects, initialTabId }
}
