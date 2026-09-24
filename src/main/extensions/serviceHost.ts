import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { relative as relativePath, resolve as resolvePath } from 'node:path'

import { extensionRevision, type InstalledExtension } from '@shared/types/extensions.js'
import type { ExtensionJson } from '@shared/types/extensionRuntime.js'
import type {
  ExtensionServiceExposure,
  ExtensionServiceHandle,
  ExtensionServiceStatus,
} from '@shared/types/extensionServices.js'
import {
  serviceToHostMessageSchema,
  type HostToServiceMessage,
} from '@shared/types/extensionServiceProcess.js'
import { extensionBundleDirectory, onExtensionPublication, readLedger, withLedgerLock } from './ledger.js'
import { realLanListener, type LanListenerFactory, type LanListenerHandle } from './serviceLanListener.js'

/**
 * The narrow process surface ExtensionServiceHost consumes. Exists so unit tests
 * can drive the full lifecycle (ready/result/exit/kill paths) with a fake
 * instead of a real Electron utilityProcess — the same deadline/factory
 * injection pattern ExtensionRuntimeService uses for its failure tests.
 */
export type SpawnedServiceProcess = {
  readonly pid: number
  postMessage(message: HostToServiceMessage): void
  onMessage(listener: (message: unknown) => void): () => void
  onExit(listener: (code: number) => void): () => void
  kill(): void
}

/** Production spawn: Electron utilityProcess (crash-monitored, no shell). */
async function defaultSpawn(entryPath: string, serviceName: string): Promise<SpawnedServiceProcess> {
  // Lazy import keeps this module loadable under plain Node (vitest unit
  // project); electron only resolves in the real main process.
  const { utilityProcess } = await import('electron')
  const child = utilityProcess.fork(entryPath, [], { serviceName, stdio: 'ignore' })
  return {
    // fork() either throws or yields a live child; 0 only occurs if Electron
    // reports a spawn race, and every consumer treats pid as diagnostics-only.
    pid: child.pid ?? 0,
    postMessage: message => { child.postMessage(message) },
    onMessage(listener) {
      // utilityProcess delivers the posted VALUE directly on 'message' —
      // unlike MessagePortMain, whose events carry {data}. Wrapping for the
      // latter shape silently turned every service message into undefined
      // here and terminated the service as "not understood" (caught by the
      // an Electron harness against a REAL spawned service).
      const handler = (message: unknown) => listener(message)
      child.on('message', handler)
      return () => child.off('message', handler)
    },
    onExit(listener) {
      const handler = (code: number) => listener(code)
      child.once('exit', handler)
      return () => child.off('exit', handler)
    },
    kill: () => { child.kill() },
  }
}

export type ExtensionServiceHostOptions = {
  spawn?: (entryPath: string, serviceName: string) => Promise<SpawnedServiceProcess> | SpawnedServiceProcess
  /** Factory seam so lifecycle tests fake the listener without real sockets. */
  lanListener?: LanListenerFactory
  /** Deadline injection keeps real-process failure tests short; production uses the defaults. */
  readyTimeoutMs?: number
  invokeTimeoutMs?: number
  shutdownGraceMs?: number
}

