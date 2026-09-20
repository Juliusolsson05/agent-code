import type { PersistedWindow } from '@main/storage/workspaceFile.js'

// Where each session lives, read from the persisted workspace (#964).
//
// WHY the persisted workspace and not the renderer: main owns the analytics so
// every window gets one answer, but tabs, titles, agent names and orchestration
// links are renderer-owned metadata that reach main only through workspace saves.
// The conversation ledger already reads the same document for the same reason.
// The shape is the renderer's PersistedWorkspace, opaque to main, so it is read
// defensively: a malformed or future field degrades to "unknown", never a throw.
//
// Membership rules mirror the renderer's, for BOTH file generations, because
// main reads whatever is on disk and a window that has not saved since an
// upgrade still holds a v2 document:
//
//   v3 (#992) — a session belongs to the project its own row names
//     (`sessions[id].projectId`), and projects are listed under `projects`.
//   v2 — a grid leaf belongs to the tab whose tile tree holds it; a Dispatch
//     row belongs to its `projectTabId`; a buried pane still runs and belongs
//     to its `sourceTabId`. Tabs are listed under `tabs`.
//
// The row's own `projectId` wins when both are present (the intermediate
// builds wrote both), matching migrateWorkspaceToStage. This is a deliberately
// small, defensive RE-STATEMENT of that precedence rather than an import of
// it: main treats the renderer's document as opaque and must not throw on a
// shape it does not recognize.

export type SessionPlacement = {
  sessionId: string
  kind: string
  cwd: string | null
  title: string | null
  agentNameId: string | null
  /** TLDR/Goal store identity. The remote subsystem joins this to the
   *  TldrStore instances so TLDR/Goal frames can be keyed by sessionId on
   *  the wire without the phone ever learning the identity scheme. */
  tldrIdentity: string | null
  /** Pinned to the top of its dispatch list. */
  pinned: boolean
  /** Spawned by another agent through orchestration. */
  orchestration: boolean
  tabId: string | null
  tabTitle: string | null
}

export type WorkspaceProjection = {
  sessions: ReadonlyMap<string, SessionPlacement>
  /** Titles of every tab open in any window. */
  openTabTitles: ReadonlySet<string>
}

export const EMPTY_WORKSPACE_PROJECTION: WorkspaceProjection = {
  sessions: new Map(),
  openTabTitles: new Set(),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function collectLeaves(
  node: unknown,
  out: string[],
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  // Two guards, because they stop different things.
  //
  // `seen` stops a node from being walked twice. This used to be a depth cap
  // ALONE, commented as the guard against "a corrupt self-referencing
  // document" — and it was not one. A split walks TWO children, so a node
  // whose `a` and `b` both point back at itself is not a 64-step loop, it is a
  // 2^64-call tree: the cap bounded the depth of every path and did nothing
  // about how many paths there were. workspaceProjection.test.ts found this by
  // hanging. (A document read from disk is JSON and cannot hold a cycle, so
  // production never met it; the guard claimed to cover the in-memory case and
  // silently did not, which is worse than not claiming it.)
  //
  // `depth` is kept for what a depth cap IS good for: the call stack. A
  // hand-edited file can nest splits arbitrarily deep with no cycle at all,
  // and this runs in the main process, where a RangeError is an app crash.
  // Real trees were never deeper than the number of panes in a tab.
  if (!isRecord(node) || depth > 64 || seen.has(node)) return
  seen.add(node)
  if (node.type === 'leaf') {
    const id = str(node.sessionId)
    if (id) out.push(id)
    return
  }
  if (node.type === 'split') {
    collectLeaves(node.a, out, seen, depth + 1)
    collectLeaves(node.b, out, seen, depth + 1)
  }
}

export function projectWorkspace(windows: readonly PersistedWindow[]): WorkspaceProjection {
  const sessions = new Map<string, SessionPlacement>()
  const openTabTitles = new Set<string>()

  for (const window of windows) {
    const workspace = window.workspace
    if (!isRecord(workspace) || !isRecord(workspace.sessions)) continue

    const tabTitleById = new Map<string, string>()
    const tabBySession = new Map<string, string>()
    // v3 projects first: id + title, no tree.
    for (const project of Array.isArray(workspace.projects) ? workspace.projects : []) {
      if (!isRecord(project)) continue
      const projectId = str(project.id)
      if (!projectId) continue
      const title = str(project.title) ?? ''
      tabTitleById.set(projectId, title)
      if (title) openTabTitles.add(title)
    }
    for (const tab of Array.isArray(workspace.tabs) ? workspace.tabs : []) {
      if (!isRecord(tab)) continue
      const tabId = str(tab.id)
      if (!tabId) continue
      const title = str(tab.title) ?? ''
      tabTitleById.set(tabId, title)
      if (title) openTabTitles.add(title)
      const leaves: string[] = []
      collectLeaves(tab.root, leaves)
      for (const leaf of leaves) tabBySession.set(leaf, tabId)
    }
    if (isRecord(workspace.detachedSessions)) {
      for (const record of Object.values(workspace.detachedSessions)) {
        if (!isRecord(record)) continue
        const sessionId = str(record.sessionId)
        const tabId = str(record.projectTabId)
        if (sessionId && tabId && !tabBySession.has(sessionId)) tabBySession.set(sessionId, tabId)
      }
    }
    // Pinned ids live at the workspace level (the dispatch list's pin order
    // is renderer state; the projection only needs membership).
    const pinnedIds = new Set<string>()
    if (Array.isArray(workspace.pinnedSessionIds)) {
      for (const id of workspace.pinnedSessionIds) {
        const sessionId = str(id)
        if (sessionId) pinnedIds.add(sessionId)
      }
    }
    for (const record of Array.isArray(workspace.buried) ? workspace.buried : []) {
      if (!isRecord(record)) continue
      const sessionId = str(record.sessionId)
      const tabId = str(record.sourceTabId)
      if (sessionId && tabId && !tabBySession.has(sessionId)) tabBySession.set(sessionId, tabId)
    }

    for (const [sessionId, meta] of Object.entries(workspace.sessions)) {
      if (!isRecord(meta)) continue
      const stamped = str(meta.projectId)
      const tabId = (stamped && tabTitleById.has(stamped) ? stamped : null)
        ?? tabBySession.get(sessionId)
        ?? null
      sessions.set(sessionId, {
        sessionId,
        // Missing kind is legacy Claude, the renderer's DEFAULT_PROVIDER.
        kind: str(meta.kind) ?? 'claude',
        cwd: str(meta.cwd),
        title: str(meta.title),
        agentNameId: str(meta.agentNameId),
        tldrIdentity: str(meta.tldrIdentity),
        pinned: pinnedIds.has(sessionId),
        orchestration: str(meta.orchestrationParentId) !== null,
        tabId,
        tabTitle: tabId ? (tabTitleById.get(tabId) || null) : null,
      })
    }
  }
  return { sessions, openTabTitles }
}
