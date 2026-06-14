import type { DevDebugModule } from '@renderer/features/debug/devModules/types'
import { headlessSnapshotProbeModule } from '@renderer/features/debug/devModules/HeadlessSnapshotProbe/module'
import { claudePasteDetectionModule } from '@renderer/features/debug/devModules/ClaudePasteDetection/module'

export const devDebugModules: DevDebugModule[] = [
  headlessSnapshotProbeModule,
  claudePasteDetectionModule,
]
