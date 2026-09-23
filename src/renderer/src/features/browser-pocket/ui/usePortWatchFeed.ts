import { useCallback, useEffect, useRef } from 'react'

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
  const latest = useRef({ workspace, spotlight, enabled })
  latest.current = { workspace, spotlight, enabled }
  const send = useCallback(() => {
    const { workspace: ws, spotlight: spot, enabled: on } = latest.current
    const plan = on ? buildWatchPlan({ state: ws.state, runtimes: ws.runtimes, spotlightSessionId: spot }) : []
    const key = JSON.stringify(plan)
    if (key === last.current) return
    last.current = key
    void window.api.setPocketPortWatch({ sessions: plan })
  }, [])
  // Lanes, Spotlight, pockets or the switch changed. NOT every render: the
  // host re-renders on every workspace change (review B #9).
  useEffect(send, [send, workspace.state.stage, workspace.state.sessions, spotlight, enabled])
  // Terminal cwds move without any workspace-state change; re-check on a slow
  // clock, reading the latest inputs through the ref so the interval is not
  // restarted by every render.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(send, 5_000)
    return () => clearInterval(timer)
  }, [enabled, send])
}
