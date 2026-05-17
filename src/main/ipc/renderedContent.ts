import { ipcMain } from 'electron'

import { openAllowedExternalUrl, type ExternalOpenResult } from '@main/window/externalNavigation.js'

export function registerRenderedContentIpc(): void {
  ipcMain.handle(
    'rendered-content:open-external-url',
    async (_evt, params: { url: string }): Promise<ExternalOpenResult> => {
      return openAllowedExternalUrl(params.url)
    },
  )
}
