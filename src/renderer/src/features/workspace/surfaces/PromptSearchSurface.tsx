import { PromptSearchModal } from '@renderer/features/workspace/ui/PromptSearchModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function PromptSearchSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.promptSearchOpen)
  const close = useAppStore(state => state.closePromptSearch)
  return <PromptSearchModal open={open} workspace={workspace} onClose={close} />
}
