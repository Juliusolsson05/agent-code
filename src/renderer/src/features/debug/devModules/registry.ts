import type { DevDebugModule } from '@renderer/features/debug/devModules/types'
import { headlessSnapshotProbeModule } from '@renderer/features/debug/devModules/HeadlessSnapshotProbe/module'
import { claudePasteDetectionModule } from '@renderer/features/debug/devModules/ClaudePasteDetection/module'
import { transcriptSyncModule } from '@renderer/features/debug/devModules/TranscriptSync/module'
import { conditionsDebugModule } from '@renderer/features/debug/devModules/Conditions/module'

export const devDebugModules: DevDebugModule[] = [
  conditionsDebugModule,
  headlessSnapshotProbeModule,
  claudePasteDetectionModule,
  transcriptSyncModule,
]
