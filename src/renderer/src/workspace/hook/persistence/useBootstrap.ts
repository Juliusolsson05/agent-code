import { useEffect } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import type { SessionKind } from '@renderer/workspace/types'
import type { SetupCheckResult } from '@shared/types/setup'
import { awaitFirstRunDecision, ensureSetupCheck } from '@renderer/features/setup/store'
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
  newTab: (cwd: string, resumeSessionId?: string, kind?: SessionKind) => Promise<unknown>,
  setBootstrapComplete: (complete: boolean) => void,
  // Mirrors setBootstrapComplete in lifetime — set once at the end of
  // bootstrap to one of the WorkspaceRestoreStatus values. The composer
  // exposes the value on the Workspace return shape so a banner can
  // render the partial/fallback states without each call site needing
  // to recompute "is autosave actually running right now".
  setRestoreStatus: (status: WorkspaceRestoreStatus) => void,
  // `defaultWorkspaceMode` was a param here until #992 stage 8: the
  // "Default Workspace Mode" setting chose between grid and Dispatch on a
  // fresh install, and there is one layout now. Deleted with the setting.
  // Two more params lived here until the stage became a required field:
  // `enterDispatchMode` (fresh installs could boot into classic Dispatch) and
  // `enterTiledDispatch`, which an `ensureStage` helper called after every
  // boot path to give a workspace a lane grid if it lacked one. Neither is
  // needed: the store's initial state already holds a one-lane stage, newTab
  // fills its empty focused lane with the first agent, and rehydrate
  // publishes the migrated stage in its very first commit. Boot no longer
  // knows that lanes exist.
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
          // #995: wait for the setup verdict before choosing what to spawn.
          // This returns at once when any provider is usable; with none, it
          // waits for the user to answer the setup panel (see
          // awaitFirstRunDecision for why spawning underneath it was wrong).
          const setup = await perf.measure('workspace.bootstrap.firstRunDecision', () =>
            awaitFirstRunDecision(),
          )
          try {
            await perf.measure('workspace.bootstrap.initialNewTab', () => openFirstProject(newTab, cwd, setup))
            canAutosaveBootState = refs.latestStateRef.current.tabs.length > 0
            finalStatus = 'fresh'
            // A fresh install lands on ONE row × ONE lane showing its one
            // agent (plan §4.5 — nothing to explain before the first agent
            // exists; growth is user-paced). That shape is the store's
            // initial `freshStage()` plus newTab's empty-lane placement; no
            // step here creates it.
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
                newTab,
              ),
            {
              // v3 files list `projects`; v2 files list `tabs`.
              tabs: (parsed.workspace.projects ?? parsed.workspace.tabs ?? []).length,
              // `?? {}`: a telemetry attribute must not be what throws a
              // restorable workspace into the recovery shell (#1245).
              sessions: Object.keys(parsed.workspace.sessions ?? {}).length,
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
          // An imported v2 workspace without a stored lane grid arrives here
          // already on the migration default [2] (seeded) — NOT the fresh
          // [1]: an importing user demonstrably has agents; the second lane
          // is what shows a lane is a slot (plan §6.4). rehydrate published
          // it through migrateWorkspaceToStage.
          bootstrapSpan.end({ mode: 'rehydrate' })
        } catch (err) {
          bootstrapSpan.fail(err, { mode: 'rehydrate' })
          // eslint-disable-next-line no-console
          console.warn('[workspace] load failed, starting fresh:', err)
          const cwd = await perf.measure('workspace.bootstrap.fallbackDefaultCwd', () =>
            window.api.defaultCwd(),
          )
          try {
            // The recovery shell must come up on a machine without the
            // default provider too, so it follows the same readiness verdict.
            // It does not WAIT for the setup panel: a returning user with a
            // broken file needs a surface now, not a first-run question.
            const setup = await ensureSetupCheck()
            await perf.measure('workspace.bootstrap.fallbackNewTab', () => openFirstProject(newTab, cwd, setup))
            finalStatus = 'persisted-fallback'
            // The recovery shell gets the minimal [1] stage by the same route
            // as the fresh path: this is not the user's real workspace, just
            // enough surface to work in while the real file stays protected.
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

/**
 * Opens the first project of a run that has nothing to restore (#995).
 *
 * WHY a terminal is the last resort, after the chosen kind fails: a run with
 * no tabs is the worst outcome bootstrap can produce. It keeps autosave off
 * for the whole run (the no-tabs guard above), and the user faces an empty
 * window with nothing to type into. That is what a clean Mac got before
 * #995: Claude was spawned unconditionally, failed because it was not
 * installed, and left nothing. A terminal needs no provider, and it is where
 * the user runs the install commands the setup panel shows.
 *
 * `setup` null (the check itself failed) keeps the pre-#995 choice, the
 * default provider: an unknown machine is not an empty one.
 */
async function openFirstProject(
  newTab: (cwd: string, resumeSessionId?: string, kind?: SessionKind) => Promise<unknown>,
  cwd: string,
  setup: SetupCheckResult | null,
): Promise<void> {
  const kind = setup?.firstSessionKind
  try {
    await newTab(cwd, undefined, kind)
  } catch (err) {
    if (kind === 'terminal') throw err
    console.warn('[workspace] first project spawn failed; opening a terminal instead:', err)
    await newTab(cwd, undefined, 'terminal')
  }
}
