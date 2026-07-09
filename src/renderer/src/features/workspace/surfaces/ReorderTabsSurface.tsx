import { ReorderTabsModal } from '@renderer/features/workspace/ui/ReorderTabsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ReorderTabsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.reorderTabsOpen)
  const close = useAppStore(state => state.closeReorderTabs)
  return (
    <ReorderTabsModal
      open={open}
      tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
      activeTabId={workspace.state.activeTabId}
      onCancel={close}
      onConfirm={tabIds => {
        workspace.reorderTabs(tabIds)
        close()
      }}
    />
  )
}
