import { RemotePanel } from '@renderer/features/remote/ui/RemotePanel'
import { useAppStore } from '@renderer/app-state/hooks'

export function RemotePanelSurface() {
  const open = useAppStore(state => state.remotePanelOpen)
  const toggle = useAppStore(state => state.toggleRemotePanel)
  if (!open) return null
  return <RemotePanel onClose={toggle} />
}
