import { ipcRenderer } from 'electron'
import { subscribe } from './ipc'
import type {
  CapabilityListing, ControlOwner, ControlRegistration, ControlRequest, ControlResult,
  RendererControlRequest, RendererControlResponse,
} from '@control-sdk'

// Preload only transports the narrow contract; policy and registration lifetime
// stay in their owners. No generic IPC channel or callback escapes to features.
export const controlApi = {
  controlRegister: (registration: ControlRegistration): Promise<ControlOwner> => ipcRenderer.invoke('control:register', registration),
  controlUnregister: (generation: string): Promise<void> => ipcRenderer.invoke('control:unregister', generation),
  controlCatalog: (): Promise<CapabilityListing[]> => ipcRenderer.invoke('control:catalog'),
  controlInvoke: (request: ControlRequest): Promise<ControlResult> => ipcRenderer.invoke('control:invoke', request),
  onControlRequest: (callback: (request: RendererControlRequest) => void) => subscribe('control:request', callback),
  controlRespond: (response: RendererControlResponse): Promise<boolean> => ipcRenderer.invoke('control:response', response),
}
