import { ipcMain } from 'electron'

import { getUsageSnapshot } from '@main/usage/usageService.js'
import type { UsageSnapshotRequest } from '@shared/types/usage.js'

export function registerUsageIpc(): void {
  ipcMain.handle('usage:get-snapshot', async (_evt, request?: UsageSnapshotRequest) =>
    getUsageSnapshot(request ?? {}),
  )
}
