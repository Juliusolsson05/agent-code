import { ipcRenderer } from 'electron'

import type {
  SetupCheckResult,
  SetupInstallResult,
  SetupInstallTarget,
  SetupToolId,
} from '@shared/types/setup.js'

export const setupApi = {
  setupCheck: (): Promise<SetupCheckResult> =>
    ipcRenderer.invoke('setup:check'),
  setupInstall: (target: SetupInstallTarget): Promise<SetupInstallResult> =>
    ipcRenderer.invoke('setup:install', target),
  setupSkipOptional: (tool: SetupToolId): Promise<SetupCheckResult> =>
    ipcRenderer.invoke('setup:skip-optional', tool),
}

