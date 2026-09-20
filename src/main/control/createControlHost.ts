import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { createControlExecutor, createControlRegistry } from '@control-sdk/host'
import {
  controlRegistrationSchema, controlRequestSchema, rendererControlResponseSchema,
  ControlError, workspaceObservationSchema,
  type ControlCaller, type ControlRequest, type RegisteredCapability, type ControlOperatorPort, type ControlContext, type ControlResult,
} from '@control-sdk'
import { ControlRendererBridge } from './rendererBridge'
import { windowControlCapabilities } from '@main/window/control'
import { focusWindow } from '@main/window/focusWindow'
import { FileControlHistory } from './history/FileControlHistory'
import { historyCapabilities } from './history/control'
import { taskHistoryCapabilities } from './history/tasks'
import { globalControlCapabilities, type ObserveWindows } from './globalCapabilities'
import { batchControlCapabilities } from './batches'
import { createWaitControl } from './waits'

/**
 * How long committed shutdown waits for admitted control work.
 *
 * Long enough that an ordinary operation and its durable write always finish,
 * short enough that a wedged one cannot hold the application hostage. See
 * `dispose` for why a bound exists at all.
 */
const CONTROL_DRAIN_TIMEOUT_MS = 10_000

export function createControlHost(windowAccess: {
  getBrowserWindow(id: string): BrowserWindow | null
  windowIdFor(sender: WebContents): string | null
  listWindowIds(): string[]
}, historyDirectory: string, additionalCapabilities: readonly RegisteredCapability[] | ((ports: {
  invokeTask: (context: ControlContext, request: ControlRequest) => Promise<ControlResult>
}) => readonly RegisteredCapability[]) = []) {
  // Inject the window adapter for isolated Electron trials. The production
  // adapter is the existing window registry, never an SDK-owned window store.
  const { getBrowserWindow, windowIdFor, listWindowIds } = windowAccess
  const registry = createControlRegistry()
  const mainOwner = { kind: 'main' as const, generation: randomUUID() }
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
  // Nested: a wait's inner read belongs to the wait that was already
  // admitted, and refusing it mid-shutdown would strand the parent.
  //
  // ── WHY THESE FLAGS ARE UNTESTABLE TODAY, AND KEPT ANYWAY ──
  // Removing `nested` from any of the three internal call sites leaves the
  // suite green, and that is honest rather than a coverage gap: none of them
  // can currently reach the gate.
  //   - The main task port carries only `operations.start`/`operations.finish`,
  //     which are receipt-exempt (see the gate in `executor.invoke`).
  //   - `agents.batchRead` is a read and its members are hardcoded
  //     `agents.read` — also reads, admitted regardless.
  //   - `agents.batchPrompt` is a MUTATION, so the batch itself is refused at
  //     the gate before any member runs.
  //   - A wait's inner request is hardcoded `agents.read`/`operations.read`.
  // The flags are the standing answer for the first non-read batch member or
  // non-receipt main-port capability, which would otherwise be half-finished
  // by a shutdown with no test to notice.
  const waits = createWaitControl((request, caller) => executor.invoke(request, caller, { nested: true }))
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

  // This private composition port is only for main-owned task journal writes.
  // Features keep the original caller for their own domain authorization; an
  // external request never gets this application identity from tool input.
  const additional = typeof additionalCapabilities === 'function' ? additionalCapabilities({ invokeTask: (context, request) => {
    if (JSON.stringify(context.owner) !== JSON.stringify(mainOwner) || !['operations.start', 'operations.finish'].includes(request.capabilityId)) throw new ControlError('unavailable', 'Main task port only records its own lifecycle')
    return executor.invoke(request, { kind: 'application', id: `control-main:${mainOwner.generation}` }, { nested: true })
  } }) : additionalCapabilities
  const unregisterMain = registry.register(mainOwner, [...windowControlCapabilities(() =>
    listWindowIds().map((windowId, index) => ({
      windowId, number: index + 1, title: getBrowserWindow(windowId)?.getTitle() ?? '',
      minimized: getBrowserWindow(windowId)?.isMinimized() ?? false,
      bounds: getBrowserWindow(windowId)?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      focused: getBrowserWindow(windowId)?.isFocused() ?? false,
      generation: windows.get(windowId)?.generation ?? null,
    })),
  ), ...historyCapabilities(history), ...taskHistoryCapabilities(history, owner => registry.list().some(row => JSON.stringify(row.owner) === JSON.stringify(owner))),
  ...globalControlCapabilities(observeWindows), ...waits.capabilities, ...batchControlCapabilities((request, caller) => executor.invoke(request, caller, { nested: true })), ...additional])

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
    /**
     * Committed shutdown for the control surface (#943).
     *
     * ── WHY THIS IS ASYNC, AND WHY THE ORDER IS THE CONTRACT ──
     * It used to retire waits, window registrations and IPC handlers and
     * return. None of that is evidence that anything STOPPED: an admitted
     * operation was still running, and its durable result was still queued
     * behind `FileControlHistory`'s append tail. The caller
     * (`applicationShutdown`'s `control` stage) then released the exit and the
     * state-process lock, so the process could die between an effect happening
     * and the record of it reaching disk — the one state that makes a retry
     * after restart unanswerable.
     *
     *  1. Close admission. Reads keep answering; they change nothing, and
     *     refusing them would blind the tooling used to diagnose a stuck quit.
     *  2. Cancel outstanding WAITS. A wait is a read that would otherwise sit
     *     in the drain for its full deadline for no purpose — the thing it is
     *     waiting for is being torn down. This does not touch the registry.
     *  3. AWAIT what was admitted, THEN the history tail. This order is real:
     *     an operation finishing appends its own result, so draining the file
     *     first would leave the very last one behind. And the tail covers what
     *     the executor cannot — `recordTransport` appends straight to the
     *     history, outside any call.
     *  4. ONLY NOW retire the registrations, and last of all the IPC handlers.
     *
     * ── WHY STEP 4 IS LAST, WHICH IT WAS NOT (#1074 review, 1) ──
     * `unregisterMain()` and the window retirements EMPTY THE CATALOG, and the
     * admission gate resolves a capability's declared effect against that
     * catalog, treating an unknown id as effectful. Doing them before the
     * drain therefore refused everything during it — including every declared
     * read, and including `operations.start`/`operations.finish`, whose own
     * owner had just been unregistered ("No owner for operations.start").
     * Three of the claims in this comment were false as written. Draining
     * first keeps the catalog intact for exactly as long as anything still
     * needs it.
     *
     * ── WHY THE DRAIN IS BOUNDED ──
     * It holds the exit and the state-process lock. A never-resolving
     * operation — a stalled `fsync` in the history append is the realistic
     * one — would make the application impossible to quit, and the user's
     * answer to that is a force quit, which loses the record this protects AND
     * strands the lock. `stopPerformance` already settled the same trade-off
     * three stages later for the same reason. Giving up loudly beats hanging
     * silently, so what was still outstanding is reported to the caller.
     */
    async dispose(options: {
      timeoutMs?: number
      onIncompleteDrain?: (outstanding: { operations: number; tasks: number }) => void
    } = {}) {
      executor.closeAdmission()
      waits.dispose()
      // The deadline lives HERE, not in the executor: `src/control-sdk` is
      // platform-neutral and has no timer in its type lib, which the CI
      // type-check caught when the race was written there.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        executor.settled(),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, options.timeoutMs ?? CONTROL_DRAIN_TIMEOUT_MS)
        }),
      ])
      if (timer) clearTimeout(timer)
      const outcome = executor.outstanding()
      await history.drain?.()
      if (!outcome.drained) {
        options.onIncompleteDrain?.({ operations: outcome.operations, tasks: outcome.tasks })
      }
      for (const window of [...windows.values()]) window.dispose()
      unregisterMain()
      for (const name of ['register', 'unregister', 'response', 'catalog', 'invoke']) ipcMain.removeHandler(`control:${name}`)
    },
  }
}
