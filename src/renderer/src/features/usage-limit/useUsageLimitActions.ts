import { useMemo, useRef } from 'react'
import type { UsageLimitActions } from '@providers/shared/renderer/protocols/usage-limit/model'
import type { UsageLimitNotice } from '@shared/types/usageLimitNotice'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'

/** Desktop actions belong to the card's pane, never whichever pane happens to
 * have keyboard focus. The expected run is captured when this action surface
 * renders, then checked again at activation against the imperative runtime.
 * A retained Codex error additionally names its producing run; a durable Claude
 * carrier names its native transcript. Neither may act on a replacement agent.
 * The existing picker still owns destination choice and switch eligibility. */
export function useUsageLimitActions(workspace: Workspace, sessionId: string, renderedRunId: string | null): UsageLimitActions {
  const latest = useRef(workspace)
  latest.current = workspace
  return useMemo(() => {
    const canSwitchProvider = (notice: UsageLimitNotice, noticeRunId?: string): boolean => {
      const host = latest.current
      const meta = host.state.sessions[sessionId]
      const runtime = host.getRuntime(sessionId)
      return !!meta && meta.kind === notice.provider && !!renderedRunId &&
        runtime.sessionRunId === renderedRunId && runtime.exited === null && !runtime.providerSwitch &&
        (!noticeRunId || noticeRunId === runtime.sessionRunId) &&
        (!notice.providerSessionId || notice.providerSessionId === meta.providerSessionId)
    }
    return {
      canSwitchProvider,
      // Explicit open, not the usage.open command (which toggles an already
      // open modal closed). Repeated activation has one predictable outcome.
      openUsage: () => useAppStore.getState().openUsageModal(),
      switchProvider: (notice, noticeRunId) => {
        if (!canSwitchProvider(notice, noticeRunId)) {
          latest.current.showPaneToast(sessionId, 'This usage notice belongs to an unavailable or replaced agent.')
          return
        }
        useAppStore.getState().openProviderSwitchPicker(sessionId)
      },
    }
  }, [sessionId, renderedRunId])
}
