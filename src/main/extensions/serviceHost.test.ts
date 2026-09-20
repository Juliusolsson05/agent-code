import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// serviceHost owns real child processes in production. Unit tests drive the
// full lifecycle through the injected spawn factory (the same pattern
// ExtensionRuntimeService uses for its failure tests), so ready/result/exit/
// kill paths are exercised under plain Node without Electron. The Electron
// journey harness covers the real utilityProcess fork separately.

const authority = vi.hoisted(() => ({
  publish: undefined as undefined | ((rows: Array<{ manifest: { id: string } }>) => void),
  rows: [] as Array<Record<string, unknown>>,
}))

vi.mock('./ledger.js', () => ({
  readLedger: () => authority.rows,
  withLedgerLock: async <T>(work: () => Promise<T> | T) => await work(),
  onExtensionPublication: (listener: typeof authority.publish) => {
    authority.publish = listener
    return () => { if (authority.publish === listener) authority.publish = undefined }
  },
  extensionBundleDirectory: (row: Record<string, unknown>) => String((row as { bundleDir: string }).bundleDir),
}))

const { ExtensionServiceHost } = await import('./serviceHost.js')
import type { SpawnedServiceProcess } from './serviceHost.js'

/** Scriptable stand-in for a utilityProcess child. */
class FakeServiceProcess {
  private static nextPid = 1
  readonly pid = 42_000 + FakeServiceProcess.nextPid++
  killed = false
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()
  received: Array<Record<string, unknown>> = []
  private readyPayload: Record<string, unknown> | null = null
  private readySent = false

  postMessage(message: Record<string, unknown>): void {
    this.received.push(message)
    if (message.kind === 'shutdown') this.exit(0)
  }
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    // A real service sends ready once its module has loaded — always AFTER the
    // host forked it. Modeling that as "on first subscriber" makes the fake
    // deterministic instead of racing the host's realpath/spawn awaits.
    if (this.readyPayload && !this.readySent) {
      this.readySent = true
      const payload = this.readyPayload
      queueMicrotask(() => this.emit(payload))
    }
    return () => { this.messageListeners.delete(listener) }
  }
  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }
  kill(): void { this.exit(1) }
  emit(message: unknown): void { for (const listener of this.messageListeners) listener(message) }
  armReady(payload: Record<string, unknown>): void { this.readyPayload = payload }
  exit(code: number): void {
    if (this.killed) return
    this.killed = true
    for (const listener of [...this.exitListeners]) listener(code)
  }
  asProcess(): SpawnedServiceProcess {
    return {
      pid: this.pid,
      postMessage: message => this.postMessage(message as Record<string, unknown>),
      onMessage: listener => this.onMessage(listener),
      onExit: listener => this.onExit(listener),
      kill: () => this.kill(),
    }
  }
}

const roots: string[] = []
const REVISION = 'generation-one'

function ledgerWith(bundleDir: string, entry = 'service.js'): void {
  authority.rows = [{
    manifest: { id: 'timer', apiVersion: 2, contributes: { services: [{ id: 'timer.worker', entry }] } },
    installation: { id: REVISION, bundleSha256: 'a'.repeat(64) },
    bundleDir,
  }]
}

async function bundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-service-host-'))
  roots.push(root)
  await writeFile(join(root, 'service.js'), 'module.exports = {}')
  return root
}

/** Test helper: report ready and yield so the host's start() can observe it. */
async function started(child: FakeServiceProcess, endpoints?: Array<{ name: string; port: number }>): Promise<void> {
  child.emit({ kind: 'ready', ...(endpoints ? { endpoints } : {}) })
  await new Promise(resolve => setImmediate(resolve))
}

/** Spawn factory whose fake reports ready the moment the host subscribes. */
function spawnReportingReady(child: FakeServiceProcess, endpoints?: Array<{ name: string; port: number }>) {
  child.armReady(endpoints ? { kind: 'ready', endpoints } : { kind: 'ready' })
  return () => child.asProcess()
}

function hostWith(process: FakeServiceProcess, endpoints?: Array<{ name: string; port: number }>) {
  return new ExtensionServiceHost({
    spawn: spawnReportingReady(process, endpoints),
    readyTimeoutMs: 200,
    invokeTimeoutMs: 200,
    shutdownGraceMs: 50,
  })
}

