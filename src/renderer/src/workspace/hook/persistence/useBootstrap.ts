import { useEffect } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceModeId } from '@renderer/app-state/settings/types'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { DispatchModeState } from '@renderer/workspace/types'

import { rehydrateWorkspace } from '@renderer/workspace/hook/persistence/rehydrate'
import * as perf from '@renderer/performance/client'

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
  // WHY these two extra params: the "Default Workspace Mode" setting
  // only matters on a brand-new install (no workspace.json). Rather
  // than have useBootstrap reach into the app store directly — which
  // would couple persistence to settings and add a re-render dep we
  // don't want — the composer (`useWorkspace`) reads the setting once
  // and threads it in alongside the dispatch entry point. We capture
  // both in the once-only useEffect closure, so later setting changes
  // don't retroactively rerun bootstrap.
  defaultWorkspaceMode: WorkspaceModeId,
  enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>,
): void {
  useEffect(() => {
    if (refs.bootRef.current) return
    refs.bootRef.current = true
    void (async () => {
      const bootstrapSpan = perf.span('workspace.bootstrap')
      try {
        const json = await perf.measure('workspace.bootstrap.loadWorkspace', () =>
          window.api.loadWorkspace(),
        )
        if (!json) {
          // Fresh install — create one default tab.
          const cwd = await perf.measure('workspace.bootstrap.defaultCwd', () =>
            window.api.defaultCwd(),
          )
          try {
            await perf.measure('workspace.bootstrap.initialNewTab', () => newTab(cwd))
            // WHY apply the default mode here, after newTab resolves:
            //
            // `enterDispatchMode` triggers `ensureDispatchTerminal`, which
            // looks up the active tab via `refs.stateRef.current.activeTabId`
            // and inserts a terminal leaf into that tab's tree. If we called
            // it before newTab finished, there'd be no tab yet → no terminal
            // gets attached → the spawned PTY leaks. Sequencing it after
            // newTab guarantees a tab+focused session exist.
            //
            // We deliberately do NOT touch the rehydrate path: existing
            // workspaces already have `dispatchMode: null` (or a real value)
            // persisted, so honoring the persisted value is what users
            // expect. This setting is "first launch only" by design.
            if (defaultWorkspaceMode === 'dispatch') {
              try {
                await enterDispatchMode('project')
              } catch (dispatchErr) {
                // Non-fatal: user lands in grid mode, can flip later.
                // We don't surface a toast because a fresh-install user
                // hasn't even seen the workspace yet — a stray error
                // toast on an empty app is more confusing than helpful.
                console.warn('[workspace] default dispatch entry failed:', dispatchErr)
              }
            }
            bootstrapSpan.end({ mode: 'fresh' })
          } catch (err) {
            bootstrapSpan.fail(err, { mode: 'fresh' })
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
          await perf.measure(
            'workspace.bootstrap.rehydrate',
            () =>
              rehydrateWorkspace(
                parsed.workspace,
                refs,
                setState,
                setRuntimes,
                setTileTabs,
                newTab,
              ),
            {
              tabs: parsed.workspace.tabs.length,
              sessions: Object.keys(parsed.workspace.sessions).length,
            },
          )
          bootstrapSpan.end({ mode: 'rehydrate' })
        } catch (err) {
          bootstrapSpan.fail(err, { mode: 'rehydrate' })
          // eslint-disable-next-line no-console
          console.warn('[workspace] load failed, starting fresh:', err)
          const cwd = await perf.measure('workspace.bootstrap.fallbackDefaultCwd', () =>
            window.api.defaultCwd(),
          )
          try {
            await perf.measure('workspace.bootstrap.fallbackNewTab', () => newTab(cwd))
          } catch (spawnErr) {
            console.warn('[workspace] fallback session spawn failed:', spawnErr)
          }
        }
      } catch (err) {
        bootstrapSpan.fail(err, { mode: 'bootstrap' })
        console.warn('[workspace] bootstrap failed:', err)
      } finally {
        setBootstrapComplete(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
