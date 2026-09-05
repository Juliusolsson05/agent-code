import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { createControlExecutor, createControlRegistry } from '@control-sdk/host'
import {
  controlRegistrationSchema, controlRequestSchema, rendererControlResponseSchema,
  type ControlCaller, type ControlRequest, type RegisteredCapability,
} from '@control-sdk'
import { ControlRendererBridge } from './rendererBridge'
import { windowControlCapabilities } from '@main/window/control'
import { FileControlHistory } from './history/FileControlHistory'
import { historyCapabilities } from './history/control'

export function createControlHost(windowAccess: {
  getBrowserWindow(id: string): BrowserWindow | null
  windowIdFor(sender: WebContents): string | null
  listWindowIds(): string[]
}, historyDirectory: string) {
  // Inject the window adapter for isolated Electron trials. The production
  // adapter is the existing window registry, never an SDK-owned window store.
  const { getBrowserWindow, windowIdFor, listWindowIds } = windowAccess
  const registry = createControlRegistry()
  const history = new FileControlHistory(historyDirectory)
  const executor = createControlExecutor({ history, instanceId: randomUUID(), id: randomUUID,
    now: () => new Date().toISOString(), catalog: () => registry.list(),
    dispatch: (request, context) => registry.invoke(request, context) })
  const bridge = new ControlRendererBridge((windowId, message) => {
    const window = getBrowserWindow(windowId)
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Window unavailable')
    window.webContents.send('control:request', message)
  })
  const windows = new Map<string, { generation: string; dispose(): void }>()

  function senderWindow(event: IpcMainInvokeEvent): string {
    const id = windowIdFor(event.sender)
    if (!id || !getBrowserWindow(id) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Control requests require a registered application main frame')
    }
    return id
  }

  const unregisterMain = registry.register({ kind: 'main', generation: randomUUID() }, [...windowControlCapabilities(() =>
    listWindowIds().map(windowId => ({
      windowId, focused: getBrowserWindow(windowId)?.isFocused() ?? false,
      generation: windows.get(windowId)?.generation ?? null,
    })),
  ), ...historyCapabilities(history)])

  ipcMain.handle('control:register', (event, raw: unknown) => {
    const windowId = senderWindow(event)
    const registration = controlRegistrationSchema.parse(raw)
    const ids = new Set<string>()
    for (const descriptor of registration.capabilities) {
      if (descriptor.execution !== 'window' || ids.has(descriptor.id)) throw new Error('Invalid renderer capability batch')
      ids.add(descriptor.id)
    }
    if (windows.get(windowId)?.generation === registration.generation) throw new Error('Control generation already registered')
    // Validate the whole replacement before retiring the current registration.
    // StrictMode/HMR can overlap cleanup with registration; generation checks
    // keep an old cleanup from unregistering the new JS world.
    windows.get(windowId)?.dispose()
    const owner = { kind: 'window' as const, windowId, generation: registration.generation }
    const capabilities: RegisteredCapability[] = registration.capabilities.map(descriptor => ({
      descriptor,
      execute: (input, context) => bridge.invoke({ capabilityId: descriptor.id, input, owner }, context),
    }))
    const unregister = registry.register(owner, capabilities)
    const sender = event.sender
    const dispose = () => {
      if (windows.get(windowId)?.generation !== owner.generation) return
      windows.delete(windowId)
      unregister()
      bridge.retire(windowId, owner.generation)
      sender.removeListener('destroyed', dispose)
      sender.removeListener('did-start-navigation', navigation)
    }
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) dispose()
    }
    windows.set(windowId, { generation: owner.generation, dispose })
    sender.once('destroyed', dispose)
    sender.on('did-start-navigation', navigation)
    return owner
  })
  ipcMain.handle('control:unregister', (event, generation: unknown) => {
    const windowId = senderWindow(event)
    if (typeof generation === 'string' && windows.get(windowId)?.generation === generation) windows.get(windowId)?.dispose()
  })
  ipcMain.handle('control:response', (event, raw: unknown) =>
    bridge.resolve(senderWindow(event), rendererControlResponseSchema.parse(raw)),
  )
  ipcMain.handle('control:catalog', event => {
    senderWindow(event)
    return registry.list()
  })
  ipcMain.handle('control:invoke', (event, raw: unknown) => {
    const id = senderWindow(event)
    return executor.invoke(controlRequestSchema.parse(raw), { kind: 'application', id })
  })

  return {
    catalog: () => registry.list(),
    forCaller: (identity: ControlCaller) => {
      const caller = Object.freeze({ ...identity })
      return { invoke: (request: ControlRequest) => executor.invoke(controlRequestSchema.parse(request), caller) }
    },
    dispose() {
      for (const window of [...windows.values()]) window.dispose()
      unregisterMain()
      for (const name of ['register', 'unregister', 'response', 'catalog', 'invoke']) ipcMain.removeHandler(`control:${name}`)
    },
  }
}
