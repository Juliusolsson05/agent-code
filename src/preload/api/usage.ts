import { ipcRenderer } from 'electron'

import type { UsageSnapshot, UsageSnapshotRequest } from '@shared/types/usage.js'

export const usageApi = {
  getUsageSnapshot: (request?: UsageSnapshotRequest): Promise<UsageSnapshot> =>
    ipcRenderer.invoke('usage:get-snapshot', request),
}
