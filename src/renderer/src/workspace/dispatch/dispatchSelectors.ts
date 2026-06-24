import type { SessionId, SessionKind, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { resolveTabSessions } from '@renderer/workspace/queries'

export type DispatchAgentRow = {
  key: string
  label: string
  globalIndex: number
  tabId: TabId
  tabTitle: string
  tabIndex: number
  sessionId: SessionId
  kind: SessionKind | undefined
  title: string
  placement: 'grid' | 'detached'
  /** Nesting depth in the dispatch list. 0 = ordinary row; 1 = a
   *  linked agent rendered indented directly under its parent row.
   *  Linked agents never chain, so this is only ever 0 or 1. */
  depth: number
}

export type DispatchTabGroup = {
  tab: Tab
  tabIndex: number
  rows: DispatchAgentRow[]
}

export function buildDispatchGroups(
  state: WorkspaceState,
): DispatchTabGroup[] {
  const activeOnly = state.dispatchMode?.scope !== 'global'
  const sourceTabs = activeOnly
    ? state.tabs.filter(tab => tab.id === state.activeTabId)
    : state.tabs

  // Pins live in their own section at the top of the list. A pinned
  // session is intentionally NOT also rendered in its project group —
  // duplicating the row would make cmd+N ambiguous (two rows resolve
  // to the same sessionId) and would lie about the visual hierarchy
  // ("this is in two places at once"). Same exclusivity invariant as
  // detached-vs-grid: each row belongs to exactly one bucket.
  const pinnedSet = new Set(
    state.pinnedSessionIds.filter(id => state.sessions[id]?.kind !== 'terminal'),
  )

  // The tab letter answers "which project group owns this row"; the
  // number answers "which visible dispatch item will cmd+N select".
  // That intentionally gives labels like A1, A2, B3, C4 in Global
  // Dispatch. Reusing pane-local numbers (B1, C1) looked tidy but made
  // keyboard dispatch ambiguous once multiple projects were visible.
  let globalIndex = 1
  return sourceTabs
    .map(tab => {
      const tabIndex = state.tabs.findIndex(item => item.id === tab.id)
      const gridSessionIds = collectLeaves(tab.root)
        // WHY terminals belong in the primary Dispatch row stream now:
        // Dispatch focus is session-based, not transcript-based. TerminalLeaf
        // already renders through renderWorkspaceLeaf and uses the same
        // sessionId-scoped IPC lifecycle as agents, so filtering terminals here
        // made the list lie about which live sessions the user could command.
        // Agent-only affordances stay guarded at their command/action sites;
        // row construction should answer the broader placement question:
        // "which sessions are in this Dispatch scope?"
        .filter(sessionId => state.sessions[sessionId] !== undefined)
        .filter(sessionId => !pinnedSet.has(sessionId))
      const detachedSessionIds = detachedDispatchSessionIdsForTab(state, tab.id)
        .filter(sessionId => !pinnedSet.has(sessionId))

      const entries = [
        ...gridSessionIds.map(sessionId => ({ sessionId, placement: 'grid' as const })),
        ...detachedSessionIds.map(sessionId => ({ sessionId, placement: 'detached' as const })),
      ]

      // Nesting pass: manual linked agents and MCP-created orchestration
      // agents render indented immediately under their parent row rather than
      // at the bottom of the tab group. We index children by parent, then walk
      // the natural order emitting each non-child row followed by its children.
      //
      // WHY the parent must also be in `entries` (same tab group):
      // both child types land in their parent's tab, so the parent is normally
      // present — but scope filters, a closed parent, or a pinned parent
      // (pinned rows are pulled into their own section) can leave the child
      // "orphaned" here. In that case the child is emitted as an ordinary
      // depth-0 row in its natural position rather than vanishing.
      //
      // WHY orchestration has its own parent field but shares this visual
      // nesting: the user experience is the same "this agent belongs under
      // that parent" shape, but the lifecycle and future controls are not the
      // same as manual Linked Agents. Keeping `linkedParentId` and
      // `orchestrationParentId` separate prevents accidental semantic coupling
      // while still reusing the established Dispatch row indentation.
      const entryIds = new Set(entries.map(e => e.sessionId))
      const childrenByParent = new Map<SessionId, typeof entries>()
      for (const e of entries) {
        const meta = state.sessions[e.sessionId]
        const parentId = meta?.linkedParentId ?? meta?.orchestrationParentId
        if (parentId && entryIds.has(parentId)) {
          const arr = childrenByParent.get(parentId) ?? []
          arr.push(e)
          childrenByParent.set(parentId, arr)
        }
      }
      const ordered: Array<{
        sessionId: SessionId
        placement: 'grid' | 'detached'
        depth: number
      }> = []
      for (const e of entries) {
        const meta = state.sessions[e.sessionId]
        const parentId = meta?.linkedParentId ?? meta?.orchestrationParentId
        // Children are emitted under their parent below — skip here.
        if (parentId && entryIds.has(parentId)) continue
        ordered.push({ ...e, depth: 0 })
        for (const child of childrenByParent.get(e.sessionId) ?? []) {
          ordered.push({ ...child, depth: 1 })
        }
      }

      // globalIndex is assigned in the FINAL (post-nesting) order so
      // the A1/A2/A3 labels run top-to-bottom exactly as the rows
      // render — a linked child takes the number of its visual slot.
      const rows = ordered.map(({ sessionId, placement, depth }) => {
        const meta = state.sessions[sessionId]
        const rowIndex = globalIndex++
        return {
          key: `${tab.id}:${placement}:${sessionId}`,
          label: `${tabIndexLabel(tabIndex)}${rowIndex}`,
          globalIndex: rowIndex,
          tabId: tab.id,
          tabTitle: tab.title,
          tabIndex,
          sessionId,
          kind: meta?.kind,
          title: sessionTitle(meta),
          placement,
          depth,
        } satisfies DispatchAgentRow
      })
      return { tab, tabIndex, rows } satisfies DispatchTabGroup
    })
    .filter(group => group.rows.length > 0)
}

export function flattenDispatchRows(groups: DispatchTabGroup[]): DispatchAgentRow[] {
  return groups.flatMap(group => group.rows)
}

export function buildVisibleDispatchRows(state: WorkspaceState): DispatchAgentRow[] {
  // WHY this helper exists instead of having every caller concatenate
  // pinned + grouped rows itself:
  // Dispatch now has multiple row classes (pinned agents, grid sessions,
  // detached sessions, and terminals). Keyboard navigation, command
  // targeting, close-after-delete focus, and the rendered list must agree on
  // the same linear order or the highlighted row and the acted-on session
  // drift apart. Keeping the visible row list here makes the selector layer
  // the single source of truth for "row N" semantics.
  return [
    ...buildPinnedDispatchRows(state),
    ...flattenDispatchRows(buildDispatchGroups(state)),
  ]
}

export function dispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  // WHY this goes through buildVisibleDispatchRows instead of
  // buildDispatchGroups:
  // pinned sessions are intentionally removed from their project group and
  // rendered in a separate Dispatch section. Focus takeovers such as Reader and
  // Spotlight still need to answer "which sessions are visible for this owning
  // tab?", not "which sessions remain after the pinned section was peeled off".
  // Using the same visible-row stream as command targeting and sanity checks
  // keeps a pinned row from being a valid command target but missing from the
  // Reader/Spotlight session switcher.
  return buildVisibleDispatchRows(state)
    .filter(row => row.tabId === tabId)
    .map(row => row.sessionId)
}

