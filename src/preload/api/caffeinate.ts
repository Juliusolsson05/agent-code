import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  CaffeinateCommandResult,
  CaffeinateStatus,
  Unsub,
} from '@preload/api/types.js'

export const caffeinateApi = {
  getCaffeinateStatus: (): Promise<CaffeinateStatus> =>
    ipcRenderer.invoke('caffeinate:get-status'),

  startCaffeinate: (): Promise<CaffeinateCommandResult> =>
    ipcRenderer.invoke('caffeinate:start'),

  stopCaffeinate: (): Promise<CaffeinateCommandResult> =>
    ipcRenderer.invoke('caffeinate:stop'),

  toggleCaffeinate: (): Promise<CaffeinateCommandResult> =>
    ipcRenderer.invoke('caffeinate:toggle'),

  onCaffeinateStateChanged: (handler: (status: CaffeinateStatus) => void): Unsub =>
    subscribe('caffeinate:state-changed', handler),
}
