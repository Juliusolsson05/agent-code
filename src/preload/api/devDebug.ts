import { ipcRenderer } from 'electron'

import type { DevDebugConfig } from '@preload/api/types.js'

export const devDebugApi = {
  getDevDebugConfig: (): Promise<DevDebugConfig> =>
    ipcRenderer.invoke('dev-debug:get-config'),
}
