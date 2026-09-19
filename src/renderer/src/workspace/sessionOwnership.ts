import type {
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import {
  keepTiledLaneSessions,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { hasSessionMeta } from '@renderer/workspace/legacyWorkspaceV2'

export { hasSessionMeta }

export type SessionOwnershipInput = {
  tabs: ReadonlyArray<{ id: TabId }>
  sessions: Record<SessionId, SessionMeta>
}

export type PrunedSessionOwnership = {
  sessions: Record<SessionId, SessionMeta>
  stage: TiledDispatchState
  droppedSessionIds: SessionId[]
}

// WHY this module exists — and why TWO sets, not one:
//
// The `sessions` map is metadata. A row being PRESENT has never been allowed
// to mean "this session belongs to the workspace", because the inverse
// conflation was a production incident twice over:
//
//   - Orphan metadata getting respawned into invisible backend processes and
//     proxies during startup (the original OOM bug).
//   - The first fix collapsing everything into one `owned` set used for BOTH
//     persistence pruning AND the boot spawn list. Every session the user had
//     parked then got a full claude/codex process plus mitmdump on every
//     restart. After weeks of "park this agent for later" the pool grew to 40+
//     and each launch spawned the whole herd in parallel (#258: 49 persisted,
//     9 visible, 40 parked -> 40 claude + 40 mitmdump, loadavg 906).
//
// Before #992 ownership was STRUCTURAL: a session was owned because a tile
// leaf, a `detachedSessions` record or a `buried` record named it. Those
// structures are gone. Ownership is now one fact on the row itself:
//
//   a session is OWNED  <=>  its `projectId` names a project that exists.
//
// That is the same rule v2 applied to a detached record ("a missing parent
// means there is no surface from which the agent can be found or managed —
// drop that closed ownership island as one unit"), restated for the pool. A
// row whose project is gone is a ghost; a row with no `projectId` at all was
// never filed (a spawn whose caller bailed out). Neither may become durable,
// and neither may EVER be spawned.
//
// The two sets are still two questions:
//
//   collectOwnedSessionIds  -> metadata-preservation set. Which rows survive
//                              a save and a load. Parked agents are durable
//                              user state; losing them loses the
//                              cwd/providerSessionId needed to wake one later.
//
//   collectLiveProcessIds   -> boot-spawn set. Which sessions must have a
//                              backend the moment the window paints.
//
// Lane selections, pins and the active project are POINTERS, not ownership. A
// stale pointer must never keep a session alive or bring one back.

/**
 * The metadata-preservation set: every session whose `projectId` names a
 * project that exists (and which actually has metadata — see hasSessionMeta).
 */
export function collectOwnedSessionIds(input: SessionOwnershipInput): Set<SessionId> {
  const projectIds = new Set<TabId>(input.tabs.map(tab => tab.id))
  const owned = new Set<SessionId>()
  for (const id of Object.keys(input.sessions)) {
    if (!hasSessionMeta(input.sessions, id)) continue
    const projectId = input.sessions[id]!.projectId
    if (projectId !== undefined && projectIds.has(projectId)) owned.add(id)
  }
  return owned
}

/**
 * The boot-spawn set: the FOCUSED lane's occupant, and nothing else.
 *
 * WHY so narrow. The question this answers is "which sessions must have a
 * backend before the user can do anything?", and on a stage the honest answer
 * is the one under the cursor. Every other session — shown in a lane or not —
 * already has a complete wake path that does not need boot's help:
 *
 *   - an agent leaf renders its committed transcript with no backend at all,
 *     and wakes on its first send (TileLeaf.send -> ensureSessionLive, the
 *     #691 fix for a parked lane rejecting its first prompt);
 *   - a terminal leaf wakes its shell when it mounts;
 *   - placing a parked session in a lane wakes it first (#690).
 *
 * v2 spawned every TILE LEAF at boot, and the recorded real workspace shows
 * what that had become: 3 one-pane tabs spawned 3 agents that no lane showed,
 * while the 12 lanes the user actually worked in all booted parked and woke on
 * first send. So "wake on first use" is not a new risk being introduced here;
 * it is the path the product's only heavy user already exercised for every
 * agent they touched. Spawning ALL lane occupants instead would be bounded by
 * the 16-lane cap rather than unbounded like #258 — but 16 agent processes
 * and 16 proxies in one Promise.all is the same incident at 40% scale, to
 * save a wake the user already pays today.
 *
 * This set is ALSO the denominator of rehydrate's restore-completion gate
 * (`expectedSessions`), so it must stay a subset of `keys(sessions)`: a lane
 * naming a session with no metadata contributes nothing (there is no cwd or
 * kind to spawn), or the gate could never be satisfied and autosave — the
 * file's only writer — would stay locked forever. That exact shape froze a
 * real workspace for three weeks under v2.
 *
 * If you add a session kind that must NOT spawn a process, narrow it HERE.
 * Narrowing `collectOwnedSessionIds` instead would drop its metadata on the
 * next save.
 */
export function collectLiveProcessIds(
  input: SessionOwnershipInput & { stage: TiledDispatchState },
): Set<SessionId> {
  const live = new Set<SessionId>()
  const focused = input.stage.lanes[input.stage.focusedLane]?.selectedSessionId
  if (focused === undefined) return live
  if (!collectOwnedSessionIds(input).has(focused)) return live
  // Extension views have NO backing process (no PTY, no agent). Their pane is
  // reconstructed purely from SessionMeta.extensionViewId; recovering one
  // would fall through SessionManager's provider switch into the
  // terminal-spawn branch and start a stray shell.
  if (input.sessions[focused]?.kind === 'extension-view') return live
  live.add(focused)
  return live
}

export function collectUnownedSessionIds(input: SessionOwnershipInput): SessionId[] {
  const owned = collectOwnedSessionIds(input)
  return Object.keys(input.sessions).filter(id => !owned.has(id))
}

export function pickOwnedSessions(
  sessions: Record<SessionId, SessionMeta>,
  ownedIds: Set<SessionId>,
): Record<SessionId, SessionMeta> {
  const out: Record<SessionId, SessionMeta> = {}
  for (const [id, meta] of Object.entries(sessions)) {
    if (ownedIds.has(id)) out[id] = meta
  }
  return out
}

/**
 * What autosave may make durable: owned rows, and a stage whose every pointer
 * resolves inside them.
 *
 * WHY autosave prunes instead of faithfully serializing runtime state: it is
 * the durability boundary. If an action leaves an unowned row in
 * `state.sessions`, writing it turns a transient invariant violation into a
 * permanent one. Pruning here is the last line of defense, and it closes the
 * model under restore: nothing this returns points at something it does not
 * also contain.
 *
 * (`repairPersistedTabs` lived below until #992. It rewrote tile TREES before
 * serialization, because a tree leaf was itself an owner and an orphan leaf
 * could therefore never be pruned away — it had to be cut out of the tree.
 * With ownership on the row, an orphan is just an unowned row and the
 * ordinary prune drops it; there is no structure left to repair.)
 */
export function pruneSessionOwnership(
  // WHY `stage` is required here although ownership never reads it: the stage
  // is a POINTER surface, not an owner (U2 — lanes are space, the pool is the
  // home). It has to be scrubbed against the same live ids in the same pass,
  // or the file can name a session in a lane that the same file no longer
  // contains. Required rather than optional because the live state always has
  // one and an optional field would let a caller silently skip the scrub.
  input: SessionOwnershipInput & { stage: TiledDispatchState },
): PrunedSessionOwnership {
  const ownedIds = collectOwnedSessionIds(input)
  const sessions = pickOwnedSessions(input.sessions, ownedIds)
  const liveIds = new Set(Object.keys(sessions))
  const droppedSessionIds = Object.keys(input.sessions).filter(id => !liveIds.has(id))
  const stage = scrubGridRowMetadata(
    // Kill/close paths already clear lanes, but corrupt or hand-edited state
    // can reach this guard directly. An unscrubbed lane keeps pointing at a
    // pruned session and forces rehydrate to repair stale state on every
    // launch. The focused LANE is an index, not a session pointer, so it
    // needs no liveness check.
    keepTiledLaneSessions(input.stage, liveIds),
    // Rows also name PROJECTS and a set of expanded parent sessions. A binding
    // to a closed project filters that row's index to nothing with no UI path
    // back (the picker only lists projects that exist), so it is scrubbed at
    // the same durability boundary as every other pointer.
    new Set(input.tabs.map(tab => tab.id)),
    liveIds,
  )
  return { sessions, stage, droppedSessionIds }
}
