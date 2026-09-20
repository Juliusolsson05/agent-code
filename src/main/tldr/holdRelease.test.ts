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
    expect(release).toHaveBeenCalledExactlyOnceWith('released')
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
    // A packaging failure says NOTHING about the keyboard, so it must not
    // masquerade as one — it would latch a peek on every machine that is
    // merely missing the binary.
    expect(release).toHaveBeenCalledWith('released')
    expect(start).not.toHaveBeenCalled()
  })

  // #1066: `keyState` answers false both for "that key is up" and for "this
  // process cannot see the keyboard". The helper tells them apart by asking
  // about Command — down by construction whenever a watcher starts — and
  // reports the blind case as exit 67. Collapsing the two is what made the
  // peek flash and vanish with no explanation on every freshly signed build.
  it('reports an unobservable keyboard distinctly from a real release', async () => {
    const { child, start } = processHarness()
    const release = vi.fn()
    const stop = watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
    await Promise.resolve()
    child.emit('exit', 67)
    expect(release).toHaveBeenCalledExactlyOnceWith('unobservable')
    stop()
  })

  it('treats every OTHER exit code as an ordinary release', async () => {
    // 65 (unsupported keycode) and a null code (killed by a signal) are not
    // evidence about the keyboard. Only 67 is.
    for (const code of [0, 1, 65, 66, null]) {
      const { child, start } = processHarness()
      const release = vi.fn()
      watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
      await Promise.resolve()
      child.emit('exit', code)
      expect(release, `exit ${String(code)}`).toHaveBeenCalledExactlyOnceWith('released')
    }
  })

  it('a spawn error is a release, never a keyboard verdict', async () => {
    // ENOENT/EACCES on the helper is the packaging failure the code's own
    // comment names. Reporting it as 'unobservable' would change how the peek
    // behaves on every machine merely missing the binary.
    const { child, start } = processHarness()
    const release = vi.fn()
    const stop = watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
    await Promise.resolve()
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    expect(release).toHaveBeenCalledExactlyOnceWith('released')
    stop()
  })

  it('an unmappable keycode is a release, never a keyboard verdict', async () => {
    // A chord rebound outside `macKeyCodes` never reaches the helper at all,
    // so it says nothing about whether the keyboard can be seen.
    const { start } = processHarness()
    const release = vi.fn()
    watchMacTldrRelease(Promise.resolve('/helper'), 'F13', release, start)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(release).toHaveBeenCalledWith('released')
    expect(start).not.toHaveBeenCalled()
  })

  it('still ends the hold exactly once when an unobservable exit races teardown', async () => {
    // The never-stuck invariant is unchanged by the new reason.
    const { child, start } = processHarness()
    const release = vi.fn()
    const stop = watchMacTldrRelease(Promise.resolve('/helper'), 'KeyL', release, start)
    await Promise.resolve()
    child.emit('exit', 67)
    child.emit('exit', 0)
    child.emit('error', new Error('late'))
    stop()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
