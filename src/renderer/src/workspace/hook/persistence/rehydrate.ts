import { emptyRuntime, type SessionRuntime, type TileTabsState } from '@renderer/workspace/workspaceState'
import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
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
import * as perf from '@renderer/performance/client'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'

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
  perf.mark('workspace.rehydrate.start', {
    tabs: persisted.tabs.length,
    sessions: Object.keys(persisted.sessions).length,
    detachedSessions: Object.keys(persisted.detachedSessions ?? {}).length,
    buried: persisted.buried?.length ?? 0,
  })
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
      .flatMap(entry => {
        const mappedSessionId = idMap.get(entry.sessionId)
        if (!mappedSessionId) return []
        const remapped: BuriedPaneRecord = {
          ...entry,
          id: mappedSessionId,
          sessionId: mappedSessionId,
        }
        if (entry.siblingLeafId) {
          remapped.siblingLeafId = idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId
        }
        return [remapped]
      })

  const buildRemappedDetachedSessions = (): Record<SessionId, DetachedSessionRecord> => {
    const out: Record<SessionId, DetachedSessionRecord> = {}
    for (const entry of Object.values(persisted.detachedSessions ?? {})) {
      const mappedSessionId = idMap.get(entry.sessionId)
      if (!mappedSessionId) continue
      // WHY key by the fresh session id rather than trusting the persisted
      // object key: renderer SessionIds are per-launch routing ids. Rehydrate
      // respawns every process and remaps every old id, so a detached record's
      // identity has to follow the same old->new map as tile leaves and buried
      // records or later lifecycle actions would delete/update the wrong key.
      out[mappedSessionId] = {
        ...entry,
        sessionId: mappedSessionId,
      }
    }
    return out
  }

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

    setState(prev => {
      // Incremental rehydrate commits can keep arriving long after
      // the first visible tabs are usable. Do not treat persisted
      // activeTabId as authoritative after the first commit: the
      // user may already have navigated to another restored tab, and
      // the next slow session finishing should not bounce focus back
      // to the startup tab. Preserve the current active tab whenever
      // it still exists in the newly-remapped partial layout.
      const currentActiveTabStillExists = newTabs.some(t => t.id === prev.activeTabId)
      const activeTabId = currentActiveTabStillExists
        ? prev.activeTabId
        : restoredTileTabs?.focusedTabId
          ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
          ?? newTabs[0].id

      // dispatchMode.focusedSessionId is a SessionId that, like every
      // other persisted SessionId in the workspace (tab leaves, buried
      // records, detached records), needs to be remapped through the
      // idMap built by rehydrate. Without this remap the field carries
      // a pre-restart sessionId past restart, the dispatch UI silently
      // falls back to grid focus or first row, and any command that
      // targets dispatch focus operates on the wrong visible row.
      // Falling back to undefined when the old id failed to respawn
      // keeps the model honest — better to clear the focus than to
      // pretend a dead id is still selectable.
      const remappedDispatchMode = persisted.dispatchMode
        ? {
            ...persisted.dispatchMode,
            focusedSessionId: persisted.dispatchMode.focusedSessionId
              ? idMap.get(persisted.dispatchMode.focusedSessionId)
              : undefined,
          }
        : null

      return {
        tabs: newTabs,
        activeTabId,
        dispatchMode: remappedDispatchMode,
        sessions: { ...freshSessions },
        detachedSessions: buildRemappedDetachedSessions(),
        buried: buildRemappedBuried(),
      }
    })
    setTileTabs(prev => {
      if (!restoredTileTabs) return null
      if (!prev) return restoredTileTabs
      if (!restoredTileTabs.tabIds.includes(prev.focusedTabId)) {
        return restoredTileTabs
      }
      // Same invariant as activeTabId above, but for TileTabs'
      // internal focus. Rehydrate still owns the tab membership as
      // panes come online; the user's focused tiled tab survives
      // each later partial commit.
      return {
        ...restoredTileTabs,
        focusedTabId: prev.focusedTabId,
      }
    })
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
          transcriptStatus: base.transcriptStatus === 'ready' || base.transcriptStatus === 'error'
            ? base.transcriptStatus
            : freshSessions[newId]?.providerSessionId ? 'loading' : 'ready',
          transcriptError: base.transcriptError,
          // WHY preserve an already-observed lifecycle state:
          //
          // Provider start is not a quiet boundary. Codex resume can
          // replay transcript entries and emit process exit before
          // spawnSession() resolves back to this rehydrate loop. The
          // restored pane should inherit that real status; forcing
          // "started/inputReady" here makes dead resumed sessions look
          // alive until the user presses Enter and hits the backend
          // guard.
          processStatus: existing && existing.processStatus !== 'idle'
            ? existing.processStatus
            : 'started',
          processError: existing?.processError ?? null,
          inputReady: existing && existing.processStatus !== 'idle'
            ? existing.inputReady
            : true,
        }
      }
      for (const id of Object.keys(freshSessions)) {
        if (out[id]) continue
        const existing = prev[id]
        out[id] = {
          ...(existing ?? emptyRuntime()),
          hasOlderHistory: Boolean(freshSessions[id]?.providerSessionId),
          transcriptStatus:
            existing?.transcriptStatus === 'ready' || existing?.transcriptStatus === 'error'
              ? existing.transcriptStatus
              : freshSessions[id]?.providerSessionId ? 'loading' : 'ready',
          transcriptError: existing?.transcriptError ?? null,
          processStatus: existing && existing.processStatus !== 'idle'
            ? existing.processStatus
            : 'started',
          processError: existing?.processError ?? null,
          inputReady: existing && existing.processStatus !== 'idle'
            ? existing.inputReady
            : true,
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
      const restoreSpan = perf.span('workspace.rehydrate.session', {
        oldId,
        kind: meta.kind ?? 'claude',
        hasProviderSessionId: Boolean(meta.providerSessionId),
        hasTmuxName: Boolean(meta.tmuxName),
      })
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
        if (kind !== 'terminal' && freshSessions[newId].providerSessionId) {
          void loadInitialHistoryForSession({
            sessionId: newId,
            meta: freshSessions[newId],
            refs,
            setRuntimes,
          })
        }
        restoreSpan.end({ newId })
      } catch (err) {
        restoreSpan.fail(err)
        // eslint-disable-next-line no-console
        console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
      }
    }),
  )

  if (!commitRehydratedState()) {
    const cwd = await window.api.defaultCwd()
    await newTab(cwd)
  }
  perf.mark('workspace.rehydrate.complete', {
    restoredSessions: Object.keys(freshSessions).length,
  })
}
