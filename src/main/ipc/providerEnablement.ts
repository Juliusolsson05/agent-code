import { ipcMain } from 'electron'

import {
  getProviderEnablementSnapshot,
  onProviderEnablementChanged,
  resetProviderEnablement,
  setOpencodeUsage,
  setProviderEnabled,
} from '@main/setup/providerEnablement.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import {
  OPENCODE_USAGE_SOURCES,
  type OpencodeUsageSource,
} from '@shared/types/providerEnablement.js'
import { isAgentProviderKind, type AgentProviderKind } from '@shared/types/providerKind.js'

// Handlers return the fresh snapshot AND the change is broadcast, so every
// window's pickers update even though only one window's settings row was
// touched — same contract as cli-updates:state.
export function registerProviderEnablementIpc(): void {
  ipcMain.handle('provider-enablement:get', () => getProviderEnablementSnapshot())

  ipcMain.handle('provider-enablement:set', async (_evt, kind: unknown, enabled: unknown) => {
    if (!isAgentProviderKind(kind) || typeof enabled !== 'boolean') {
      throw new Error('provider-enablement:set: invalid arguments')
    }
    return await setProviderEnabled(kind as AgentProviderKind, enabled)
  })

  ipcMain.handle('provider-enablement:reset', async (_evt, kind: unknown) => {
    if (!isAgentProviderKind(kind)) {
      throw new Error('provider-enablement:reset: invalid kind')
    }
    return await resetProviderEnablement(kind as AgentProviderKind)
  })

  ipcMain.handle(
    'provider-enablement:set-opencode-usage-source',
    async (_evt, value: unknown) => {
      if (
        typeof value !== 'string' ||
        !(OPENCODE_USAGE_SOURCES as readonly string[]).includes(value)
      ) {
        throw new Error('provider-enablement:set-opencode-usage-source: invalid value')
      }
      return await setOpencodeUsage(value as OpencodeUsageSource)
    },
  )

  onProviderEnablementChanged(snapshot => {
    broadcastToWindows('provider-enablement:changed', snapshot)
  })
}
