import { AgentNameRegistry } from '@main/agentNames/registry.js'
import {
  EMPTY_WORKSPACE_PROJECTION,
  projectWorkspace,
} from '@main/agentActivity/workspaceProjection.js'
import type { SessionPlacement } from '@main/agentActivity/workspaceProjection.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'

// Remote workspace projection — the read model behind every "which agent is
// this, where does it live, what's it called" fact the phone shows.
//
// WHY a dedicated module instead of reading workspace.json inline in
// RemoteServer: the phone's session list needs title, spoken agent name,
// project tab, pin state, and TLDR identity — five joins over one document,
// and every one of them is renderer-owned metadata that reaches main only
// through workspace saves (same reasoning as the analytics projection in
// agentActivity/workspaceProjection.ts, whose parsing this reuses rather
// than duplicating). Keeping the join in one class means the session-list
// frame, the TLDR/Goal identity join, and future consumers cannot disagree
// about what a session is called.
//
// Freshness contract: the WorkspaceFileStore notifies observers with the
// document EXACTLY as it reached disk, in commit order. This module
// re-projects synchronously on every notification, so the projection is
// never ahead of durability, only one autosave-debounce behind the
// renderer's live state — the accepted lag for everything main-side that
// reads renderer metadata (analytics accepts the same).
//
// Agent names resolve asynchronously (the registry serializes allocation).
// The synchronous re-project publishes placements with whatever names are
// already cached; the name resolution lands as a second update. Consumers
// see a session appear unnamed for one tick rather than blocked on a
// registry round-trip — the name is display polish, not identity.

/** Everything the remote needs to know about one session's identity. */
export type RemoteSessionIdentity = {
  sessionId: string
  title: string | null
  agentName: string | null
  tabTitle: string | null
  pinned: boolean
  tldrIdentity: string | null
  cwd: string | null
  kind: string
}

export class RemoteWorkspaceProjection {
  /** sessionId → identity, rebuilt on every committed workspace save. */
  private sessions = new Map<string, RemoteSessionIdentity>()
  private readonly nameById = new Map<string, string>()
  private readonly changeListeners = new Set<() => void>()
  private readonly unobserve: () => void
  private disposed = false

  constructor(
    private readonly store: WorkspaceFileStore,
    private readonly names: AgentNameRegistry,
  ) {
    // Prime from the document the store already holds — a phone that pairs
    // before the first autosave must still see titles from the previous
    // run's persisted workspace.
    this.reproject(store.windows())
    this.unobserve = store.observe(windows => this.reproject(windows))
  }

  /** Live identity snapshot. Read-only by convention; treat as frozen. */
  snapshot(): ReadonlyMap<string, RemoteSessionIdentity> {
    return this.sessions
  }

  /** Notified after every re-projection that CHANGED something, including
   *  the late landing of agent-name resolution. Coalescing is the
   *  listener's job (RemoteServer resends one session-list frame). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  dispose(): void {
    this.disposed = true
    this.changeListeners.clear()
    this.unobserve()
  }

  private reproject(windows: readonly PersistedWindow[]): void {
    if (this.disposed) return
    const projection = projectWorkspace(windows)
    const next = new Map<string, RemoteSessionIdentity>()
    const missingNames: string[] = []
    for (const placement of projection.sessions.values()) {
      const agentName = placement.agentNameId
        ? (this.nameById.get(placement.agentNameId) ?? null)
        : null
      if (placement.agentNameId && !this.nameById.has(placement.agentNameId)) {
        missingNames.push(placement.agentNameId)
      }
      next.set(placement.sessionId, {
        sessionId: placement.sessionId,
        title: placement.title,
        agentName,
        tabTitle: placement.tabTitle,
        pinned: placement.pinned,
        tldrIdentity: placement.tldrIdentity,
        cwd: placement.cwd,
        kind: placement.kind,
      })
    }

    const changed = !mapsEqual(this.sessions, next)
    this.sessions = next
    if (changed) this.notify()

    if (missingNames.length > 0) {
      // Fire-and-forget by design: the registry resolves off the save tail;
      // when it lands, a second notify publishes the names. A failure keeps
      // the unnamed display (the registry's own logging covers diagnosis) —
      // a projection must never turn a name lookup into an error path.
      void this.names
        .resolve(missingNames)
        .then(resolved => {
          if (this.disposed) return
          let namesChanged = false
          for (const [id, name] of Object.entries(resolved)) {
            if (!this.nameById.has(id) || this.nameById.get(id) !== name) {
              this.nameById.set(id, name)
              namesChanged = true
            }
          }
          if (namesChanged) {
            // Re-project from the CURRENT document — the world may have
            // saved again while the resolution was in flight.
            this.reproject(this.store.windows())
          }
        })
        .catch(() => {})
    }
  }

  private notify(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // A projection is a sink, never a decider (same invariant as the
        // store's own observers): one bad listener must not break the
        // notification for the rest.
      }
    }
  }
}

function mapsEqual(
  a: ReadonlyMap<string, RemoteSessionIdentity>,
  b: ReadonlyMap<string, RemoteSessionIdentity>,
): boolean {
  if (a.size !== b.size) return false
  for (const [id, identity] of a) {
    const other = b.get(id)
    if (!other) return false
    if (
      identity.title !== other.title ||
      identity.agentName !== other.agentName ||
      identity.tabTitle !== other.tabTitle ||
      identity.pinned !== other.pinned ||
      identity.tldrIdentity !== other.tldrIdentity ||
      identity.cwd !== other.cwd ||
      identity.kind !== other.kind
    ) {
      return false
    }
  }
  return true
}

export { EMPTY_WORKSPACE_PROJECTION }
export type { SessionPlacement }
