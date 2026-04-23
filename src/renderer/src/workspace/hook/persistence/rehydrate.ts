import { emptyRuntime, type SessionRuntime, type TileTabsState } from '@renderer/workspace/workspaceState'
import type {
  BuriedPaneRecord,
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
  TileNode,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Remap a persisted tree by replacing every sessionId with a freshly
// spawned one (spawn happens as we walk). Returns the remapped tree
// plus the old→new id mapping.
//
// Resume semantics: if the persisted SessionMeta carries a
// `providerSessionId`, we pass it to the spawn call as
// `resumeSessionId` so claude boots with `--resume <uuid>` and the
// full conversation history — tool calls, transcript, queue state,
// the lot — comes back. The cc-shell SessionId we mint here is a
// fresh routing key; CC's own session UUID is the thing we care
// about preserving.
//
// The providerSessionId is ALSO threaded into freshSessions[newId]
// so the runtime meta after rehydrate matches pre-reload state and
// the next save cycle writes it straight back. Without this, the
// first save after a resume would drop providerSessionId and the
// NEXT reload would lose context again.
//
// Failure modes:
//   - File missing / corrupted → CC will exit with a non-zero code
//     shortly after spawn. Surfaces via the exit event as "exited"
//     in the pane status strip. Not retried automatically — the
//     user can close the pane and open a fresh one.
//   - File locked by another process (rare) → same as above.
//   - Spawn itself throws (IPC failure) → caught below and logged;
//     the pane is simply missing from the rehydrated tree.

export async function rehydrateWorkspace(
  persisted: PersistedWorkspace,
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  newTab: (cwd: string) => Promise<unknown>,
): Promise<void> {
  const idMap = new Map<SessionId, SessionId>()
  const freshSessions: Record<SessionId, SessionMeta> = {}

  const remapNode = (n: TileNode): TileNode => {
    if (n.type === 'leaf') {
      const mapped = idMap.get(n.sessionId)
      return mapped
        ? { type: 'leaf', sessionId: mapped }
        : n // shouldn't happen, but fall through rather than crash
    }
    return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
  }

  const sanitizeRemappedNode = (n: TileNode): TileNode | null => {
    if (n.type === 'leaf') {
      return freshSessions[n.sessionId] != null ? n : null
    }
    const a = sanitizeRemappedNode(n.a)
    const b = sanitizeRemappedNode(n.b)
    if (!a && !b) return null
    if (!a) return b
    if (!b) return a
    return { ...n, a, b }
  }

  const buildRemappedTabs = (): Tab[] =>
    persisted.tabs
      .map(t => {
        const remappedRoot = sanitizeRemappedNode(remapNode(t.root))
        if (!remappedRoot) return null
        const leaves = collectLeaves(remappedRoot)
        if (leaves.length === 0) return null
        const focused = idMap.get(t.focusedSessionId) ?? leaves[0]
        return {
          id: t.id,
          title: t.title,
          root: remappedRoot,
          focusedSessionId: focused,
        } satisfies Tab
      })
      .filter((t): t is Tab => t !== null)

  const buildRemappedBuried = (): BuriedPaneRecord[] =>
    (persisted.buried ?? [])
      .map(entry => {
        const mappedSessionId = idMap.get(entry.sessionId)
        if (!mappedSessionId) return null
        return {
          ...entry,
          id: mappedSessionId,
          sessionId: mappedSessionId,
          siblingLeafId: entry.siblingLeafId
            ? (idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId)
            : undefined,
        } satisfies BuriedPaneRecord
      })
      .filter((entry): entry is BuriedPaneRecord => entry !== null)

  const buildRemappedTileTabs = (tabs: Tab[]): TileTabsState | null => {
    const persistedTileTabs = persisted.tileTabs
    if (!persistedTileTabs) return null
    const validTabIds = persistedTileTabs.tabIds.filter(id =>
      tabs.some(tab => tab.id === id),
    )
    return sanitizeTileTabsState({
      ...persistedTileTabs,
      tabIds: validTabIds,
    })
  }

  const commitRehydratedState = (): boolean => {
    const newTabs = buildRemappedTabs()
    if (newTabs.length === 0) return false

    const restoredTileTabs = buildRemappedTileTabs(newTabs)
    const activeTabId = restoredTileTabs?.focusedTabId
      ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
      ?? newTabs[0].id

    setState({
      tabs: newTabs,
      activeTabId,
      sessions: { ...freshSessions },
      buried: buildRemappedBuried(),
    })
    setTileTabs(restoredTileTabs)
    // WHY commit runtimes incrementally during rehydrate:
    //
    // Boot used to await every respawn before publishing *any*
    // restored tabs. One slow / wedged session kept `tabs: []`, so
    // after restart the user only saw the `+` button even though
    // workspace.json contained a full layout. We now publish
    // whatever subset has already rehydrated so the shell surfaces
    // real tabs immediately and fills in the remaining panes as
    // their sessions come back.
    //
    // We still merge with prev because resume-side transcript
    // events can arrive synchronously inside `session.start()`
    // before spawnSession() resolves. Replacing the runtime object
    // here would clobber those early entries and make restored
    // panes open blank.
    setRuntimes(prev => {
      const out: Record<SessionId, SessionRuntime> = {}
      for (const [oldId, newId] of idMap.entries()) {
        const existing = prev[newId]
        const base = existing ?? emptyRuntime()
        const draft = persisted.drafts?.[oldId]
        out[newId] = {
          ...base,
          ...(draft && !base.draftInput ? { draftInput: draft } : {}),
          hasOlderHistory: Boolean(freshSessions[newId]?.providerSessionId),
        }
      }
      for (const id of Object.keys(freshSessions)) {
        if (out[id]) continue
        const existing = prev[id]
        out[id] = {
          ...(existing ?? emptyRuntime()),
          hasOlderHistory: Boolean(freshSessions[id]?.providerSessionId),
        }
      }
      return out
    })
    return true
  }

  // Spawn all sessions concurrently instead of serially. A single
  // slow respawn must not block the entire tab strip from coming
  // back.
  await Promise.all(
    Object.entries(persisted.sessions).map(async ([oldId, meta]) => {
      try {
        const kind: SessionKind = meta.kind ?? 'claude'
        // For terminal sessions with a persisted tmuxName, pass it
        // as recoverTmuxName so main re-attaches the alive tmux
        // session (or falls back to fresh spawn if it died). Agents
        // ignore recoverTmuxName at the main side; safe to omit.
        const { sessionId: newId, tmuxName: nextTmuxName } = await window.api.spawnSession({
          kind,
          cwd: meta.cwd,
          resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
          dangerousMode: kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined,
          useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
          recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
        })
        idMap.set(oldId, newId)
        // Carry the full meta forward — kind + providerSessionId +
        // tmuxName — so the next save cycle doesn't drop these and
        // cause the session to degrade on the NEXT reload.
        // tmuxName is replaced with whatever main reported
        // (recovered name when alive, fresh name when respawned).
        freshSessions[newId] = {
          ...meta,
          ...(nextTmuxName ? { tmuxName: nextTmuxName } : {}),
        }
        commitRehydratedState()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
      }
    }),
  )

  if (!commitRehydratedState()) {
    const cwd = await window.api.defaultCwd()
    await newTab(cwd)
  }
}
