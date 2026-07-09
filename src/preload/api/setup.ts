import { ipcRenderer } from 'electron'

import type {
  SetupCheckResult,
  SetupInstallResult,
  SetupInstallTarget,
  SetupSetToolPathResult,
  SetupToolId,
} from '@shared/types/setup.js'

export const setupApi = {
  setupCheck: (): Promise<SetupCheckResult> =>
    ipcRenderer.invoke('setup:check'),
  setupInstall: (target: SetupInstallTarget): Promise<SetupInstallResult> =>
    ipcRenderer.invoke('setup:install', target),
  setupSkipOptional: (tool: SetupToolId): Promise<SetupCheckResult> =>
    ipcRenderer.invoke('setup:skip-optional', tool),
  setupSetToolPath: (tool: SetupToolId, path: string): Promise<SetupSetToolPathResult> =>
    ipcRenderer.invoke('setup:set-tool-path', tool, path),
}

