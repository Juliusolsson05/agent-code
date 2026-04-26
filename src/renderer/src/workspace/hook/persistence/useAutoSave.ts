import { useCallback, useEffect } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

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
    // Collect non-empty drafts so in-progress prompts survive crashes.
    const drafts: Record<SessionId, string> = {}
    for (const [id, rt] of Object.entries(refs.latestRuntimesRef.current)) {
      if (rt.draftInput) drafts[id] = rt.draftInput
    }
    const persisted: PersistedWorkspace = {
      tabs: s.tabs.map(t => ({
        id: t.id,
        title: t.title,
        focusedSessionId: t.focusedSessionId,
        root: t.root,
      })),
      activeTabId: s.activeTabId,
      dispatchMode: s.dispatchMode,
      sessions: s.sessions,
      buried: s.buried,
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
