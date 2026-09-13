import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron'
import { extensionRevision, type InstalledExtension, type ExtensionActivationEvent } from '@shared/types/extensions.js'
import {
  isExtensionJson, runtimeApiRequestSchema, runtimeEventSchema,
  type ExtensionJson, type RuntimeInvocation, type RuntimeStatus, type RuntimeChange, type RuntimeViewSnapshot,
} from '@shared/types/extensionRuntime.js'
import { onExtensionPublication, readLedger, withLedgerLock } from './ledger.js'
import { extensionStorageDelete, extensionStorageGet, extensionStorageKeys, extensionStorageSet } from './storage.js'
import { EXTENSION_SCHEME, handleExtensionScheme } from './scheme.js'
import { RUNTIME_DOCUMENT } from './runtimeDocument.js'
import type { ExtensionCapabilityService } from './capabilityService.js'

type PendingInvocation = {
  resolve(value: ExtensionJson | undefined): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
type Retirement = { runtime: ManagedRuntime; token: string; done: Promise<void>; finish(): void }
type ManagedRuntime = {
  installation: InstalledExtension
  revision: string
  url: string
  window: BrowserWindow
  senderId: number
  session: Session
  state: RuntimeStatus['state']
  ready: Promise<void>
  resolveReady(): void
  rejectReady(error: Error): void
  startupTimer: ReturnType<typeof setTimeout>
  pending: Map<string, PendingInvocation>
  viewStates: Map<string, RuntimeViewSnapshot>
  apiInFlight: number
  credits: number
  creditedAt: number
}

export type ExtensionRuntimeOptions = {
  preload: string
  capabilities: ExtensionCapabilityService
  onStatus?(status: RuntimeStatus): void
  onViewState?(extensionId: string, revision: string, viewId: string, state: ExtensionJson): void
  /** Deadline injection keeps real-process failure tests short; production uses the defaults. */
  startupTimeoutMs?: number
  invocationTimeoutMs?: number
  shutdownTimeoutMs?: number
}

// Main owns this registry, not an application window. A command and two views
// all rendezvous on the same installation generation. Application window closes
// therefore cannot destroy extension-wide state. No extension receives the host
// preload or a generic IPC channel: the dedicated runtime preload exposes only
// this module's schema-validated, sender-bound transport.
export class ExtensionRuntimeService {
  private readonly runtimes = new Map<string, ManagedRuntime>()
  private readonly senders = new Map<number, ManagedRuntime>()
  private readonly retiring = new Map<number, Retirement>()
  private disposal?: Promise<void>
  private readonly listeners = new Set<(event: RuntimeChange) => void>()
  private readonly preparations = new Map<string, Promise<void>>()
  private readonly callers = new Map<string, number>()
  private readonly unsubscribe: () => void
  private closed = false
  private paused = false
  private startupEnabled = false
  private readonly publishedRevisions = new Map<string, string>()

  constructor(private readonly options: ExtensionRuntimeOptions) {
    ipcMain.handle('extensions:runtime-api', this.onApi)
    ipcMain.on('extensions:runtime-event', this.onEvent)
    this.unsubscribe = onExtensionPublication(rows => {
      for (const runtime of this.runtimes.values()) {
        const next = rows.find(row => row.manifest.id === runtime.installation.manifest.id)
        if (!next || extensionRevision(next) !== runtime.revision) {
          // Revocation is synchronous with publication. Waiting for a React
          // unmount (or a graceful author callback) would leave the superseded
          // runtime able to call APIs after its permission record was replaced.
          this.retire(runtime, 'Extension was updated or removed.', 'stopped')
        }
      }
      const changed = rows.filter(row => this.publishedRevisions.get(row.manifest.id) !== extensionRevision(row))
      this.publishedRevisions.clear()
      for (const row of rows) this.publishedRevisions.set(row.manifest.id, extensionRevision(row))
      if (this.startupEnabled && !this.paused) for (const row of changed) void this.startRequested(row)

    })
  }

  private async startRequested(row: InstalledExtension): Promise<void> {
    if (row.manifest.apiVersion !== 2 || !row.manifest.activationEvents?.some(event => event === '*' || event === 'onStartupFinished')) return
    try { await this.start(row.manifest.id, extensionRevision(row)) }
    catch (error) { console.error(`[extensions] startup failed for ${row.manifest.id}:`, error) }
  }

  async activateStartupExtensions(): Promise<void> {
    if (this.closed) return
    this.startupEnabled = true
    const rows = await withLedgerLock(async () => {
      if (this.closed || this.paused) return []
      const current = await readLedger()
      // Arm publication while holding the same lock as this snapshot. Otherwise
      // an install between read and subscribe could lose its startup activation.
      this.publishedRevisions.clear()
      for (const row of current) this.publishedRevisions.set(row.manifest.id, extensionRevision(row))
      return current
    })
    await Promise.all(rows.map(row => this.startRequested(row)))
  }

  async pause(): Promise<void> {
    // A native unsaved-file sheet can cancel app quit. Keep this service and its
    // IPC registrations reusable until will-quit is admitted; only the runtimes
    // are drained during the cancellable phase. Saved state remains durable.
    this.paused = true
    for (const runtime of this.runtimes.values()) this.retire(runtime, 'Agent Code is closing.', 'stopped')
    await Promise.all([...this.retiring.values()].map(retirement => retirement.done))
  }

  async resume(): Promise<void> {
    if (this.closed) return
    this.paused = false
    if (this.startupEnabled) await this.activateStartupExtensions()
  }

  async start(extensionId: string, revision: string): Promise<void> {
    await this.withCall(extensionId, async () => {
      const runtime = await this.ensure(extensionId, revision)
      await runtime.ready
    })
  }

  subscribe(listener: (event: RuntimeChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async startView(extensionId: string, revision: string, viewId: string): Promise<void> {
    await this.withCall(extensionId, async () => {
      const runtime = await this.ensure(extensionId, revision, installation => {
        if (!installation.manifest.contributes?.views?.some(view => view.id === viewId)) throw new Error('View is not declared by this extension.')
      }, `onView:${viewId}`)
      await runtime.ready
    })
  }

  async invokeCommand(extensionId: string, revision: string, commandId: string): Promise<ExtensionJson | undefined> {
    return this.withCall(extensionId, async () => {
      const runtime = await this.ensure(extensionId, revision, installation => {
        if (!installation.manifest.contributes?.commands?.some(command => command.id === commandId)) throw new Error('Command is not declared by this extension.')
      }, `onCommand:${commandId}`)
      await runtime.ready
      return this.invoke(runtime, { kind: 'command', id: randomUUID(), commandId })
    })
  }

  async requestFromView(extensionId: string, revision: string, view: { id: string; instanceId: string }, name: string, input: ExtensionJson, assertCallerCurrent?: () => void): Promise<ExtensionJson | undefined> {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) || !isExtensionJson(input) || !view.instanceId || view.instanceId.length > 128) throw new Error('Invalid extension view request.')
    return this.withCall(extensionId, async () => {
      const runtime = await this.ensure(extensionId, revision, installation => {
        if (!installation.manifest.contributes?.views?.some(candidate => candidate.id === view.id)) throw new Error('View is not declared by this extension.')
      }, `onView:${view.id}`)
      await runtime.ready
      // An owner may close while startup/ledger I/O is pending. Check its
      // main-owned binding at the last boundary before dispatching author code.
      assertCallerCurrent?.()
      return this.invoke(runtime, { kind: 'request', id: randomUUID(), name, input, view })
    })
  }

  viewState(extensionId: string, revision: string, viewId: string): ExtensionJson | undefined {
    const runtime = this.runtimes.get(extensionId)
    if (!runtime || runtime.revision !== revision) return undefined
    return structuredClone(runtime.viewStates.get(viewId)?.state)
  }

  viewSnapshot(extensionId: string, revision: string, viewId: string): RuntimeViewSnapshot {
    const runtime = this.runtimes.get(extensionId)
    if (!runtime || runtime.revision !== revision || !this.active(runtime)) throw new Error('Extension runtime is no longer active.')
    return structuredClone(runtime.viewStates.get(viewId) ?? { sequence: 0 })
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closed = true
    this.unsubscribe()
    ipcMain.removeHandler('extensions:runtime-api')
    for (const runtime of this.runtimes.values()) this.retire(runtime, 'Extension host stopped.', 'stopped')
    // Keep only the acknowledgement listener while draining. Revoked senders
    // cannot make API calls or complete commands; normal shutdown may still
    // acknowledge cleanup before the independent force-destroy deadline.
    this.disposal = Promise.all([...this.retiring.values()].map(retirement => retirement.done)).then(() => {
      ipcMain.removeListener('extensions:runtime-event', this.onEvent)
      this.listeners.clear()
    })
    return this.disposal
  }

  private async withCall<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    // Count before ledger I/O and activation, not only after the runtime becomes
    // ready. Otherwise a hung startup could accumulate an unbounded list of
    // callers waiting on the same promise while pending.size still read zero.
    const count = this.callers.get(extensionId) ?? 0
    if (count >= 32) throw new Error('Too many extension calls are pending.')
    this.callers.set(extensionId, count + 1)
    try { return await operation() }
    finally {
      const remaining = (this.callers.get(extensionId) ?? 1) - 1
      if (remaining) this.callers.set(extensionId, remaining)
      else this.callers.delete(extensionId)
    }
  }

  private async ensure(extensionId: string, revision: string, validate?: (installation: InstalledExtension) => void, reason: ExtensionActivationEvent = 'onStartupFinished'): Promise<ManagedRuntime> {
    return withLedgerLock(async () => {
      if (this.closed) throw new Error('Extension host is stopped.')
      if (this.paused) throw new Error('Extension host is shutting down.')
      const installation = (await readLedger()).find(row => row.manifest.id === extensionId)
      if (!installation || extensionRevision(installation) !== revision) throw new Error('This extension installation is no longer active.')
      validate?.(installation)
      const existing = this.runtimes.get(extensionId)
      if (existing?.revision === revision) return existing
      // `onStartupFinished` grants the same eligibility as `*`. Such an
      // extension asked to run for the whole session, so refusing its own
      // command or view merely because the engine is not running right now
      // protects nothing: the startup pass would have started it anyway. The
      // refusal instead stranded real states where a startup runtime is absent
      // — a command deadline or crash destroyed it, activation failed and the
      // user pressed Retry, or startup activation had not been enabled yet when
      // it was installed. Timer (startup-only manifest) reproduced this in the
      // Electron journey: its panel could never attach until an app restart.
      // Lazy extensions keep exact matching, so an undeclared contribution still
      // cannot start a cold engine that deliberately waits for a specific event.
      if (installation.manifest.apiVersion === 2 && !installation.manifest.activationEvents?.some(event => event === '*' || event === 'onStartupFinished' || event === reason)) {
        throw new Error(`This extension does not declare activation for ${reason}.`)
      }
      if (existing) this.retire(existing, 'Extension generation changed.', 'stopped')
      // Serialize reuse of the private session through actual window teardown.
      // Otherwise old cleanup/unhandle could race a newly created generation
      // and remove its protocol handler beneath activation.
      // This wait is bounded and acknowledgements never need the ledger lock.
      await Promise.all([...this.retiring.values()]
        .filter(retirement => retirement.runtime.installation.manifest.id === extensionId)
        .map(retirement => retirement.done))
      if (this.closed) throw new Error('Extension host is stopped.')
      if (this.paused) throw new Error('Extension host is shutting down.')
      if (this.runtimes.size + this.retiring.size >= 16) throw new Error('At most 16 extension runtimes can run at once.')
      // Insert under the publication lock BEFORE any navigation can begin. Two
      // simultaneous cold commands must not each construct an engine, and an
      // update must not slip between reading the ledger and registering its owner.
      // Do not await loadURL here: scheme requests need this same ledger lock.
      return this.create(installation)
    })
  }

  private create(installation: InstalledExtension): ManagedRuntime {
    const extensionId = installation.manifest.id
    const revision = extensionRevision(installation)
    const isolated = session.fromPartition(`extension-runtime:${extensionId}`)
    handleExtensionScheme(isolated.protocol)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    // CSP does not govern every navigation/egress channel. This session belongs
    // only to this runtime, so blocking direct external/file requests cannot
    // break application networking, editor files or microphone access. Future
    // network capabilities must use the consent-gated main API, never raw fetch.
    isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (_details, callback) => callback({ cancel: true }))
    let window: BrowserWindow
    try {
      window = new BrowserWindow({
        // Background code must not gain a keyboard target or a taskbar surface
        // by calling window.focus(). Views are the only visible extension UI.
        show: false, focusable: false, skipTaskbar: true, width: 1, height: 1,
        webPreferences: { preload: this.options.preload, session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, backgroundThrottling: false },
      })
    } catch (error) {
      isolated.protocol.unhandle(EXTENSION_SCHEME)
      throw error
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-frame-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    // A startup can fail between publication and its first caller awaiting ready.
    // Keep the original rejecting promise for callers but mark it observed here.
    void ready.catch(() => {})
    const runtime: ManagedRuntime = {
      installation, revision, window, senderId: window.webContents.id, session: isolated,
      url: `agent-code-ext://${extensionId}/__bundle/${encodeURIComponent(revision)}/${RUNTIME_DOCUMENT}`,
      state: 'starting', ready, resolveReady, rejectReady,
      startupTimer: setTimeout(() => this.retire(runtime, 'Extension runtime did not finish starting before the deadline.'), this.options.startupTimeoutMs ?? 10_000),
      pending: new Map(), viewStates: new Map(), apiInFlight: 0, credits: 128, creditedAt: performance.now(),
    }
    this.runtimes.set(extensionId, runtime)
    this.senders.set(window.webContents.id, runtime)
    window.webContents.on('render-process-gone', (_event, details) => this.retire(runtime, `Extension runtime process ended: ${details.reason}.`))
    window.on('closed', () => {
      this.retire(runtime, 'Extension runtime window closed.')
      this.retiring.get(runtime.senderId)?.finish()
    })
    this.publishStatus(runtime)
    // Browser storage is disposable. The dedicated main storage API is the only
    // durable contract; clearing before navigation prevents a new generation from
    // inheriting ambient cookies/localStorage left by the previous engine.
    // A generation can retire while its asynchronous browser-storage clear is
    // still pending. Chain the next clear behind it, otherwise an older clear
    // could finish after a replacement has already started using the session.
    // Startup's deadline still bounds the caller if Chromium never completes it.
    const preparation = (this.preparations.get(extensionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => isolated.clearStorageData())
    this.preparations.set(extensionId, preparation)
    const forgetPreparation = () => { if (this.preparations.get(extensionId) === preparation) this.preparations.delete(extensionId) }
    void preparation.then(forgetPreparation, forgetPreparation)
    void preparation.then(() => {
      if (!this.active(runtime)) return
      return window.loadURL(runtime.url)
    }).catch(error => this.retire(runtime, String(error)))
    return runtime
  }

  private active(runtime: ManagedRuntime): boolean {
    return this.runtimes.get(runtime.installation.manifest.id) === runtime && (runtime.state === 'starting' || runtime.state === 'ready')
  }

  private authenticate(event: IpcMainEvent | IpcMainInvokeEvent): ManagedRuntime {
    const runtime = this.senders.get(event.sender.id)
    if (!runtime || !this.active(runtime) || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== runtime.url) throw new Error('Request is not from an active extension runtime.')
    // Per-runtime budget covers both successful and malformed messages. Counting
    // only accepted requests would let invalid payloads monopolize the main loop.
    const now = performance.now()
    runtime.credits = Math.min(128, runtime.credits + (now - runtime.creditedAt) * 0.128)
    runtime.creditedAt = now
    if (runtime.credits < 1) throw new Error('Extension runtime message rate exceeded.')
    runtime.credits -= 1
    return runtime
  }

  private onApi = async (event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> => {
    const runtime = this.authenticate(event)
    if (!isExtensionJson(raw)) throw new Error('Extension request exceeds the JSON limits.')
    const request = runtimeApiRequestSchema.parse(raw)
    if (runtime.apiInFlight >= 32) throw new Error('Too many extension API requests are pending.')
    runtime.apiInFlight += 1
    try {
      const id = runtime.installation.manifest.id
      let result: unknown
      switch (request.method) {
        case 'storage.get': result = await extensionStorageGet(id, request.key); break
        case 'storage.set': await extensionStorageSet(id, request.key, request.value); break
        case 'storage.delete': await extensionStorageDelete(id, request.key); break
        case 'storage.keys': result = await extensionStorageKeys(id); break
        case 'fs.readText':
        case 'fs.writeText':
        case 'notifications.show':
          result = await this.options.capabilities.invoke(id, runtime.revision, request)
          break
        case 'views.publish': {
          if (!runtime.installation.manifest.contributes?.views?.some(view => view.id === request.viewId)) throw new Error('View is not declared by this extension.')
          const snapshot = { sequence: (runtime.viewStates.get(request.viewId)?.sequence ?? 0) + 1, state: request.state }
          runtime.viewStates.set(request.viewId, snapshot)
          this.emit({ kind: 'view', extensionId: id, revision: runtime.revision, viewId: request.viewId, snapshot })
          try { this.options.onViewState?.(id, runtime.revision, request.viewId, structuredClone(request.state)) }
          catch (error) { console.error('[extensions] view state subscriber failed:', error) }
          break
        }
        default: {
          const unhandled: never = request
          throw new Error(`Unhandled extension runtime API request: ${String(unhandled)}`)
        }
      }
      if (!this.active(runtime)) throw new Error('Extension runtime ended during the request.')
      if (result !== undefined && !isExtensionJson(result)) throw new Error('Extension API result exceeds the JSON limits.')
      return result
    } finally { runtime.apiInFlight -= 1 }
  }

  private onEvent = (event: IpcMainEvent, raw: unknown): void => {
    const retirement = this.retiring.get(event.sender.id)
    if (retirement) {
      // Teardown has a separate, single-purpose identity: no ready/result/API
      // message can restore a revoked runtime. A guessed acknowledgement from a
      // sibling frame or another process must not cut cleanup short either.
      if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== retirement.runtime.url || !isExtensionJson(raw)) return
      const parsed = runtimeEventSchema.safeParse(raw)
      if (parsed.success && parsed.data.kind === 'stopped' && parsed.data.id === retirement.token) retirement.finish()
      return
    }
    let runtime: ManagedRuntime
    try { runtime = this.authenticate(event) } catch { return }
    if (!isExtensionJson(raw)) { this.retire(runtime, 'Extension runtime response exceeds the JSON limits.'); return }
    const parsed = runtimeEventSchema.safeParse(raw)
    if (!parsed.success) { this.retire(runtime, 'Extension runtime sent an invalid response.'); return }
    const message = parsed.data
    if (message.kind === 'ready') {
      if (runtime.state !== 'starting') return
      clearTimeout(runtime.startupTimer)
      runtime.state = 'ready'
      runtime.resolveReady()
      this.publishStatus(runtime)
    } else if (message.kind === 'failed') this.retire(runtime, message.error)
    else if (message.kind === 'result') {
      const pending = runtime.pending.get(message.id)
      if (!pending) return
      runtime.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error))
    }
  }

  private invoke(runtime: ManagedRuntime, message: RuntimeInvocation): Promise<ExtensionJson | undefined> {
    if (!this.active(runtime)) return Promise.reject(new Error('Extension runtime is no longer active.'))
    if (runtime.pending.size >= 32) return Promise.reject(new Error('Too many extension commands or view requests are pending.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Never replay an action with an unknown outcome. Stop its execution
        // context and reject all waiters; a user may explicitly retry afterward.
        this.retire(runtime, 'Extension invocation timed out; its result is unknown.')
      }, this.options.invocationTimeoutMs ?? 30_000)
      runtime.pending.set(message.id, { resolve, reject, timer })
      try { runtime.window.webContents.send('extensions:runtime-invoke', message) }
      catch (error) { this.retire(runtime, String(error)) }
    })
  }

  private retire(runtime: ManagedRuntime, error: string, state: 'failed' | 'stopped' = 'failed'): void {
    if (!this.active(runtime)) return
    runtime.state = state
    this.runtimes.delete(runtime.installation.manifest.id)
    this.senders.delete(runtime.senderId)
    clearTimeout(runtime.startupTimer)
    runtime.rejectReady(new Error(error))
    for (const pending of runtime.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(error))
    }
    runtime.pending.clear()
    runtime.viewStates.clear()
    this.publishStatus(runtime, error)
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      runtime.session.protocol.unhandle(EXTENSION_SCHEME)
      if (!runtime.window.isDestroyed()) runtime.window.destroy()
      this.retiring.delete(runtime.senderId)
      resolveDone()
    }
    const token = randomUUID()
    this.retiring.set(runtime.senderId, { runtime, token, done, finish })
    // Unknown command outcomes and failed startups are terminated immediately.
    // Only a normal update/remove/app shutdown gives cooperative code a short
    // cleanup opportunity; it has no durable API authority during that grace.
    if (state === 'failed' || runtime.window.isDestroyed()) { finish(); return }
    timer = setTimeout(finish, this.options.shutdownTimeoutMs ?? 500)
    try { runtime.window.webContents.send('extensions:runtime-invoke', { kind: 'shutdown', id: token } satisfies RuntimeInvocation) }
    catch { finish() }
  }

  private emit(event: RuntimeChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone(event)) }
      catch (failure) { console.error('[extensions] runtime subscriber failed:', failure) }
    }
  }

  private publishStatus(runtime: ManagedRuntime, error?: string): void {
    const status: RuntimeStatus = { extensionId: runtime.installation.manifest.id, revision: runtime.revision, state: runtime.state, ...(error ? { error } : {}) }
    this.emit({ kind: 'status', status })
    try { this.options.onStatus?.(status) }
    catch (failure) { console.error('[extensions] runtime status subscriber failed:', failure) }
  }
}
