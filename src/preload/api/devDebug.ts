import { ipcRenderer } from 'electron'

import type { DevDebugConfig, PasteDebugSession } from '@preload/api/types.js'

export const devDebugApi = {
  getDevDebugConfig: (): Promise<DevDebugConfig> =>
    ipcRenderer.invoke('dev-debug:get-config'),

  // Pull the most-recent paste-debug journals for the ClaudePasteDetection
  // module (#90). Newest first; `limit` caps how many submits we hydrate.
  readPasteEvents: (limit?: number): Promise<PasteDebugSession[]> =>
    ipcRenderer.invoke('dev-debug:read-paste-events', limit),
}
