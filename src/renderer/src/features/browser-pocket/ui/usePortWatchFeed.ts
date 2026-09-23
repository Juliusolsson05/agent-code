import { useEffect, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { buildWatchPlan } from '../state/watchPlan'

/**
 * Tells main which lanes to scan for dev servers. Recomputed when the lanes,
 * Spotlight or pockets change — not on every runtime tick — and only sent when
 * the plan actually differs, so an agent streaming output never triggers IPC.
 * Feature off ⇒ an empty plan, which stops main's watcher entirely.
 */
export function usePortWatchFeed(workspace: Workspace, enabled: boolean): void {
  const spotlight = useAppStore(s => s.workspaceSpotlight?.focusedSessionId ?? null)
  const last = useRef('')
  useEffect(() => {
    const plan = enabled ? buildWatchPlan({ state: workspace.state, runtimes: workspace.runtimes, spotlightSessionId: spotlight }) : []
    const key = JSON.stringify(plan)
    if (key === last.current) return
    last.current = key
    void window.api.setPocketPortWatch({ sessions: plan })
  })
  // Terminal cwds move without any workspace-state change; re-check on a slow
  // clock instead of subscribing every lane to every runtime update.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const plan = buildWatchPlan({ state: workspace.state, runtimes: workspace.runtimes, spotlightSessionId: spotlight })
      const key = JSON.stringify(plan)
      if (key === last.current) return
      last.current = key
      void window.api.setPocketPortWatch({ sessions: plan })
    }, 5_000)
    return () => clearInterval(timer)
  }, [enabled, workspace, spotlight])
}
