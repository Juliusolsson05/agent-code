import { ipcMain } from 'electron'

import { getUsageSnapshot, listUsageSources } from '@main/usage/usageService.js'
import type { UsageSnapshotRequest } from '@shared/types/usage.js'

export function registerUsageIpc(): void {
  ipcMain.handle('usage:get-snapshot', async (_evt, request?: UsageSnapshotRequest) =>
    getUsageSnapshot(request ?? {}),
  )
  // The modal's skeleton + empty-state logic keys off this list; before this
  // handler existed the preload invoke rejected and the modal silently fell
  // back to "no sources enabled" on every open (review finding #1).
  ipcMain.handle('usage:get-sources', async () => listUsageSources())
}
