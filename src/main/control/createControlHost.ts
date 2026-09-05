import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { createControlExecutor, createControlRegistry } from '@control-sdk/host'
import {
  controlRegistrationSchema, controlRequestSchema, rendererControlResponseSchema,
  ControlError, workspaceObservationSchema,
  type ControlCaller, type ControlRequest, type RegisteredCapability, type ControlOperatorPort,
} from '@control-sdk'
import { ControlRendererBridge } from './rendererBridge'
import { windowControlCapabilities } from '@main/window/control'
import { focusWindow } from '@main/window/focusWindow'
import { FileControlHistory } from './history/FileControlHistory'
import { historyCapabilities } from './history/control'
import { taskHistoryCapabilities } from './history/tasks'
import { globalControlCapabilities, type ObserveWindows } from './globalCapabilities'

export function createControlHost(windowAccess: {
  getBrowserWindow(id: string): BrowserWindow | null
  windowIdFor(sender: WebContents): string | null
  listWindowIds(): string[]
}, historyDirectory: string, additionalCapabilities: readonly RegisteredCapability[] = []) {
  // Inject the window adapter for isolated Electron trials. The production
  // adapter is the existing window registry, never an SDK-owned window store.
  const { getBrowserWindow, windowIdFor, listWindowIds } = windowAccess
  const registry = createControlRegistry()
  const observeWindows: ObserveWindows = context => Promise.all(listWindowIds().map(async windowId => {
    const owner = registry.list().find(row => row.descriptor.id === 'workspace.observe'
      && row.owner.kind === 'window' && row.owner.windowId === windowId)?.owner
    if (!owner) return { windowId, owner: null, error: 'Window has not registered its workspace' }
    const result = await registry.invoke({ capabilityId: 'workspace.observe', input: {}, owner }, context)
    if (!result.ok) return { windowId, owner, error: result.error.message }
    const parsed = workspaceObservationSchema.safeParse(result.value)
    return parsed.success ? { windowId, owner, workspace: parsed.data } : { windowId, owner, error: 'Invalid workspace observation' }
  }))
  const history = new FileControlHistory(historyDirectory)
  const instanceId = randomUUID()
  const executor = createControlExecutor({ history, instanceId, id: randomUUID,
    now: () => new Date().toISOString(), catalog: () => registry.list(),
    ownershipEvidence: async (kind, id, context) => {
      const observed = await observeWindows(context)
      if (observed.some(window => window.error)) throw new ControlError('unavailable', 'Some windows could not be observed; provide an explicit owner or wait for registration')
      return observed.filter(window => kind === 'session' ? window.workspace?.sessions.some(session => session.sessionId === id)
        : window.workspace?.tabs.some(tab => tab.id === id)).flatMap(window => window.owner ? [window.owner] : [])
    },
    activateOwner: async owner => {
      if (owner.kind !== 'window') return
      const window = getBrowserWindow(owner.windowId)
      if (!window || window.isDestroyed()) throw new Error('Target window disappeared')
      await focusWindow(window)
    },
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
    listWindowIds().map((windowId, index) => ({
      windowId, number: index + 1, title: getBrowserWindow(windowId)?.getTitle() ?? '',
      minimized: getBrowserWindow(windowId)?.isMinimized() ?? false,
      bounds: getBrowserWindow(windowId)?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      focused: getBrowserWindow(windowId)?.isFocused() ?? false,
      generation: windows.get(windowId)?.generation ?? null,
    })),
  ), ...historyCapabilities(history), ...taskHistoryCapabilities(history, owner => registry.list().some(row => JSON.stringify(row.owner) === JSON.stringify(owner))),
  ...globalControlCapabilities(observeWindows), ...additionalCapabilities])

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
      return {
        catalog: () => registry.list(),
        invoke: (request: ControlRequest) => executor.invoke(controlRequestSchema.parse(request), caller),
        recordTransport: async (event: Parameters<ControlOperatorPort['recordTransport']>[0]) => {
          await history.append({ callId: event.id, instanceId, capabilityId: `mcp.${event.method}`,
            caller: `${caller.kind}:${caller.id}`, at: new Date().toISOString(),
            kind: event.direction === 'request' ? 'transport' : 'result' }, { direction: event.direction, payload: event.payload })
        },
      }
    },
    dispose() {
      for (const window of [...windows.values()]) window.dispose()
      unregisterMain()
      for (const name of ['register', 'unregister', 'response', 'catalog', 'invoke']) ipcMain.removeHandler(`control:${name}`)
    },
  }
}
