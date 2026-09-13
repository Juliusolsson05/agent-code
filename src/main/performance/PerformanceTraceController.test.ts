import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tracing = vi.hoisted(() => ({
  categories: vi.fn(async () => ['electron', 'toplevel', 'gpu']),
  start: vi.fn(async () => {}),
  stop: vi.fn(async (path: string) => path),
}))
const inspector = vi.hoisted(() => ({
  connect: vi.fn(), disconnect: vi.fn(),
  post: vi.fn((method: string, callback: (error: Error | null, result?: Record<string, unknown>) => void) => {
    callback(null, method === 'Profiler.stop' ? { profile: { nodes: [], samples: [] } } : {})
  }),
}))
vi.mock('electron', () => ({ contentTracing: { getCategories: tracing.categories, startRecording: tracing.start, stopRecording: tracing.stop } }))
vi.mock('node:inspector', () => ({ Session: class {
  connect = inspector.connect
  disconnect = inspector.disconnect
  post = inspector.post
} }))

import { PerformanceTraceController } from './PerformanceTraceController.js'

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('explicit performance trace ownership', () => {
  it('keeps one owner, uses filtered bounded Chromium options and saves the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-trace-'))
    roots.push(root)
    const destination = join(root, 'trace.json')
    tracing.stop.mockImplementationOnce(async path => { await writeFile(path, '{"traceEvents":[]}'); return path })
    const controller = new PerformanceTraceController()

    expect(await controller.start(7, 'chromium', destination, 30_000)).toMatchObject({ state: 'recording', ownerWindowId: 7 })
    expect(tracing.start).toHaveBeenCalledWith(expect.objectContaining({
      included_categories: ['electron', 'toplevel', 'gpu'], enable_argument_filter: true,
      recording_mode: 'record-until-full', trace_buffer_size_in_kb: 60 * 1024,
    }))
    expect(await controller.start(8, 'main-cpu', join(root, 'other.json'))).toMatchObject({ state: 'recording', ownerWindowId: 7 })
    expect(await controller.stop(8, false)).toMatchObject({ state: 'recording' })
    expect(await controller.stop(7, false)).toMatchObject({ state: 'complete', path: destination, bytes: 18 })
    expect(await readFile(destination, 'utf8')).toBe('{"traceEvents":[]}')
  })

  it('cancels a start that finishes after its owner closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-trace-'))
    roots.push(root)
    const destination = join(root, 'trace.json')
    let release!: () => void
    tracing.start.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    tracing.stop.mockImplementationOnce(async path => { await writeFile(path, '{}'); return path })
    const controller = new PerformanceTraceController()
    const starting = controller.start(9, 'chromium', destination)
    await vi.waitFor(() => expect(tracing.start).toHaveBeenCalledOnce())
    await controller.cancelOwner(9)
    release()
    expect(await starting).toMatchObject({ state: 'cancelled' })
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('records a separate bounded main-process CPU profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-trace-'))
    roots.push(root)
    const destination = join(root, 'main.cpuprofile')
    const controller = new PerformanceTraceController()

    expect(await controller.start(11, 'main-cpu', destination)).toMatchObject({ state: 'recording' })
    expect(inspector.post.mock.calls.map(call => call[0])).toEqual(['Profiler.enable', 'Profiler.start'])
    expect(await controller.stop(11, false)).toMatchObject({ state: 'complete', ownerWindowId: 11, path: destination })
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual({ nodes: [], samples: [] })
  })
})
