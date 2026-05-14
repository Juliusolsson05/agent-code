import type { DevDebugModule } from '@renderer/features/debug/devModules/types'
import { headlessSnapshotProbeModule } from '@renderer/features/debug/devModules/HeadlessSnapshotProbe/module'

export const devDebugModules: DevDebugModule[] = [
  headlessSnapshotProbeModule,
]
