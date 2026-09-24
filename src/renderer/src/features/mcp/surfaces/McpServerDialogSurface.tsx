import { useAppStore } from '@renderer/app-state/hooks'
import { McpServerDialog } from '@renderer/features/mcp/ui/McpServerDialog'

// Mounted only while open so each opening starts from a fresh draft; the
// dialog's paste/import state must never leak from one "Add server" to the next.
export function McpServerDialogSurface() {
  const open = useAppStore(state => state.mcpServerDialog !== null)
  if (!open) return null
  return <McpServerDialog />
}