export function detachedDispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  // Keep this ordering in one place so the list UI and bulk attach agree on
  // what "all detached Dispatch sessions for this tab" means. Detached rows
  // are displayed oldest-first in buildDispatchGroups; bulk attach should
  // preserve that same user-visible sequence inside the normalized incoming
  // subtree.
  return Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)
}

export function selectVisibleDispatchRow(
  rows: DispatchAgentRow[],
  dispatchFocusedSessionId: SessionId | null | undefined,
  gridFocusedSessionId: SessionId | null | undefined,
): DispatchAgentRow | null {
  // WHY this selector lives with the row builder:
  // Dispatch has two focus-like ids in play. `dispatchFocusedSessionId` is the
  // persisted command selection, while `gridFocusedSessionId` is the active
  // tab's tile-tree focus used as a fallback when Dispatch focus is absent or
  // stale. The visible UI already follows this order in DispatchLayout; command
  // visibility and destructive actions must follow the same row-derived target
  // or the highlighted row and the command target drift apart again.
  for (const candidate of [dispatchFocusedSessionId, gridFocusedSessionId]) {
    if (!candidate) continue
    const focused = rows.find(row => row.sessionId === candidate)
    if (focused) return focused
  }
  return rows[0] ?? null
}

export function findTerminalSessionInTab(
  tab: Tab | null,
  state: WorkspaceState,
): SessionId | null {
  if (!tab) return null
  // WHY this uses the canonical tab-session resolver instead of scanning
  // `tab.root`: the project terminal is allowed to be detached into Dispatch
  // now. A grid-only scan makes the terminal disappear from the "does this tab
  // already have a project terminal?" question, and the DispatchLayout effect
  // will spawn a replacement PTY even though the original terminal is merely
  // parked in `detachedSessions`. The terminal ownership question is "owned by
  // this tab", not "currently mounted in the tile tree".
  return resolveTabSessions(state, tab.id).find(id => state.sessions[id]?.kind === 'terminal') ?? null
}

