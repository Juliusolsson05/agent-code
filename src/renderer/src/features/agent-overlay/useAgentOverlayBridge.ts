import { useCallback, useEffect, useRef } from 'react'

import type {
  AgentOverlaySnapshot,
  OverlayAgentRow,
} from '@shared/types/agentOverlay'
import type { Settings } from '@renderer/app-state/settings/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchActivity } from '@renderer/workspace/dispatch/dispatchActivity'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'

// Main-window half of the floating agent-status overlay: the reporter.
//
// This hook is WHY the overlay renderer can stay a dumb display — it runs
// where all the derivation already lives (workspace rows, session
// runtimes, condition selectors) and publishes a precomputed snapshot to
// main, which caches and forwards it to the overlay window. See
// shared/types/agentOverlay.ts for the full architecture note.
//
// Mounted exactly once from App.tsx, alongside the other cross-cutting
// sync hooks (theme, caffeinate, dictation).

// Trailing throttle for reports. process-state / conditions events can
// burst (every tool call flips them), and each report is a full-snapshot
// IPC send. 200ms keeps the overlay comfortably "live" for a glance
// surface while coalescing bursts; the timer reads the LATEST inputs from
// a ref, so nothing that changes inside the window is lost.
const REPORT_THROTTLE_MS = 200

function buildSnapshot(
  state: WorkspaceState,
  runtimes: Record<string, SessionRuntime>,
  settings: Settings,
): AgentOverlaySnapshot {
  // buildVisibleDispatchRows is the same selector the Dispatch list
  // renders from, so the overlay inherits its ordering contract for free:
  // pinned agents first, then project groups in tab order — and its
  // dedupe/orphan handling. Terminals are excluded: they have no
  // meaningful activity lifecycle for a "which agents need me?" glance.
  const rows = buildVisibleDispatchRows(state)
  const seen = new Set<string>()
  const agents: OverlayAgentRow[] = []
  for (const row of rows) {
    if (row.kind === 'terminal') continue
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    const runtime = runtimes[row.sessionId]
    const activity = dispatchActivity(runtime ?? {})
    const attentionLabel = dispatchAttentionLabelFromConditions(runtime?.conditions ?? null)
    const isActive = activity === 'working' || activity === 'running'
    agents.push({
      sessionId: row.sessionId,
      title: row.title,
      projectTitle: row.tabTitle,
      pinned: row.key.startsWith('pinned:'),
      activity,
      attentionLabel,
      // activityStatus is a "latest verb" cache — it can retain "running
      // Bash" long after the provider went idle. Only forward it while the
      // agent is actually active, or the overlay would show stale verbs on
      // idle rows.
      statusText: isActive ? (runtime?.activityStatus ?? null) : null,
    })
  }
  return {
    agents,
    // Opaque pass-through: the overlay calls the same applyTheme() with
    // this object. See the shared type for the byte-mover contract.
    theme: settings as unknown as Record<string, unknown>,
  }
}

export function useAgentOverlayBridge(workspace: Workspace): void {
  const runtimes = useAppStore(state => state.workspaceRuntimes)
  const settings = useAppStore(state => state.settings)

  // enabled lives in a ref, not state: it only gates the report path, and
  // a toggle must not re-render the whole App tree this hook mounts under.
  const enabledRef = useRef(false)
  const lastSentJsonRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputsRef = useRef({ state: workspace.state, runtimes, settings })
  inputsRef.current = { state: workspace.state, runtimes, settings }
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const scheduleReport = useCallback(() => {
    if (!enabledRef.current) return
    if (timerRef.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!enabledRef.current) return
      const inputs = inputsRef.current
      const snapshot = buildSnapshot(inputs.state, inputs.runtimes, inputs.settings)
      // Dedupe on serialized content: most store churn (transcript entries,
      // screen frames) doesn't change the overlay-visible fields at all,
      // and skipping identical sends keeps the IPC channel quiet.
      const json = JSON.stringify(snapshot)
      if (json === lastSentJsonRef.current) return
      lastSentJsonRef.current = json
      window.api.agentOverlayReport(snapshot)
    }, REPORT_THROTTLE_MS)
  }, [])

  useEffect(() => {
    let alive = true
    // Pull + push for the enabled flag: the pull covers a renderer reload
    // while the overlay is already on; the push covers main's async state
    // restore finishing after this mount (initAgentOverlay broadcasts).
    void window.api.agentOverlayGetEnabled().then(enabled => {
      if (!alive) return
      enabledRef.current = enabled
      if (enabled) {
        lastSentJsonRef.current = null
        scheduleReport()
      }
    })
    const unsubscribe = window.api.onAgentOverlayEnabledChanged(({ enabled }) => {
      enabledRef.current = enabled
      if (enabled) {
        // Reset the dedupe so the freshly-shown overlay always gets a
        // snapshot, even if nothing changed since it was last on.
        lastSentJsonRef.current = null
        scheduleReport()
      }
    })
    return () => {
      alive = false
      unsubscribe()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [scheduleReport])

  // Overlay row click → focus that agent. Main already raised the app
  // window (see ipc/agentOverlay.ts); this resolves WHERE the session
  // lives — same tab+session focus call the Agent Activity modal uses.
  useEffect(() => {
    return window.api.onAgentOverlayFocusSession(({ sessionId }) => {
      const ws = workspaceRef.current
      const row = buildVisibleDispatchRows(ws.state).find(r => r.sessionId === sessionId)
      if (row) ws.focusSessionInTab(row.tabId, row.sessionId)
    })
  }, [])

  useEffect(() => {
    scheduleReport()
  }, [workspace.state, runtimes, settings, scheduleReport])
}
