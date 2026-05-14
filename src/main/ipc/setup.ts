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
    // tmux was dropped from the install pathway when bundled tmux
    // (#120) became the only supported source. The remaining target
    // is mitmproxy, which follows the same cleanup track and will
    // disappear shortly. Keep this validation in step with
    // SetupInstallTarget so renderer-side type checks remain useful.
    if (target !== 'mitmproxy') {
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
