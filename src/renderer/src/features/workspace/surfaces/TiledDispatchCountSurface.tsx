import { TiledDispatchCountOverlay } from '@renderer/features/workspace/ui/TiledDispatchCountOverlay'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Tiled Dispatch tile-count prompt. Rendered at the app root (fixed
// overlay) because the command is `app`-surface — it can be invoked
// from the grid, classic Dispatch, or an already-tiled layout.
export function TiledDispatchCountSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.tiledDispatchPromptOpen)
  const close = useAppStore(state => state.closeTiledDispatchPrompt)
  if (!open) return null
  return <TiledDispatchCountOverlay workspace={workspace} onClose={close} />
}
