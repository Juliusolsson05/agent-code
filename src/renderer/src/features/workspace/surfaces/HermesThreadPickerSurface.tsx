import { useAppStore } from '@renderer/app-state/hooks'
import { HermesThreadPickerModal } from '@renderer/features/workspace/ui/HermesThreadPickerModal'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Store-driven host for "Change Telegram Thread…" (#1501), the same shape as
// ProviderSwitchPickerSurface: non-null `hermesThreadPickerSessionId` = open.
export function HermesThreadPickerSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.hermesThreadPickerSessionId)
  const close = useAppStore(state => state.closeHermesThreadPicker)
  return (
    <HermesThreadPickerModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      onClose={close}
    />
  )
}
