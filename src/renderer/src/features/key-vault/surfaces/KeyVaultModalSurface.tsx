import { useAppStore } from '@renderer/app-state/hooks'
import { KeyVaultModal } from '@renderer/features/key-vault/ui/KeyVaultModal'

export function KeyVaultModalSurface() {
  const open = useAppStore(state => state.keyVaultOpen)
  if (!open) return null
  return <KeyVaultModal />
}
