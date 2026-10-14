import { useEffect, useState } from 'react'

import type { SessionMoveTarget } from '@shared/types/sessionMove'
import { useAppStore } from '@renderer/app-state/hooks'
import { SendToWindowDialog } from '@renderer/features/workspace/ui/SendToWindowDialog'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { collectMoveSubtree } from '@renderer/workspace/sessionMove'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'

// The surface owns only the transient picker chrome. The move itself is
// Workspace.sendSessionToWindow (useSessionMoves), which also reports the
// outcome: the "Moved … to Window N" toast and any failure from main arrive
// as events, whoever started the move (this picker or an operator).
export function SendToWindowSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.sendToWindowSessionId)
  const close = useAppStore(state => state.closeSendToWindow)
  const { showToast } = useGlobalToast()
  const [targets, setTargets] = useState<SessionMoveTarget[] | null>(null)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const open = sessionId !== null && meta !== null

  useEffect(() => {
    if (!open) {
      setTargets(null)
      return
    }
    // Fetched per opening, never cached: windows open and close between
    // invocations, and a stale row would offer a window that is gone.
    let cancelled = false
    void window.api.listSessionMoveTargets()
      .then(list => { if (!cancelled) setTargets(list) })
      .catch(() => { if (!cancelled) setTargets([]) })
    return () => { cancelled = true }
  }, [open])

  const relatedCount = open && sessionId ? collectMoveSubtree(workspace.state.sessions, sessionId).length - 1 : 0
  const parentId = meta ? meta.linkedParentId ?? meta.orchestrationParentId : undefined
  const parentMeta = parentId ? workspace.state.sessions[parentId] : undefined

  return (
    <SendToWindowDialog
      open={open}
      sessionLabel={meta ? sessionDisplayTitle(meta) : ''}
      relatedCount={relatedCount}
      parentLabel={parentMeta ? sessionDisplayTitle(parentMeta) : null}
      targets={targets}
      onCancel={close}
      onPick={windowId => {
        if (!sessionId) return
        close()
        void workspace.sendSessionToWindow(sessionId, windowId).then(result => {
          // A refusal BEFORE anything moved (main's up-front checks, or a
          // packet that could not be built) returns here without an event, so
          // this is the one place it can be shown. Failures after the offer
          // arrive as `session-move-failed` and are toasted by the hook.
          if (!result.ok && !result.reportedByEvent) showToast(result.message)
        })
      }}
    />
  )
}