type Pending = { resolve(value: ExtensionJson | undefined): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

type RunningService = {
  extensionId: string
  serviceId: string
  revision: string
  process: SpawnedServiceProcess
  endpoints: Array<{ name: string; port: number }>
  stopping: boolean
  ready: Promise<void>
  resolveReady(): void
  rejectReady(error: Error): void
  pending: Map<string, Pending>
}

/**
 * Main-owned lifecycle for bundled native extension services (`service.run`).
 *
 * WHY a dedicated owner rather than extending ExtensionRuntimeService: a runtime
 * is a sandboxed renderer with no Node; a service is a real child process with
 * full Node. Merging them would let lifecycle code blur which one it is holding
 * (e.g. "destroy the window" vs "kill the process"), and the security story for
 * each is different — the runtime is contained by construction, the service is
 * trusted-by-consent. Two owners, one shared pattern: publication is the
 * revocation edge for both.
 *
 * Explicit-start policy: nothing here launches on install or app start. Only the
 * extension's own runtime/view can call start(), and both arrive through
 * capabilityService after the `service.run` grant check — so native code never
 * begins running without a user-visible action from code the user consented to.
 */
export class ExtensionServiceHost {
  private readonly running = new Map<string, RunningService>()
  // One LAN listener per extension, not per service: exposure is an extension-
  // scoped decision (the grant is), and swapping target services under one
  // listener keeps "which port do I share with my friends" stable.
  private readonly exposed = new Map<string, LanListenerHandle>()
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly options: ExtensionServiceHostOptions = {}) {
    this.unsubscribe = onExtensionPublication(rows => {
      // Publication is the revocation edge, exactly as for runtimes: an update
      // or uninstall must terminate the old generation's processes even while a
      // caller still awaits an invoke. Matching is by row, not by revision
      // string, so a removed extension (no row) also kills its services.
      const live = new Map(rows.map(row => [row.manifest.id, extensionRevision(row)] as const))
      for (const service of this.running.values()) {
        if (live.get(service.extensionId) !== service.revision) {
          this.terminate(service, 'Extension was updated or removed.')
        }
      }
    })
  }

  async start(extensionId: string, revision: string, serviceId: string): Promise<ExtensionServiceHandle> {
    const { entry, bundleDir } = await this.resolve(extensionId, revision, serviceId)
    const key = this.key(extensionId, serviceId)
    const existing = this.running.get(key)
    if (existing) {
      // Single live instance per service id. A second start while the first is
      // alive joins it (idempotent) rather than killing and respawning behind
      // the caller's back — the first instance may hold unflushed state.
      await existing.ready
      return this.handle(existing)
    }
    if (this.closed) throw new Error('Extension host is stopped.')

    // Resolve symlinks BEFORE deciding what to execute: the ledger row is
    // trusted, the filesystem is not. This mirrors verifyEntryInsideBundle's
    // authority rule (a manifest entry cannot promote a link outside the bundle
    // into a launched process) at the moment of launch rather than only install.
    // install.ts is the user-facing gate; this is the execution gate — a bundle
    // swapped on disk between install and start must not hand a fork to bytes
    // the grant never covered.
    const physicalBundle = await realpath(bundleDir)
    const entryPath = await realpath(resolvePath(bundleDir, entry))
    const relative = relativePath(physicalBundle, entryPath)
    if (relative.startsWith('..') || resolvePath(relative) === relative) {
      throw new Error(`Service entry "${entry}" resolves outside the extension bundle.`)
    }

    const child = await (this.options.spawn ?? defaultSpawn)(entryPath, `${extensionId}:${serviceId}`)
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    void ready.catch(() => {})
    const service: RunningService = {
      extensionId, serviceId, revision, process: child, endpoints: [], stopping: false,
      ready, resolveReady, rejectReady, pending: new Map(),
    }
    this.running.set(key, service)

    let readyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      this.terminate(service, 'Service did not report ready before the deadline.')
    }, this.options.readyTimeoutMs ?? 10_000)

    const offMessage = child.onMessage(raw => {
      // A late message from a retired generation must never act on this map
      // entry; terminate() removes it first, so re-checks below are decisive.
      if (this.running.get(key) !== service) return
      const parsed = serviceToHostMessageSchema.safeParse(raw)
      if (!parsed.success) {
        this.terminate(service, 'Service sent a message the host does not understand.')
        return
      }
      const message = parsed.data
      if (message.kind === 'ready') {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
        service.endpoints = message.endpoints ?? []
        service.resolveReady()
      } else if (message.kind === 'result') {
        const pending = service.pending.get(message.id)
        if (!pending) return // duplicate or late reply: nothing to deliver
        service.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
      } else if (message.kind === 'log') {
        console.log(`[extension-service ${extensionId}:${serviceId}] ${message.line}`)
      }
      // 'stopped' arrives only as the shutdown acknowledgement, handled by the
      // stop() path's exit listener; nothing to do here.
    })
    const offExit = child.onExit(code => {
      offMessage()
      offExit()
      if (this.running.get(key) !== service) return
      // Unexpected exit: no graceful bookkeeping, reject everything waiting.
      this.terminate(service, `Service process exited (code ${code}).`)
    })

    await ready
    return this.handle(service)
  }

  async stop(extensionId: string, revision: string, serviceId: string): Promise<void> {
    await this.assertCurrent(extensionId, revision)
    const service = this.running.get(this.key(extensionId, serviceId))
    if (!service) return // stop is idempotent: stopping a stopped service is success
    await this.shutdown(service)
  }

  async status(extensionId: string, revision: string, serviceId: string): Promise<ExtensionServiceStatus> {
    await this.assertCurrent(extensionId, revision)
    const service = this.running.get(this.key(extensionId, serviceId))
    return service ? this.handle(service) : { state: 'stopped', serviceId }
  }

  async invoke(extensionId: string, revision: string, serviceId: string, name: string, params?: ExtensionJson): Promise<ExtensionJson | undefined> {
    await this.assertCurrent(extensionId, revision)
    const service = this.running.get(this.key(extensionId, serviceId))
    if (!service || service.stopping) throw new Error('Service is not running.')
    // Invoke requires an explicit prior start on purpose: start is the
    // user-visible action the consent story is built on, and auto-starting a
    // native process from a data-path call would make that story a lie.
    await service.ready
    const id = randomUUID()
    if (service.pending.size >= 32) throw new Error('Too many service requests are pending.')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Unknown outcome: never replay an RPC. Kill the process; a caller may
        // explicitly start a fresh instance and retry.
        this.terminate(service, 'Service request timed out; its result is unknown.')
      }, this.options.invokeTimeoutMs ?? 30_000)
      service.pending.set(id, { resolve, reject, timer })
      try { service.process.postMessage({ kind: 'request', id, name, params }) }
      catch (error) { this.terminate(service, String(error)) }
    })
  }

  /**
   * net.listen surface: expose(lan:true) points the host-owned LAN listener at
   * the running service's loopback endpoint; lan:false closes it. The broker
   * checked the grant before this runs; this method owns only mechanics — and
   * the invariant that no listener outlives its service.
   */
  async expose(extensionId: string, revision: string, serviceId: string, lan: boolean): Promise<ExtensionServiceExposure> {
    await this.assertCurrent(extensionId, revision)
    if (!lan) {
      await this.closeExposure(extensionId)
      return { serviceId, lan: false }
    }
    const service = this.running.get(this.key(extensionId, serviceId))
    if (!service || service.stopping || service.endpoints.length === 0) {
      throw new Error('Service is not running with a local endpoint.')
    }
    // Re-create on every expose so a restarted service cannot keep a stale
    // target port: close first, then bind fresh against today's endpoint.
    await this.closeExposure(extensionId)
    const listener = await (this.options.lanListener ?? realLanListener)(service.endpoints[0].port)
    this.exposed.set(extensionId, listener)
    return { serviceId, lan: true, port: listener.port }
  }

  private async closeExposure(extensionId: string): Promise<void> {
    const listener = this.exposed.get(extensionId)
    if (!listener) return
    this.exposed.delete(extensionId)
    // Close errors are logged, not thrown: an already-dead listener must not
    // block a re-expose or a service stop.
    await listener.close().catch(error => console.warn(`[extensions] LAN listener for ${extensionId} failed to close:`, error))
  }

  /** First reported loopback port of a RUNNING service, or null. The transport
   *  proxy dials 127.0.0.1:<port> in main — never the child — so loopback-ness
   *  holds by construction here. */
  serviceEndpoint(extensionId: string, serviceId: string): number | null {
    const service = this.running.get(this.key(extensionId, serviceId))
    return service && !service.stopping && service.endpoints.length > 0 ? service.endpoints[0].port : null
  }

  /** Every loopback port this host owns: ALL extensions' running service
   *  endpoints plus their LAN listeners. net.fetch refuses these (see
   *  netFetch.ts) so no extension can reach any service, its own or another's,
   *  around the proxy and listener that tell a service who is calling.
   *  Listeners bind every interface, so their port is reachable on loopback. */
  isHostOwnedLoopbackPort(port: number): boolean {
    for (const service of this.running.values()) {
      if (service.endpoints.some(endpoint => endpoint.port === port)) return true
    }
    for (const listener of this.exposed.values()) if (listener.port === port) return true
    return false
  }

  /** App-quit drain: kill every service and close every exposure; no ceremony. */
  pause(): void {
    this.closed = true
    for (const extensionId of [...this.exposed.keys()]) void this.closeExposure(extensionId)
    for (const service of this.running.values()) this.terminate(service, 'Agent Code is closing.')
  }

  dispose(): void {
    this.pause()
    this.unsubscribe()
  }

  private handle(service: RunningService): ExtensionServiceHandle {
    return { state: 'running', serviceId: service.serviceId, pid: service.process.pid, endpoints: structuredClone(service.endpoints) }
  }

  private key(extensionId: string, serviceId: string): string {
    return `${extensionId}\u0000${serviceId}`
  }

  /** Resolve a declared service against the committed ledger generation. */
  private async resolve(extensionId: string, revision: string, serviceId: string): Promise<{ entry: string; bundleDir: string }> {
    return withLedgerLock(async () => {
      const row: InstalledExtension | undefined = (await readLedger()).find(candidate => candidate.manifest.id === extensionId)
      if (!row || extensionRevision(row) !== revision) throw new Error('This extension installation is no longer active.')
      const contribution = row.manifest.contributes?.services?.find(service => service.id === serviceId)
      // An undeclared id is not a 404 to paper over: reaching this point means
      // granted code asked to run a process the user never saw in the manifest.
      if (!contribution) throw new Error(`Service "${serviceId}" is not declared by this extension.`)
      return { entry: contribution.entry, bundleDir: extensionBundleDirectory(row) }
    })
  }

  private async assertCurrent(extensionId: string, revision: string): Promise<void> {
    // Revoke-awareness for stop/status/invoke: a caller may hold a stale
    // generation across an update. The publication listener already terminated
    // the old instance; this makes the CALL fail the same way instead of
    // reporting success against a process that no longer belongs to anyone.
    const row = (await readLedger()).find(candidate => candidate.manifest.id === extensionId)
    if (!row || extensionRevision(row) !== revision) throw new Error('This extension installation is no longer active.')
  }

  /** Graceful stop: shutdown notice, short deadline, then kill. */
  private async shutdown(service: RunningService): Promise<void> {
    const key = this.key(service.extensionId, service.serviceId)
    if (this.running.get(key) !== service) return
    service.stopping = true
    const exited = new Promise<void>(resolveExit => {
      const off = service.process.onExit(() => { off(); resolveExit() })
    })
    try { service.process.postMessage({ kind: 'shutdown', id: randomUUID() }) }
    catch { /* already gone; exit listener fires */ }
    const grace = setTimeout(() => this.terminate(service, 'Service did not stop before the deadline.'), this.options.shutdownGraceMs ?? 500)
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, this.options.shutdownGraceMs ?? 500 + 50))])
    clearTimeout(grace)
    this.terminate(service, 'Service stopped.')
  }

  /** Immediate teardown: reject waiters, clear state, kill the process. The
   *  extension's LAN listener dies with its last service — exposure must never
   *  outlive the thing it exposes, and a dead target would 502 forever. */
  private terminate(service: RunningService, error: string): void {
    const key = this.key(service.extensionId, service.serviceId)
    if (this.running.get(key) !== service) return
    this.running.delete(key)
    void this.closeExposure(service.extensionId)
    service.rejectReady(new Error(error))
    for (const pending of service.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(error))
    }
    service.pending.clear()
    try { service.process.kill() } catch { /* already dead */ }
  }
}
