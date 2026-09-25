import { CloseCompletedAgentsModal } from '@renderer/features/workspace/ui/CloseCompletedAgentsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function CloseCompletedAgentsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.closeCompletedAgentsOpen)
  const close = useAppStore(state => state.closeCloseCompletedAgents)
  // Mounted only while open (#1184 review). The modal holds goal records it
  // re-reads on open; kept mounted, a reopening showed LAST opening's records
  // — ticked, and handed to the kill-boundary check — until the new read
  // landed, or forever if it failed. A fresh mount per opening makes "nothing
  // from before" structural instead of a reset every state has to remember.
  return open ? <CloseCompletedAgentsModal open workspace={workspace} onClose={close} /> : null
}
