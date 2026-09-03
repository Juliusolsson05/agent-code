import { useAppStore } from '@renderer/app-state/hooks'
import { ProviderSwitchPickerModal } from '@renderer/features/workspace/ui/ProviderSwitchPickerModal'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ProviderSwitchPickerSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.providerSwitchPickerSessionId)
  const close = useAppStore(state => state.closeProviderSwitchPicker)
  return (
    <ProviderSwitchPickerModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      onClose={close}
    />
  )
}