/**
 * Build the rows that render in the "Pinned" section at the top of
 * DispatchAgentList. Order matches `state.pinnedSessionIds` exactly
 * (first pinned == top of section).
 *
 * Unlike buildDispatchGroups, this is NOT scope-aware: pins are
 * cross-project by design and the Pinned section always shows every
 * pin regardless of whether dispatch is in project or global scope.
 * The per-row `tabIndex` is still returned so the renderer can show
 * the small project chip and so cmd+N keyboard dispatch resolves to
 * the right tab.
 *
 * Pinned sessions that no longer exist are silently dropped. The
 * autosave filter in useAutoSave.ts should catch these on normal
 * removal, but a stale entry surviving the durability boundary
 * (e.g. a race during fresh-workspace bootstrap, hand-edited
 * workspace.json) must not produce a row that resolves to nothing
 * on focus — so we also drop here at render time.
 */
export function buildPinnedDispatchRows(
  state: WorkspaceState,
): DispatchAgentRow[] {
  const rows: DispatchAgentRow[] = []
  let pinnedIndex = 1
  for (const sessionId of state.pinnedSessionIds) {
    const meta = state.sessions[sessionId]
    if (!meta || meta.kind === 'terminal') continue
    // Locate the owning tab. A pinned agent that's detached has its
    // tab id on `detachedSessions[sessionId].projectTabId`; a
    // grid-placed pinned agent is a leaf in some tab's tree. We do
    // the lookup detached-first because detachedSessions is O(1) and
    // catches the "background pinned agent" case the user is likely
    // pinning in the first place (an agent they don't want crowding
    // the visible grid but want one keystroke away).
    const detached = state.detachedSessions[sessionId]
    let tabId: TabId | null = null
    let placement: 'grid' | 'detached' = 'grid'
    if (detached) {
      tabId = detached.projectTabId
      placement = 'detached'
    } else {
      const owner = state.tabs.find(tab =>
        collectLeaves(tab.root).includes(sessionId),
      )
      tabId = owner?.id ?? null
    }
    if (!tabId) continue
    const tabIndex = state.tabs.findIndex(tab => tab.id === tabId)
    const tab = state.tabs[tabIndex]
    if (!tab) continue
    rows.push({
      // ★ prefix keeps the row key unique against project-group rows
      // (whose keys are `${tabId}:${placement}:${sessionId}`) so any
      // caller that flat-concats both arrays — see the spread in
      // DispatchLayout — won't collide on React keys.
      key: `pinned:${sessionId}`,
      label: `★${pinnedIndex}`,
      globalIndex: pinnedIndex,
      tabId,
      tabTitle: tab.title,
      tabIndex,
      sessionId,
      kind: meta.kind,
      title: sessionTitle(meta),
      placement,
      // Pinned rows live in their own flat section — never nested.
      depth: 0,
    })
    pinnedIndex += 1
  }
  return rows
}

