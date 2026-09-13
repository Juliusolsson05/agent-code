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
// Membership rules mirror the renderer's resolveTabSessions: a grid leaf belongs
// to the tab whose tile tree holds it; a Dispatch row belongs to its
// `projectTabId`; a buried pane still runs and belongs to its `sourceTabId`.

export type SessionPlacement = {
  sessionId: string
  kind: string
  cwd: string | null
  title: string | null
  agentNameId: string | null
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

function collectLeaves(node: unknown, out: string[], depth = 0): void {
  // Depth guard: a corrupt self-referencing document must not recurse forever.
  if (!isRecord(node) || depth > 64) return
  if (node.type === 'leaf') {
    const id = str(node.sessionId)
    if (id) out.push(id)
    return
  }
  if (node.type === 'split') {
    collectLeaves(node.a, out, depth + 1)
    collectLeaves(node.b, out, depth + 1)
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
    for (const record of Array.isArray(workspace.buried) ? workspace.buried : []) {
      if (!isRecord(record)) continue
      const sessionId = str(record.sessionId)
      const tabId = str(record.sourceTabId)
      if (sessionId && tabId && !tabBySession.has(sessionId)) tabBySession.set(sessionId, tabId)
    }

    for (const [sessionId, meta] of Object.entries(workspace.sessions)) {
      if (!isRecord(meta)) continue
      const tabId = tabBySession.get(sessionId) ?? null
      sessions.set(sessionId, {
        sessionId,
        // Missing kind is legacy Claude, the renderer's DEFAULT_PROVIDER.
        kind: str(meta.kind) ?? 'claude',
        cwd: str(meta.cwd),
        title: str(meta.title),
        agentNameId: str(meta.agentNameId),
        orchestration: str(meta.orchestrationParentId) !== null,
        tabId,
        tabTitle: tabId ? (tabTitleById.get(tabId) || null) : null,
      })
    }
  }
  return { sessions, openTabTitles }
}
