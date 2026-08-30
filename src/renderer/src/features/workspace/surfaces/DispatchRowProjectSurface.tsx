import { DispatchRowProjectModal } from '@renderer/features/workspace/ui/DispatchRowProjectModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Grid Dispatch row-project picker. Opened from a row's index header, which is
// why the store carries the ROW INDEX rather than a boolean — see
// UiShellState.dispatchRowProjectPickerRow.
export function DispatchRowProjectSurface() {
  const workspace = useWorkspaceContext()
  const rowIndex = useAppStore(state => state.dispatchRowProjectPickerRow)
  const close = useAppStore(state => state.closeDispatchRowProjectPicker)
  return (
    <DispatchRowProjectModal rowIndex={rowIndex} workspace={workspace} onClose={close} />
  )
}