/**
 * Convenience predicate for one-shot pin checks from commands and
 * other UI surfaces. Hot-path callers should build a local
 * `Set(state.pinnedSessionIds)` instead (see buildDispatchGroups);
 * this helper trades that O(n) array scan for ergonomics.
 */
export function isPinned(state: WorkspaceState, sessionId: SessionId): boolean {
  return state.pinnedSessionIds.includes(sessionId)
}

/**
 * Where a NEW Dispatch agent should be created.
 *
 *  - `tabId`        — the project tab the agent is filed under
 *                     (becomes detachedSessions[id].projectTabId).
 *  - `cwdSessionId` — the existing session whose cwd the new agent
 *                     inherits, or null to let the caller fall back to
 *                     the tab's leaves.
 *  - `laneIndex`    — in Tiled Dispatch, the lane the new agent should
 *                     occupy so it appears where the user is looking;
 *                     null in classic Dispatch.
 *
 * WHY this is a selector instead of inline logic in the spawn actions:
 * `createDetachedDispatchAgent` and `splitFocused` both have to answer
 * "which project does a new agent belong to?" and they used to read
 * cwd from `dispatchMode.focusedSessionId` but the project tab from
 * `activeTabId`. Those two fields agree in classic Dispatch (focusing a
 * row syncs both via focusDispatchSession) but DIVERGE in Tiled
 * Dispatch: lane focus/selection (setTiledFocusedLane /
 * setTiledLaneSession) writes only `tiled.focusedLane` and
 * `lanes[].selectedSessionId` — never the classic focus fields. The
 * result was new agents landing in the stale active tab instead of the
 * focused lane's project (issue #266 / #248 regression). Resolving the
 * target in one place keeps cwd and projectTab on the SAME project for
 * both surfaces.
 */
export type DispatchSpawnTarget = {
  tabId: TabId
  cwdSessionId: SessionId | null
  laneIndex: number | null
}

export function resolveDispatchSpawnTarget(state: WorkspaceState): DispatchSpawnTarget {
  const dm = state.dispatchMode
  if (!dm) {
    return { tabId: state.activeTabId, cwdSessionId: null, laneIndex: null }
  }

  // The visible rows are the scope-correct source of "which tab owns this
  // session?" — the same list the user sees and that lane resolution uses.
  const rows = buildVisibleDispatchRows(state)
  const tabForSession = (id: SessionId | undefined | null): TabId | null =>
    id ? rows.find(row => row.sessionId === id)?.tabId ?? null : null

  // Tiled Dispatch: the focused lane is the command target.
  if (dm.tiled) {
    const laneIndex = dm.tiled.focusedLane
    const laneSessionId = dm.tiled.lanes[laneIndex]?.selectedSessionId ?? null
    const laneTab = tabForSession(laneSessionId)
    if (laneTab) {
      return { tabId: laneTab, cwdSessionId: laneSessionId, laneIndex }
    }
    // Focused lane is empty / its agent is gone: there is no project to read
    // from the lane itself, so fall back to the classic focus, then the active
    // tab — but still place the new agent INTO the focused lane.
    const focusTab = tabForSession(dm.focusedSessionId)
    return {
      tabId: focusTab ?? state.activeTabId,
      cwdSessionId: focusTab ? dm.focusedSessionId ?? null : null,
      laneIndex,
    }
  }

  // Classic Dispatch: prefer the focused session's own tab so cwd and
  // projectTab stay on the same project even if activeTabId ever drifts.
  const focusTab = tabForSession(dm.focusedSessionId)
  if (focusTab) {
    return { tabId: focusTab, cwdSessionId: dm.focusedSessionId ?? null, laneIndex: null }
  }
  return { tabId: state.activeTabId, cwdSessionId: null, laneIndex: null }
}

function sessionTitle(
  meta: WorkspaceState['sessions'][SessionId] | undefined,
): string {
  if (meta?.title?.trim()) return meta.title.trim()
  return basename(meta?.cwd ?? 'agent')
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
