import { useEffect } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { rehydrateWorkspace } from '@renderer/workspace/hook/persistence/rehydrate'

// Once-only mount effect.
//
// If there's persisted state, respawn every session in its saved
// cwd (minting fresh sessionIds because main process ids are
// ephemeral) and remap the tree to use the new ids. If there's no
// saved state, spawn one default session in the default cwd.
//
// The bootRef guard makes the effect safe under React 18 StrictMode
// (which intentionally runs mount effects twice in dev).

export function useBootstrap(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  newTab: (cwd: string) => Promise<unknown>,
  setBootstrapComplete: (complete: boolean) => void,
): void {
  useEffect(() => {
    if (refs.bootRef.current) return
    refs.bootRef.current = true
    void (async () => {
      try {
        const json = await window.api.loadWorkspace()
        if (!json) {
          // Fresh install — create one default tab.
          const cwd = await window.api.defaultCwd()
          try {
            await newTab(cwd)
          } catch (err) {
            console.warn('[workspace] initial session spawn failed:', err)
          }
          return
        }
        try {
          // Single-user dev app — no schema versioning. If the load
          // fails for any reason (corrupt JSON, unexpected shape,
          // spawn error during rehydrate) we fall through to the
          // catch below and start fresh. No migrations, no version
          // gates.
          const parsed = JSON.parse(json) as { workspace: PersistedWorkspace }
          await rehydrateWorkspace(
            parsed.workspace,
            refs,
            setState,
            setRuntimes,
            setTileTabs,
            newTab,
          )
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[workspace] load failed, starting fresh:', err)
          const cwd = await window.api.defaultCwd()
          try {
            await newTab(cwd)
          } catch (spawnErr) {
            console.warn('[workspace] fallback session spawn failed:', spawnErr)
          }
        }
      } catch (err) {
        console.warn('[workspace] bootstrap failed:', err)
      } finally {
        setBootstrapComplete(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
