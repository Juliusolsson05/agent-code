import { useCallback, useEffect } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { pruneSessionOwnership } from '@renderer/workspace/sessionOwnership'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'

// Debounced workspace-save + beforeunload flush.
//
// The save is extracted into a stable helper so it can be called
// both from the debounce timer AND from the beforeunload flush. We
// keep a ref to the latest state so the beforeunload handler (which
// can't close over React state) always serializes the freshest
// version.
//
// The debounced save has a 400ms window where a mutation hasn't
// been written yet. If the user quits the app during that window,
// the latest state is lost — tabs vanish, sessions can't resume.
//
// Fix: listen for `beforeunload` (fires synchronously before the
// renderer is torn down) and flush immediately. The IPC invoke is
// async but Electron's main process receives the message before the
// window actually closes — the write lands. Same pattern VS Code
// uses for its workspace state.
//
// Autosave is intentionally disabled until bootstrap finishes. The
// hook mounts before persisted sessions are respawned, and saving the
// initial empty Zustand state during that window can overwrite a real
// workspace.json with `tabs: []` or a partially restored layout.

export function useAutoSave(
  state: WorkspaceState,
  draftVersion: number,
  refs: WorkspaceRefs,
  bootstrapComplete: boolean,
): void {
  const flushSave = useCallback(() => {
    const saveSpan = perf.span('workspace.autosave.flush')
    const s = refs.latestStateRef.current
    const pruned = pruneSessionOwnership(s)
    if (pruned.droppedSessionIds.length > 0) {
      // WHY autosave prunes instead of faithfully serializing runtime state:
      //
      // Autosave is the durability boundary. If an action accidentally leaves
      // an unowned row in `state.sessions`, writing it to workspace.json turns a
      // transient invariant violation into a startup respawn on every future
      // launch. Pruning here is the last line of defense: owned hidden sessions
      // (detached/buried) still persist, but metadata with no owner cannot make
      // itself durable.
      // eslint-disable-next-line no-console
      console.warn('[workspace] dropping unowned sessions during autosave:', pruned.droppedSessionIds)
    }
    // Collect non-empty drafts so in-progress prompts survive crashes.
    const drafts: Record<SessionId, string> = {}
    for (const [id, rt] of Object.entries(refs.latestRuntimesRef.current)) {
      if (pruned.sessions[id] && rt.draftInput) drafts[id] = rt.draftInput
    }
    // Filter pins against the pruned `sessions` map so a stale entry
    // (kill-races, hand-edited workspace.json, mid-rehydrate
    // inconsistency) cannot make itself durable. Same "autosave is
    // the last line of defense" reasoning as the
    // pruneSessionOwnership call above — better to lose a pin than
    // to boot the next launch with a phantom row that points at
    // nothing.
    const persistedPinnedSessionIds = s.pinnedSessionIds.filter(
      id => pruned.sessions[id] !== undefined,
    )
    const persisted: PersistedWorkspace = {
      tabs: s.tabs.map(t => ({
        id: t.id,
        title: t.title,
        focusedSessionId: t.focusedSessionId,
        root: t.root,
      })),
      activeTabId: s.activeTabId,
      dispatchMode: pruned.dispatchMode,
      sessions: pruned.sessions,
      detachedSessions: pruned.detachedSessions,
      buried: pruned.buried,
      pinnedSessionIds: persistedPinnedSessionIds.length > 0
        ? persistedPinnedSessionIds
        : undefined,
      tileTabs: refs.latestTileTabsRef.current,
      drafts: Object.keys(drafts).length > 0 ? drafts : undefined,
    }
    let json = ''
    try {
      json = JSON.stringify({ workspace: persisted }, null, 2)
    } catch (err) {
      saveSpan.fail(err)
      throw err
    }
    void window.api.saveWorkspace(json)
      .then(() => {
        saveSpan.end({
          tabs: persisted.tabs.length,
          sessions: Object.keys(persisted.sessions).length,
          tileTabs: persisted.tileTabs?.tabIds.length ?? 0,
          bytes: json.length,
        })
      })
      .catch(err => {
        saveSpan.fail(err, { bytes: json.length })
        // eslint-disable-next-line no-console
        console.warn('[workspace] save failed:', err)
      })
  }, [refs.latestRuntimesRef, refs.latestStateRef, refs.latestTileTabsRef])

  useEffect(() => {
    if (!bootstrapComplete) return
    if (refs.saveTimerRef.current) clearTimeout(refs.saveTimerRef.current)
    refs.saveTimerRef.current = setTimeout(flushSave, 400)
    return () => {
      if (refs.saveTimerRef.current) clearTimeout(refs.saveTimerRef.current)
    }
  }, [state, draftVersion, flushSave, refs.saveTimerRef, bootstrapComplete])

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!bootstrapComplete) return
      // Cancel the debounced timer so we don't double-save.
      if (refs.saveTimerRef.current) {
        clearTimeout(refs.saveTimerRef.current)
        refs.saveTimerRef.current = null
      }
      flushSave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushSave, refs.saveTimerRef, bootstrapComplete])
}
