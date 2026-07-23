import { ColorFlagPickerModal } from '@renderer/features/workspace/ui/ColorFlagPickerModal'
import { useAppStore } from '@renderer/app-state/hooks'

// Mounts the Dispatch color-flag picker driven by uiShell's
// `colorFlagPickerSessionId`. Mirrors AgentViewModePickerSurface — the "Set
// color flag" command opens it via ctx.ui.openColorFlagPicker(sessionId).
export function ColorFlagPickerSurface() {
  const sessionId = useAppStore(state => state.colorFlagPickerSessionId)
  const close = useAppStore(state => state.closeColorFlagPicker)
  return (
    <ColorFlagPickerModal
      open={sessionId !== null}
      sessionId={sessionId}
      onClose={close}
    />
  )
}