afterEach(() => {
  authority.publish = undefined
  authority.rows = []
  vi.useRealTimers()
  void Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ExtensionServiceHost', () => {
  it('start waits for ready and returns the reported endpoints', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child, [{ name: 'http', port: 5192 }])
    await expect(host.start('timer', REVISION, 'timer.worker')).resolves.toEqual({
      state: 'running', serviceId: 'timer.worker', pid: child.pid, endpoints: [{ name: 'http', port: 5192 }],
    })
    expect(child.received).toEqual([])
    host.dispose()
  })

  it('a second start joins the live instance instead of respawning', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    const first = await host.start('timer', REVISION, 'timer.worker')
    const second = await host.start('timer', REVISION, 'timer.worker')
    expect(second.pid).toBe(first.pid)
    host.dispose()
  })

  it('invoke round-trips a request through the process', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    await host.start('timer', REVISION, 'timer.worker')
    const call = host.invoke('timer', REVISION, 'timer.worker', 'status', { deep: true })
    await new Promise(resolve => setImmediate(resolve))
    const sent = child.received.find(message => message.kind === 'request')
    expect(sent?.name).toBe('status')
    const id = sent?.id as string
    child.emit({ kind: 'result', id, ok: true, value: { up: true } })
    await expect(call).resolves.toEqual({ up: true })
    host.dispose()
  })

  it('invoke without an explicit start rejects — the data path never launches native code', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const host = hostWith(new FakeServiceProcess())
    await expect(host.invoke('timer', REVISION, 'timer.worker', 'status')).rejects.toThrow('not running')
    host.dispose()
  })

  it('rejects a service id the manifest never declared', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const host = hostWith(new FakeServiceProcess())
    await expect(host.start('timer', REVISION, 'timer.ghost')).rejects.toThrow('not declared')
    host.dispose()
  })

  it('publication revocation terminates the process and rejects pending invokes', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    await host.start('timer', REVISION, 'timer.worker')
    const pending = host.invoke('timer', REVISION, 'timer.worker', 'status')
    await new Promise(resolve => setImmediate(resolve))
    authority.publish?.([]) // update/remove: the row vanished
    await expect(pending).rejects.toThrow('updated or removed')
    expect(child.killed).toBe(true)
    host.dispose()
  })

  it('stop is graceful, idempotent, and reports stopped afterwards', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    await host.start('timer', REVISION, 'timer.worker')
    await host.stop('timer', REVISION, 'timer.worker')
    expect(child.received.some(message => message.kind === 'shutdown')).toBe(true)
    await expect(host.stop('timer', REVISION, 'timer.worker')).resolves.toBeUndefined()
    await expect(host.status('timer', REVISION, 'timer.worker')).resolves.toEqual({ state: 'stopped', serviceId: 'timer.worker' })
    host.dispose()
  })

  it('never launches through an entry that escapes the bundle via symlink', async () => {
    const dir = await bundle()
    const outside = await mkdtemp(join(tmpdir(), 'agent-code-service-outside-'))
    roots.push(outside)
    const target = join(outside, 'evil.js')
    await writeFile(target, 'module.exports = {}')
    await symlink(target, join(dir, 'linked.js'))
    ledgerWith(dir, 'linked.js')
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    // The manifest schema already rejects lexical escapes; this is the physical
    // flavor — a clean relative path whose target lives outside the bundle.
    await expect(host.start('timer', REVISION, 'timer.worker')).rejects.toThrow()
    expect(child.received).toEqual([])
    host.dispose()
  })

  it('a message the protocol does not define terminates the service', async () => {
    const dir = await bundle()
    ledgerWith(dir)
    const child = new FakeServiceProcess()
    const host = hostWith(child)
    await host.start('timer', REVISION, 'timer.worker')
    child.emit({ kind: 'exfiltrate', path: '/etc/passwd' })
    expect(child.killed).toBe(true)
    await expect(host.status('timer', REVISION, 'timer.worker')).resolves.toEqual({ state: 'stopped', serviceId: 'timer.worker' })
    host.dispose()
  })
})
