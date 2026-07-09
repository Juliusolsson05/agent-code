import { TileTabsModal } from '@renderer/features/tile-tabs/ui/TileTabsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Registry wrapper (#494). Lives in features/workspace/surfaces (not
// tile-tabs) because the *surface* is a workspace-level concern — which
// tabs to tile — even though the modal UI belongs to tile-tabs.
// Always mounted with an `open` prop, exactly as App.tsx mounted it.
export function TileTabsModalSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.tileTabsModalOpen)
  const initialSelectedIds = useAppStore(state => state.tileTabsInitialSelectedIds)
  const close = useAppStore(state => state.closeTileTabsModal)
  return (
    <TileTabsModal
      open={open}
      tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
      initialSelectedIds={initialSelectedIds}
      onCancel={close}
      onConfirm={tabIds => {
        workspace.openTileTabs(tabIds)
        close()
      }}
    />
  )
}
