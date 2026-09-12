import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { watchMacTldrRelease } from './holdRelease'

function processHarness() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  const start = vi.fn(() => child as unknown as ChildProcess)
  return { child, start }
}

describe('macOS TLDR release observation', () => {
  it('ends once when the physical key is released, even without a browser keyup', async () => {
    const { child, start } = processHarness()
    const release = vi.fn()
    const stop = watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
    await Promise.resolve()
    expect(start).toHaveBeenCalledWith('/helper', ['--watch-release', '37'])
    child.emit('exit', 0)
    child.emit('error', new Error('late teardown'))
    expect(release).toHaveBeenCalledTimes(1)
    stop()
  })

  it('never starts a stale observer after cancellation during helper resolution', async () => {
    let resolve!: (path: string) => void
    const binary = new Promise<string>(done => { resolve = done })
    const { start } = processHarness()
    const release = vi.fn()
    watchMacTldrRelease(binary, 'KeyL', release, start)()
    resolve('/helper')
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('kills an active observer on blur/release and ignores its late exit', async () => {
    const { child, start } = processHarness()
    const release = vi.fn()
    const stop = watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
    await Promise.resolve()
    stop()
    child.emit('exit', 0)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
  })

  it('dismisses rather than stranding the preview on missing native support', async () => {
    const { start } = processHarness()
    const release = vi.fn()
    watchMacTldrRelease(Promise.reject(new Error('missing executable')), 'KeyL', release, start)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(start).not.toHaveBeenCalled()
  })
})
