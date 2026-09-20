import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type {
  SessionId,
  SessionMeta,
  Tab,
  WorkspaceState,
} from '@renderer/workspace/types'
import { migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'

// Taking over a closed window's workspace.
//
// WHY the surviving window merges rather than main: main deliberately treats a
// window's workspace payload as opaque bytes (see storage/workspaceFile.ts), and
// this merge needs to reason about projects, sessions, pins and drafts.
// Duplicating that model in main is exactly the second-opinion problem
// `sessionOwnership.ts` warns about — two implementations of "who owns this
// session" that are free to disagree.
//
// WHAT is adopted (#992): the closed window's POOL — its projects and every
// session filed under them. Its STAGE is not. A stage is one window's screen:
// the survivor already has its own lanes showing what its user arranged, and
// another window closing is not a request to rearrange them. The adopted
// agents appear in the survivor's index, under their own projects, one
// keystroke from any lane.
//
// WHY projects move with their sessions rather than the sessions being re-homed
// onto an existing project: a session is owned because its `projectId` names a
// project that exists (sessionOwnership.ts). Bare rows would be unowned and
// deleted by the survivor's very next autosave. Carrying the project keeps
// every `projectId` valid by construction, with nothing rewritten.
//
// WHY the slice goes through `migrateWorkspaceToStage` first: it is another
// window's FILE, and that file may be any generation — v2 (tile trees, a
// detached bucket, buried panes), v3, or the hybrid. One normalizer means this
// function reasons about one shape, and the v2 ownership rules (which sessions
// were really owned, which buried ones re-parent) are applied exactly as
// rehydrate applies them. Until #992 this function carried tile trees across
// verbatim and folded buried records by hand.

export type WorkspaceAdoption =
  | {
      ok: true
      state: Pick<WorkspaceState, 'tabs' | 'sessions' | 'pinnedSessionIds'>
      /** Every session the survivor now owns. All of them need a runtime; see
       *  the wake-path note in useWorkspaceAdoption. */
      adoptedSessionIds: SessionId[]
      drafts: Record<SessionId, string>
    }
  | {
      /**
       * Refused. The caller must NOT delete the closing window's persisted
       * slice, so the workspace is restored as its own window on next launch
       * instead of being lost.
       */
      ok: false
      reason: string
    }

/**
 * Merge a closed window's persisted workspace into the surviving window's live
 * state.
 *
 * Pure: no IPC, no runtimes, no React. The caller applies the returned state
 * and seeds a runtime for every id in `adoptedSessionIds`, because the wake
 * path for a parked agent no-ops without one.
 */
export function adoptWorkspace(
  current: WorkspaceState,
  incomingInput: PersistedWorkspace,
): WorkspaceAdoption {
  // Defensive on purpose: the slice is another window's file. A payload with
  // no sessions map at all normalizes to an empty pool rather than throwing.
  const incoming = migrateWorkspaceToStage({
    ...incomingInput,
    sessions: incomingInput.sessions ?? {},
  })
  const currentSessionIds = new Set(Object.keys(current.sessions))
  const currentTabIds = new Set(current.tabs.map(tab => tab.id))

  const incomingSessionIds = Object.keys(incoming.sessions)
  const collidingSessionIds = incomingSessionIds.filter(id => currentSessionIds.has(id))
  const collidingTabIds = incoming.projects.map(project => project.id).filter(id => currentTabIds.has(id))

  if (collidingSessionIds.length > 0 || collidingTabIds.length > 0) {
    // WHY the whole adoption is refused rather than the colliding rows dropped:
    //
    // Both id spaces are `randomUUID()`, so a collision means the file was
    // hand-edited or two windows somehow restored the same slice — a state
    // where "merge the parts that fit" is guessing. Dropping a colliding
    // project would strand its sessions: alive in SessionManager, owned by no
    // window, invisible and unkillable from the UI. Refusing leaves the closed
    // window's slice on disk, so the next launch restores it as its own window
    // with everything intact. Nothing is lost; the user just gets a window back.
    return {
      ok: false,
      reason: `id collision (${collidingSessionIds.length} sessions, ${collidingTabIds.length} tabs)`,
    }
  }

  const sessions: Record<SessionId, SessionMeta> = {
    ...current.sessions,
    ...incoming.sessions,
  }

  // Only projects that still hold a session: one whose every session the
  // migration dropped as unowned has nothing to list.
  const populated = new Set(Object.values(incoming.sessions).map(meta => meta.projectId))
  const tabs: Tab[] = [
    ...current.tabs,
    ...incoming.projects
      .filter(project => populated.has(project.id))
      .map(project => ({ id: project.id, title: project.title })),
  ]

  // Pins append rather than interleave: `pinnedSessionIds` order IS the Pinned
  // section's render order, and the survivor's own pins are the ones the user
  // arranged most recently in the window they are still looking at. The
  // migration has already dropped pins naming sessions it did not keep.
  const pinnedSessionIds: SessionId[] = [
    ...current.pinnedSessionIds,
    ...incoming.pinnedSessionIds,
  ]

  return {
    ok: true,
    state: { tabs, sessions, pinnedSessionIds },
    adoptedSessionIds: incomingSessionIds,
    // Drafts are half-written prompts. Losing one to a window close is exactly
    // the kind of small, silent data loss autosave exists to prevent.
    drafts: incoming.drafts ?? {},
  }
}
