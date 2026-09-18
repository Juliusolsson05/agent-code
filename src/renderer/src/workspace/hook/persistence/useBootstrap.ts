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
// load was dropped mid-flight sit stuck (spinner or empty feed) with nothing
// driving them. We sweep a few times with growing spacing: the first pass
// gives a genuinely slow first load time to finish (the reconciler skips
// in-flight loads), and later passes catch panes that only became stuck once
// their dropped load settled. Detached timers (not awaited) so this never
// delays first paint.
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
  // WHY these params: the "Default Workspace Mode" setting only mattered on
  // a brand-new install (no workspace.json), choosing between grid and
  // Dispatch. With the unified layout (#992) there is nothing to choose:
  // every workspace boots onto the stage. The setting param stays (removing
  // it drags the Settings UI into this stage) but is deliberately unread
  // now; stage-8 cleanup deletes setting and param together.
  defaultWorkspaceMode: WorkspaceModeId,
  _enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>,
  // Stage guarantee (#992): bootstrap seeds a STORED tiled grid when the
  // workspace has none, so every lane action (select/insert/remove/weights)
  // finds a grid to write into on its very first keystroke. The derived
  // default (workspaceStage.ts) covers rendering pre-seed; this makes the
  // stored state catch up so writes never race the derivation.
  enterTiledDispatch: (rowLengths: number[]) => Promise<void>,
): void {
  useEffect(() => {
    if (refs.bootRef.current) return
    refs.bootRef.current = true
    const ensureStage = async (rowLengths: number[]): Promise<void> => {
      if (refs.latestStateRef.current.dispatchMode?.tiled != null) return
      try {
        // enterTiledDispatch applies the #977 entry seed — lane 0 seeded
        // with the focused session, including wake-before-place for a
        // hibernated detached seed.
        await enterTiledDispatch(rowLengths)
      } catch (error) {
        // Non-fatal: rendering already works against the derived default;
        // the first lane write will surface any real failure where the
        // user can see it. Same philosophy as the old fresh-install
        // dispatch entry: no error toast before the user has seen the app.
        console.warn('[workspace] stage seeding failed:', error)
      }
    }
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
            // The stage is the workspace (#992): a fresh install lands on
            // ONE row × ONE lane (plan §4.5 — nothing to explain before the
            // first agent exists; growth is user-paced).
            await ensureStage([1])
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

          // #283 auto-heal: re-drive any pane left stuck (spinner or empty
          // feed) because its transcript load was dropped during rehydrate id
          // churn. Equivalent to the user manually reloading each stuck pane,
          // done automatically. Conservative — a no-op when nothing is stuck.
          for (const delayMs of STUCK_TRANSCRIPT_HEAL_DELAYS_MS) {
            setTimeout(() => {
              reconcileStuckTranscriptLoads({ refs, setRuntimes })
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
          // Imported v2 workspaces without a stored grid get the migration
          // default [2] (seeded) — NOT the fresh [1]: an importing user
          // demonstrably has agents; the second lane is what shows a lane
          // is a slot (plan §6.4).
          await ensureStage([2])
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
            // Recovery shell gets the minimal [1] stage — same reasoning as
            // the fresh path: this is not the user's real workspace, just
            // enough surface to work in while the real file stays protected.
            await ensureStage([1])
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
