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
import { reconcileStuckTranscriptLoads } from '@renderer/workspace/hook/actions/initialHistory'
import * as perf from '@renderer/performance/client'

// #283 auto-heal cadence. After rehydrate, panes whose committed-transcript
// load was dropped mid-flight sit at 'loading' with nothing driving them. We
// sweep a few times with growing spacing: the first pass gives a genuinely
// slow first load time to finish (the reconciler skips in-flight loads), and
// later passes catch panes that only became stuck once their dropped load
// settled. Detached timers (not awaited) so this never delays first paint.
const STUCK_TRANSCRIPT_HEAL_DELAYS_MS = [1500, 4000, 8000]

// Once-only mount effect.
//
// If there's persisted state, respawn every session in its saved
// cwd (minting fresh sessionIds because main process ids are
// ephemeral) and remap the tree to use the new ids. If there's no
// saved state, spawn one default session in the default cwd.
//
// The bootRef guard makes the effect safe under React 18 StrictMode
// (which intentionally runs mount effects twice in dev).

// Bootstrap outcomes that downstream UI cares about. Autosave is only
// allowed on `fresh` (nothing on disk to protect) and `complete-restore`
// (every session respawned). The two failure shapes — `partial-restore`
// and `persisted-fallback` — surface as a banner so the user knows their
// disk state is being protected and that "just keep working" silently
// loses anything they edit until the underlying spawn/proxy issue is
// fixed and the app is restarted.
export type WorkspaceRestoreStatus =
  | 'pending'
  | 'fresh'
  | 'complete-restore'
  | 'partial-restore'
  | 'persisted-fallback'
  | 'bootstrap-error'

export function useBootstrap(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  newTab: (cwd: string) => Promise<unknown>,
  setBootstrapComplete: (complete: boolean) => void,
  // Mirrors setBootstrapComplete in lifetime — set once at the end of
  // bootstrap to one of the WorkspaceRestoreStatus values. The composer
  // exposes the value on the Workspace return shape so a banner can
  // render the partial/fallback states without each call site needing
  // to recompute "is autosave actually running right now".
  setRestoreStatus: (status: WorkspaceRestoreStatus) => void,
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
      let canAutosaveBootState = false
      let finalStatus: WorkspaceRestoreStatus = 'bootstrap-error'
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
            canAutosaveBootState = refs.latestStateRef.current.tabs.length > 0
            finalStatus = 'fresh'
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
          const restoreResult = await perf.measure(
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
          canAutosaveBootState =
            restoreResult.complete && refs.latestStateRef.current.tabs.length > 0
          finalStatus = restoreResult.complete ? 'complete-restore' : 'partial-restore'

          // #283 auto-heal: re-drive any pane left stuck at 'loading' because
          // its transcript load was dropped during the rehydrate id churn.
          // Equivalent to the user manually reloading each stuck pane, done
          // automatically. Conservative — a no-op when nothing is stuck.
          for (const delayMs of STUCK_TRANSCRIPT_HEAL_DELAYS_MS) {
            setTimeout(() => {
              const healed = reconcileStuckTranscriptLoads({ refs, setRuntimes })
              if (healed > 0) {
                console.warn(
                  `[xcript-heal #283] re-drove ${healed} stuck pane(s) at +${delayMs}ms`,
                )
              }
            }, delayMs)
          }
          if (!restoreResult.complete) {
            // WHY partial rehydrate is treated as "view-only until fixed":
            //
            // Rehydrate commits useful partial UI as soon as each session
            // respawns so users are not staring at a blank app while one
            // provider/proxy is wedged. That incremental rendering is good for
            // diagnosis, but it is poisonous as a persistence source: saving a
            // partial layout permanently deletes every pane that failed to
            // respawn during this launch. The packaged app hit exactly that
            // case when proxy startup failed and autosave wrote a 7-session
            // subset over a 13-session workspace.
            //
            // Complete restore is the only moment where the in-memory model is
            // allowed to become authoritative for disk. Until then the previous
            // workspace.json is still the source of truth, and the user can
            // restart after fixing the underlying spawn/proxy problem.
            console.warn('[workspace] rehydrate incomplete; autosave remains disabled:', restoreResult)
          }
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
            finalStatus = 'persisted-fallback'
            // WHY this intentionally does NOT unlock autosave:
            //
            // We only reach this path after a persisted workspace existed but
            // could not be parsed or restored. A fallback tab is a recovery UI,
            // not the user's actual workspace. Saving it would replace the
            // previous file with a one-tab workspace and make a transient load
            // failure durable. Fresh installs unlock autosave above because
            // there is no previous disk state to protect; persisted-workspace
            // fallback must leave disk untouched.
          } catch (spawnErr) {
            console.warn('[workspace] fallback session spawn failed:', spawnErr)
          }
        }
      } catch (err) {
        bootstrapSpan.fail(err, { mode: 'bootstrap' })
        console.warn('[workspace] bootstrap failed:', err)
      } finally {
        // Autosave is deliberately locked behind "we have something real to
        // save", not merely "the bootstrap async function returned".
        //
        // Why this guard exists:
        //   A packaged-app launch can fail every session restore (for example
        //   when Proxy Streaming is enabled but mitmproxy cannot start in the
        //   GUI app environment). Before this guard, bootstrap caught the
        //   restore failure, tried a fallback fresh tab, caught that failure
        //   too, and still marked bootstrap complete in `finally`. That
        //   unlocked useAutoSave while Zustand still held the initial empty
        //   workspace (`tabs: []`), overwriting the user's real
        //   ~/.config/agent-code/workspace.json with an empty file.
        //
        // We would rather leave the previous disk state untouched and show a
        // broken in-memory launch than make a transient startup failure
        // durable. Once at least one tab exists, autosave can resume normally.
        if (canAutosaveBootState) {
          setBootstrapComplete(true)
        } else {
          console.warn('[workspace] bootstrap produced no tabs; autosave remains disabled')
        }
        // Publish the final outcome regardless of autosave state, so the
        // banner can distinguish "fresh install, autosave on" from "partial
        // restore, autosave intentionally off". Without this the renderer
        // would have to infer it from absent state.
        setRestoreStatus(finalStatus)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
