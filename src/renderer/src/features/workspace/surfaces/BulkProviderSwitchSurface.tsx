import { BulkProviderSwitchModal } from '@renderer/features/workspace/ui/BulkProviderSwitchModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function BulkProviderSwitchSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.bulkProviderSwitchOpen)
  const close = useAppStore(state => state.closeBulkProviderSwitch)
  return <BulkProviderSwitchModal open={open} workspace={workspace} onClose={close} />
}
