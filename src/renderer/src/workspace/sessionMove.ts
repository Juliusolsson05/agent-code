import { isProcessSessionKind } from '@shared/types/providerKind'
import { withNormalizedBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import { findTabsHoldingDirectory, resolveTabSessions } from '@renderer/workspace/queries'
import type {
  SessionId,
  SessionMeta,
  Tab,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'

// Moving agents between two LIVE windows (#1481): the pure half.
//
// Main owns routing authority and the ordering of the handoff
// (main/window/sessionMove.ts). Everything about WHICH rows move and WHERE
// they land is a renderer concept (projects, pins, drafts, ownership), so it
// lives here as pure functions over WorkspaceState, the same split
// adoptWorkspace.ts and mergeProjectTabs.ts use, and for the same reason: one
// implementation of "who owns this session" instead of two that can disagree.

/**
 * What the source window hands the target. Versioned because it crosses a
 * process boundary between two renderers that may be different builds for a
 * moment (one window reloaded into a newer bundle during development). An
 * unknown version is refused, which rolls the move back; guessing at a shape
 * would be worse than "try again".
 */
export type SessionMovePacket = {
  version: 1
  /** The agent the user picked. It is shown in the target's focused lane. */
  rootSessionId: SessionId
  /** Every project a moved row belongs to IN THE SOURCE, for title and grouping. */
  projects: Array<{ id: TabId; title: string }>
  /** The moved rows, root first, then its descendants in tree order. */
  sessions: Record<SessionId, SessionMeta>
  /** Source pin order, restricted to moved rows. */
  pinnedSessionIds: SessionId[]
  /** Unsent composer text. Losing a half-written prompt to a move would be the
   *  same small silent loss autosave persists drafts to prevent. */
  drafts: Record<SessionId, string>
}

/**
 * The agent plus everything that belongs to it, root first.
 *
 * WHY descendants move with the agent (owner ruling 3): a linked agent and an
 * orchestration worker are lifecycle-bound to their parent. closeSession keeps
 * a parent while a linked child is open, and orchestration tools reach workers
 * through the parent's window. Leaving a child behind would split one unit of
 * work across two windows, where neither window's index shows it whole.
 *
 * The edge is `linkedParentId ?? orchestrationParentId`, the same single owner
 * `ownershipDepth` (bulkClose.ts) and the index grouping (dispatchSelectors)
 * use, so "what moves with it" is exactly "what the index nests under it".
 * Walked transitively because an orchestration worker can create workers of
 * its own; cycle-safe because a hand-edited file can contain a parent loop.
 */
export function collectMoveSubtree(
  sessions: WorkspaceState['sessions'],
  rootSessionId: SessionId,
): SessionId[] {
  if (!sessions[rootSessionId]) return []
  const childrenByOwner = new Map<SessionId, SessionId[]>()
  for (const [id, meta] of Object.entries(sessions)) {
    const owner = meta.linkedParentId ?? meta.orchestrationParentId
    if (!owner || owner === id) continue
    const list = childrenByOwner.get(owner) ?? []
    list.push(id)
    childrenByOwner.set(owner, list)
  }
  const ordered: SessionId[] = []
  const seen = new Set<SessionId>()
  // Depth-first, children in index order (joinedAt), so the target's index
  // lists them under the root in the order the source showed them.
  const visit = (id: SessionId) => {
    if (seen.has(id)) return
    seen.add(id)
    ordered.push(id)
    const children = [...(childrenByOwner.get(id) ?? [])]
      .sort((a, b) => (sessions[a]?.joinedAt ?? 0) - (sessions[b]?.joinedAt ?? 0))
    for (const child of children) visit(child)
  }
  visit(rootSessionId)
  return ordered
}

export type BuildSessionMovePacketResult =
  | { ok: true; packet: SessionMovePacket; sessionIds: SessionId[] }
  | { ok: false; message: string }

export function buildSessionMovePacket(
  state: WorkspaceState,
  drafts: Record<SessionId, string>,
  rootSessionId: SessionId,
): BuildSessionMovePacketResult {
  const sessionIds = collectMoveSubtree(state.sessions, rootSessionId)
  if (sessionIds.length === 0) return { ok: false, message: 'That agent is no longer open.' }
  // Agents and terminals only. An extension view has no backend to route, and
  // its view would need the extension installed and running in the other
  // window, which a row move cannot promise. The rule lives HERE so the
  // command, the picker and agents.moveToWindow all refuse the same thing
  // (#1481 review: the capability first accepted what the command hid).
  if (!isProcessSessionKind(state.sessions[rootSessionId]!.kind)) {
    return { ok: false, message: 'Extension views stay in their window; only agents and terminals can be moved.' }
  }
  const sessions: Record<SessionId, SessionMeta> = {}
  for (const id of sessionIds) {
    // Normalized exactly as autosave writes a row: the target persists these
    // rows next, and the packet is in effect a slice of this window's file.
    sessions[id] = withNormalizedBuiltInMcpDomains(state.sessions[id]!)
  }
  // A row with no project is unowned; autosave would drop it, and the target
  // has no project to file it under. Refusing here keeps an invariant
  // violation from being "fixed" by silently losing the row on the far side.
  const unfiled = sessionIds.filter(id => !state.tabs.some(tab => tab.id === sessions[id]!.projectId))
  if (unfiled.length > 0) return { ok: false, message: 'That agent has no project and cannot be moved.' }
  const projectIds = new Set(sessionIds.map(id => sessions[id]!.projectId!))
  const moved = new Set(sessionIds)
  return {
    ok: true,
    sessionIds,
    packet: {
      version: 1,
      rootSessionId,
      projects: state.tabs.filter(tab => projectIds.has(tab.id)).map(tab => ({ id: tab.id, title: tab.title })),
      sessions,
      pinnedSessionIds: state.pinnedSessionIds.filter(id => moved.has(id)),
      drafts: Object.fromEntries(Object.entries(drafts).filter(([id, text]) => moved.has(id) && text.length > 0)),
    },
  }
}

export type ReceiveMovedSessionsResult =
  | {
      ok: true
      state: WorkspaceState
      movedSessionIds: SessionId[]
      /** Projects this move created. A cancelled move removes them again only
       *  if they are still empty (workspaceWithoutSessions' rule). */
      addedTabIds: TabId[]
    }
  | { ok: false; reason: string }

/** Parse and shape-check a packet from another renderer. */
export function parseSessionMovePacket(json: string): SessionMovePacket | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const packet = value as Partial<SessionMovePacket>
  if (packet.version !== 1 || typeof packet.rootSessionId !== 'string') return null
  if (!packet.sessions || typeof packet.sessions !== 'object' || !packet.sessions[packet.rootSessionId]) return null
  if (!Array.isArray(packet.projects) || !Array.isArray(packet.pinnedSessionIds)) return null
  if (!packet.drafts || typeof packet.drafts !== 'object') return null
  const projectIds = new Set(packet.projects.map(project => project?.id))
  // Every row must name a project the packet carries; otherwise there is no
  // title or grouping to give it and it would land unowned.
  if (Object.values(packet.sessions).some(meta => !meta || typeof meta.cwd !== 'string' || meta.projectId === undefined || !projectIds.has(meta.projectId))) return null
  return packet as SessionMovePacket
}

/**
 * Merge moved rows into the target window's live state.
 *
 * Projects: each source project lands in a target project that already holds
 * the same folder (owner ruling 2), matched by `findTabsHoldingDirectory`, the
 * rule New Tab reuse uses, so "same folder" means the same thing everywhere.
 * Otherwise a NEW project tab is created with a FRESH id.
 *
 * WHY a fresh id and not the source project's: tab ids are window-local UUIDs,
 * and the source window usually keeps that project (with its other agents).
 * If both windows held the same project id, closing one window later would
 * offer its slice to the other as a bequest, `adoptWorkspace` would see the
 * collision and refuse the WHOLE adoption, and the closed window's workspace
 * would only come back on the next launch. A new id costs nothing: a row's
 * `projectId` is the only thing that names it.
 *
 * Moved rows are APPENDED to their target project's index, the same choice
 * and the same reasons as Merge Project Tabs: "put these in here too", with
 * the target's existing labels left where they were.
 *
 * Lanes are not touched here: showing the root in the focused lane goes
 * through the ordinary lane-select action afterwards, which owns its own
 * bounds checks.
 */
export function receiveMovedSessions(
  current: WorkspaceState,
  packet: SessionMovePacket,
  options: { now: number; newTabId: () => TabId },
): ReceiveMovedSessionsResult {
  const incomingIds = [
    packet.rootSessionId,
    ...Object.keys(packet.sessions).filter(id => id !== packet.rootSessionId),
  ]
  const colliding = incomingIds.filter(id => current.sessions[id] !== undefined)
  if (colliding.length > 0) {
    // Session ids are durable UUIDs, so the target already holding one means
    // the agent is shown here already (a second move of it, or a duplicate
    // left by a crash mid-move). Merging would overwrite the row in place and
    // the source would then drop its copy; refusing leaves both as they are.
    return { ok: false, reason: `This window already shows ${colliding.length === 1 ? 'that agent' : `${colliding.length} of those agents`}.` }
  }

  const tabs: Tab[] = [...current.tabs]
  const addedTabIds: TabId[] = []
  const targetBySourceProject = new Map<TabId, TabId>()
  for (const project of packet.projects) {
    const rows = incomingIds.filter(id => packet.sessions[id]!.projectId === project.id)
    if (rows.length === 0) continue
    // The folder the project is "about" is its first moved row's: the root
    // when the root is in it, otherwise the shallowest descendant.
    const cwd = packet.sessions[rows[0]!]!.cwd
    const existing = findTabsHoldingDirectory(current, cwd)[0]
    if (existing) {
      targetBySourceProject.set(project.id, existing.id)
      continue
    }
    let id = options.newTabId()
    while (tabs.some(tab => tab.id === id)) id = options.newTabId()
    tabs.push({ id, title: project.title })
    addedTabIds.push(id)
    targetBySourceProject.set(project.id, id)
  }

  const sessions: Record<SessionId, SessionMeta> = { ...current.sessions }
  // One running position per target project, strictly after everything that
  // project already lists, whatever clock those rows were stamped with.
  const nextPosition = new Map<TabId, number>()
  for (const id of incomingIds) {
    const meta = packet.sessions[id]!
    const target = targetBySourceProject.get(meta.projectId!)!
    if (!nextPosition.has(target)) {
      const last = resolveTabSessions({ ...current, sessions }, target)
        .reduce((max, sessionId) => Math.max(max, sessions[sessionId]?.joinedAt ?? 0), 0)
      nextPosition.set(target, Math.max(options.now, last + 1))
    }
    const joinedAt = nextPosition.get(target)!
    nextPosition.set(target, joinedAt + 1)
    sessions[id] = { ...meta, projectId: target, joinedAt }
  }

  // Appended, like adoption: the target's own pins are the ones arranged in
  // the window the user is looking at.
  const pinnedSessionIds = [
    ...current.pinnedSessionIds,
    ...packet.pinnedSessionIds.filter(id => packet.sessions[id] && !current.pinnedSessionIds.includes(id)),
  ]

  return {
    ok: true,
    // Focus (activeTabId) deliberately stays: a move is not a request to
    // navigate the target window, the same rule adoption follows.
    state: { ...current, tabs, sessions, pinnedSessionIds },
    movedSessionIds: incomingIds,
    addedTabIds,
  }
}
