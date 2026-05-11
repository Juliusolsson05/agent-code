import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TileNode,
} from '@renderer/workspace/types'
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

// WHY this helper exists:
//
// Workspace persistence has three independent ownership surfaces for a live
// session: visible tile leaves, detached non-grid surfaces, and buried panes.
// The `sessions` map is deliberately only metadata for those owners. Treating
// the map itself as authority creates a fourth hidden state: "metadata exists
// but no UI/surface owns it". Startup and agent reload turn that hidden state
// into real backend processes, which is how stale Codex rows can respawn into
// dozens of invisible proxies and push Electron toward OOM.
//
// Keeping ownership collection centralized makes every persistence/reload path
// answer the same question the same way: "what session ids are allowed to stay
// live?" Dispatch focus is intentionally excluded. It is a selection pointer,
// not ownership; allowing it to keep a session alive would let a stale focus id
// resurrect work the user can no longer see or manage.
export function collectOwnedSessionIds(input: SessionOwnershipInput): Set<SessionId> {
  const owned = new Set<SessionId>()

  for (const tab of input.tabs) {
    for (const id of collectLeaves(tab.root)) {
      owned.add(id)
    }
  }

  for (const entry of Object.values(input.detachedSessions ?? {})) {
    owned.add(entry.sessionId)
  }

  for (const entry of input.buried ?? []) {
    owned.add(entry.sessionId)
  }

  return owned
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
  const focusedSessionId = input.dispatchMode?.focusedSessionId
  const dispatchMode = input.dispatchMode
    ? {
        ...input.dispatchMode,
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
    droppedSessionIds: Object.keys(input.sessions).filter(id => !liveIds.has(id)),
  }
}
