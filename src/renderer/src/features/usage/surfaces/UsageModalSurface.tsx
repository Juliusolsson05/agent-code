import { UsageModal } from '@renderer/features/usage/ui/UsageModal'
import { useAppStore } from '@renderer/app-state/hooks'

export function UsageModalSurface() {
  const open = useAppStore(state => state.usageModalOpen)
  const close = useAppStore(state => state.closeUsageModal)
  return <UsageModal open={open} onClose={close} />
}
