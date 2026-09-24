import { ipcMain } from 'electron'

import type { UpdateService } from '@main/updates/UpdateService.js'
import type { UpdateCheckStore } from '@main/updates/updateCheckStore.js'
import { isUpdateChannel, type UpdateChannel } from '@shared/updates/updateChannel.js'

export type UpdateChannelSnapshot = {
  channel: UpdateChannel
  /** The running app's version, shown beside the choice in Settings. */
  version: string
  /** False for a build run from source: it never updates, whichever channel. */
  packaged: boolean
}

/** Settings → Workspace → Update channel (#1168). Main owns the value
 *  (updates.json), because the updater needs it before any window exists. */
export function registerUpdatesIpc(deps: {
  updateService: Pick<UpdateService, 'channel' | 'setChannel'>
  updateChecks: Pick<UpdateCheckStore, 'ready'>
  app: { version: string; isPackaged: boolean }
}): void {
  const snapshot = (): UpdateChannelSnapshot => ({
    channel: deps.updateService.channel,
    version: deps.app.version,
    packaged: deps.app.isPackaged,
  })
  ipcMain.handle('updates:get-channel', async () => {
    // Wait for updates.json, so Settings never shows the default for a
    // moment and then the stored choice.
    await deps.updateChecks.ready()
    return snapshot()
  })
  ipcMain.handle('updates:set-channel', async (_event, channel: unknown) => {
    if (!isUpdateChannel(channel)) throw new Error('Unknown update channel')
    await deps.updateChecks.ready()
    deps.updateService.setChannel(channel)
    return snapshot()
  })
}
