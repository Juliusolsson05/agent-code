import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { TldrHistoryModal } from '../TldrHistoryModal'

export function TldrHistorySurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.tldrHistorySessionId)
  const close = useAppStore(state => state.closeTldrHistory)
  return <TldrHistoryModal open={sessionId !== null} sessionId={sessionId} workspace={workspace} onClose={close} />
}
