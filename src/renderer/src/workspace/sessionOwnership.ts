import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TileNode,
} from '@renderer/workspace/types'
import { clearTiledLaneSessions } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

type SessionOwnershipTab = {
  root: TileNode
}

export type SessionOwnershipInput = {
  tabs: SessionOwnershipTab[]
  sessions: Record<SessionId, SessionMeta>
  detachedSessions?: Record<SessionId, DetachedSessionRecord>
  buried?: BuriedPaneRecord[]
}

export type PrunedSessionOwnership = {
  sessions: Record<SessionId, SessionMeta>
  detachedSessions: Record<SessionId, DetachedSessionRecord>
  buried: BuriedPaneRecord[]
  dispatchMode: DispatchModeState | null | undefined
  droppedSessionIds: SessionId[]
}

// WHY this module exists — and why TWO ownership sets, not one:
//
// Workspace persistence has three independent ownership surfaces for a session:
// visible tile leaves, detached non-grid surfaces (dispatch parking), and
// buried panes. The `sessions` map is deliberately only metadata for those
// owners. Treating the map itself as authority creates a fourth hidden state:
// "metadata exists but no UI/surface owns it". The original OOM bug was the
// inverse direction of that same conflation: orphan metadata getting respawned
// into invisible backend processes/proxies during startup.
//
// The first fix collapsed everything into a single `owned` set and used it for
// BOTH persistence pruning AND rehydrate spawn filtering. That solved orphan
// metadata, but it also meant every detached session — which the user has
// explicitly removed from their visible workspace — got a full claude/codex
// process plus mitmdump on every restart. After weeks of "park this agent in
// dispatch for later", the detached pool grew to 40+ records and each app
// launch spawned the whole herd in parallel via rehydrate's Promise.all.
//
// The fix is to split the two concepts the previous code conflated:
//
//   collectOwnedSessionIds  → metadata-preservation set.
//                             Tile leaves + detached + buried.
//                             Used by `pruneSessionOwnership` to decide which
//                             rows in `sessions`, `detachedSessions`, and
//                             `buried` survive a save cycle. Detached and
//                             buried records are durable user state; losing
//                             them would lose the cwd/providerSessionId needed
//                             to revive a parked agent later.
//
//   collectLiveProcessIds   → rehydrate-spawn set.
//                             Tile leaves ONLY. The question this answers is
//                             "which sessions does the user currently see on
//                             screen, such that a backend process must exist
//                             for typing/scrolling/streaming to work?". A
//                             detached or buried session can be revived later
//                             by an explicit user action; until then it is
//                             metadata only and must NOT spawn a PTY, a
//                             mitmdump, an MCP host, or any other runtime
//                             resource.
//
// Dispatch focus is intentionally excluded from both sets. It is a selection
// pointer, not ownership; allowing it to keep a session alive would let a
// stale focus id resurrect work the user can no longer see or manage.
export function collectOwnedSessionIds(input: SessionOwnershipInput): Set<SessionId> {
  const owned = collectLiveProcessIds(input)

  for (const entry of Object.values(input.detachedSessions ?? {})) {
    owned.add(entry.sessionId)
  }

  for (const entry of input.buried ?? []) {
    owned.add(entry.sessionId)
  }

  return owned
}

// WHY this is a separate set from `collectOwnedSessionIds`:
//
// See the module header. tl;dr: persistence wants to keep more than rehydrate
// wants to spawn. Tile leaves are the only sessions whose absence would
// produce a broken user-visible pane on startup; everything else is parked
// state that the user must opt back into.
export function collectLiveProcessIds(input: SessionOwnershipInput): Set<SessionId> {
  const live = new Set<SessionId>()
  for (const tab of input.tabs) {
    for (const id of collectLeaves(tab.root)) {
      live.add(id)
    }
  }
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

export function pruneSessionOwnership(
  input: SessionOwnershipInput & {
    dispatchMode?: DispatchModeState | null
  },
): PrunedSessionOwnership {
  const ownedIds = collectOwnedSessionIds(input)
  const sessions = pickOwnedSessions(input.sessions, ownedIds)
  const liveIds = new Set(Object.keys(sessions))

  // WHY filter owner records after filtering `sessions`:
  //
  // A corrupted workspace can fail both directions. The OOM bug came from
  // metadata without an owner, but the inverse is also possible after a failed
  // rehydrate or hand-edited workspace.json: an owner points at missing
  // metadata. Persisting that shape means the next load has to reason about a
  // pane whose cwd/kind no longer exists. Pruning owner records to ids that
  // survived in `sessions` keeps the serialized model closed under restore.
  //
  // Detached records are also normalized by session id while we are here. The
  // object key is a lookup convenience, not user data; keeping an old runtime
  // key around a remapped record makes later lifecycle actions target the wrong
  // entry.
  const detachedSessions: Record<SessionId, DetachedSessionRecord> = {}
  for (const entry of Object.values(input.detachedSessions ?? {})) {
    if (!liveIds.has(entry.sessionId)) continue
    const sessionId = entry.sessionId
    detachedSessions[sessionId] = {
      ...entry,
      sessionId,
    }
  }

  const buried = (input.buried ?? []).filter(entry => liveIds.has(entry.sessionId))
  const droppedSessionIds = Object.keys(input.sessions).filter(id => !liveIds.has(id))
  const droppedSet = new Set(droppedSessionIds)
  const focusedSessionId = input.dispatchMode?.focusedSessionId
  const laneScrubbedDispatchMode = input.dispatchMode
    ? clearTiledLaneSessions(input.dispatchMode, droppedSet)
    : input.dispatchMode
  const dispatchMode = input.dispatchMode
    ? {
        // WHY tiled lanes are scrubbed at the same durability boundary as
        // focusedSessionId: autosave must serialize a model closed under
        // restore. Kill/close paths already clear lanes, but corrupt or
        // hand-edited workspace state can reach this persistence guard directly.
        // If we only scrub classic focus, a tiled lane can keep pointing at a
        // pruned session and force rehydrate/auto-fill to repair stale state on
        // every launch.
        ...(laneScrubbedDispatchMode ?? input.dispatchMode),
        focusedSessionId: focusedSessionId && liveIds.has(focusedSessionId)
          ? focusedSessionId
          : undefined,
      }
    : input.dispatchMode

  return {
    sessions,
    detachedSessions,
    buried,
    dispatchMode,
    droppedSessionIds,
  }
}
