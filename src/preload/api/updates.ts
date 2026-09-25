import { ipcRenderer } from 'electron'

import type { UpdateChannel, UpdateChannelSnapshot } from '@shared/updates/updateChannel.js'

/** Settings → Workspace → Update channel (#1168). */
export const updatesApi = {
  getUpdateChannel: (): Promise<UpdateChannelSnapshot> => ipcRenderer.invoke('updates:get-channel'),
  setUpdateChannel: (channel: UpdateChannel): Promise<UpdateChannelSnapshot> =>
    ipcRenderer.invoke('updates:set-channel', channel),
}
