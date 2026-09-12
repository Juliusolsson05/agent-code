import { ConversationsPicker } from '@renderer/features/conversations/ui/ConversationsPicker'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// The one surface behind Resume Session… and Search Conversations…; the
// store decides whether it is open and whether the search field starts
// focused, the picker decides everything else.
export function ConversationsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.conversationsOpen)
  const focusSearch = useAppStore(state => state.conversationsFocusSearch)
  const close = useAppStore(state => state.closeConversations)
  return <ConversationsPicker open={open} focusSearch={focusSearch} workspace={workspace} onClose={close} />
}
