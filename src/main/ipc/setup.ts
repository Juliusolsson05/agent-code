import { ipcMain } from 'electron'

import type { SetupInstallTarget, SetupToolId } from '@shared/types/setup.js'
import { installWithHomebrew } from '@main/setup/homebrewInstaller.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { markOptionalSkipped } from '@main/setup/setupState.js'

export function registerSetupIpc(): void {
  ipcMain.handle('setup:check', async () => {
    return await checkPrerequisites()
  })

  ipcMain.handle('setup:install', async (_evt, target: SetupInstallTarget) => {
    if (target !== 'tmux' && target !== 'mitmproxy') {
      return {
        ok: false,
        target,
        output: `Unknown setup install target: ${String(target)}`,
        check: await checkPrerequisites(),
      }
    }
    return await installWithHomebrew(target)
  })

  ipcMain.handle('setup:skip-optional', async (_evt, tool: SetupToolId) => {
    await markOptionalSkipped(tool, true)
    return await checkPrerequisites()
  })
}
