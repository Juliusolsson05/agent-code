import { KeyboardShortcutsModal } from '@renderer/features/settings/ui/KeyboardShortcutsModal'
import { useAppStore } from '@renderer/app-state/hooks'

export function KeyboardShortcutsSurface() {
  const open = useAppStore(state => state.keyboardShortcutsOpen)
  const close = useAppStore(state => state.closeKeyboardShortcuts)
  return <KeyboardShortcutsModal open={open} onClose={close} />
}
