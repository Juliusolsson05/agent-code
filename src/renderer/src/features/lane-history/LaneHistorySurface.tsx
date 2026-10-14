import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { LaneHistoryModal } from './LaneHistoryModal'

export function LaneHistorySurface() {
  const workspace = useWorkspaceContext()
  const laneIndex = useAppStore(state => state.laneHistoryLane)
  const close = useAppStore(state => state.closeLaneHistory)
  return <LaneHistoryModal laneIndex={laneIndex} workspace={workspace} onClose={close} />
}
