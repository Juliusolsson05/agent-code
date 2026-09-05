import { describe, expect, it, vi } from 'vitest'

import { attachXtermWebglRenderer } from './xtermWebglRenderer'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>(done => { resolve = done }),
    resolve,
  }
}

function addonHarness() {
  let loseContext: (() => void) | null = null
  const construct = vi.fn()
  const activate = vi.fn()
  const disposeContextListener = vi.fn()
  const disposeAddon = vi.fn()
  const onContextLoss = vi.fn((handler: () => void) => {
    loseContext = handler
    return { dispose: disposeContextListener }
  })
  // Keep a real constructor: vi.fn(class) is not constructible on every Vitest
  // version. That failure silently exercises fallback in success-path tests.
  class WebglAddon {
    constructor() { construct() }
    activate = activate
    dispose = disposeAddon
    onContextLoss = onContextLoss
  }
  return {
    WebglAddon,
    construct,
    activate,
    onContextLoss,
    disposeAddon,
    disposeContextListener,
    loseContext: () => loseContext?.(),
  }
}

describe('xtermWebglRenderer', () => {
  it('reports readiness after handing a complete addon to the live terminal', async () => {
    const addon = addonHarness()
    const terminal = { loadAddon: vi.fn() }
    const renderer = attachXtermWebglRenderer(terminal, async () => addon)

    await expect(renderer.ready).resolves.toBe(true)
    expect(addon.construct).toHaveBeenCalledTimes(1)
    expect(addon.onContextLoss).toHaveBeenCalledTimes(1)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(terminal.loadAddon).toHaveBeenCalledWith(expect.any(addon.WebglAddon))
    expect(terminal.loadAddon.mock.calls[0][0]).toEqual(expect.objectContaining({
      activate: addon.activate,
      dispose: addon.disposeAddon,
    }))
    expect(addon.disposeContextListener).not.toHaveBeenCalled()
    expect(addon.disposeAddon).not.toHaveBeenCalled()
    renderer.dispose()
  })

  it('disposes the context listener and addon exactly once during ordinary host teardown', async () => {
    const addon = addonHarness()
    const renderer = attachXtermWebglRenderer({ loadAddon: vi.fn() }, async () => addon)
    await expect(renderer.ready).resolves.toBe(true)

    renderer.dispose()
    renderer.dispose()

    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('loads WebGL into a live terminal and falls back by disposing it on context loss', async () => {
    const addon = addonHarness()
    const terminal = { loadAddon: vi.fn() }
    const renderer = attachXtermWebglRenderer(terminal, async () => addon)

    await expect(renderer.ready).resolves.toBe(true)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)

    addon.loseContext()
    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)

    // A queued GPU event can outlive listener removal. It must not reacquire a
    // context or tear down the already-restored fallback during pane unmount.
    addon.loseContext()
    renderer.dispose()
    expect(addon.construct).toHaveBeenCalledTimes(1)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('does not attach an addon whose import resolves after host teardown', async () => {
    const pending = deferred<ReturnType<typeof addonHarness>>()
    const terminal = { loadAddon: vi.fn() }
    const load = vi.fn(() => pending.promise)
    const renderer = attachXtermWebglRenderer(terminal, load)
    // Fence a genuinely in-flight import, not only a loader that never started.
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    renderer.dispose()

    const addon = addonHarness()
    pending.resolve(addon)
    await expect(renderer.ready).resolves.toBe(false)
    expect(addon.construct).not.toHaveBeenCalled()
    expect(terminal.loadAddon).not.toHaveBeenCalled()
    expect(addon.disposeAddon).not.toHaveBeenCalled()
  })

  it.each(['rejection', 'synchronous throw'] as const)(
    'keeps fallback usable after an import %s',
    async failure => {
      const terminal = { loadAddon: vi.fn() }
      const load = () => {
        if (failure === 'synchronous throw') throw new Error('loader unavailable')
        return Promise.reject(new Error('chunk unavailable'))
      }
      // Optional GPU support must neither throw from attachment nor reject
      // ready: both turn recoverable renderer failures into broken terminals.
      const renderer = attachXtermWebglRenderer(terminal, load)
      await expect(renderer.ready).resolves.toBe(false)
      expect(terminal.loadAddon).not.toHaveBeenCalled()
      expect(() => renderer.dispose()).not.toThrow()
    },
  )

  it('resolves false when construction fails without disposing an unowned addon', async () => {
    const addon = addonHarness()
    addon.construct.mockImplementation(() => { throw new Error('unsupported GPU') })
    const terminal = { loadAddon: vi.fn() }
    const renderer = attachXtermWebglRenderer(terminal, async () => addon)

    await expect(renderer.ready).resolves.toBe(false)
    renderer.dispose()
    expect(addon.construct).toHaveBeenCalledTimes(1)
    expect(addon.onContextLoss).not.toHaveBeenCalled()
    expect(terminal.loadAddon).not.toHaveBeenCalled()
    expect(addon.disposeContextListener).not.toHaveBeenCalled()
    expect(addon.disposeAddon).not.toHaveBeenCalled()
  })

  it('cleans both owned resources when terminal activation fails', async () => {
    const addon = addonHarness()
    const terminal = {
      loadAddon: vi.fn(() => { throw new Error('context allocation failed') }),
    }
    const renderer = attachXtermWebglRenderer(terminal, async () => addon)

    await expect(renderer.ready).resolves.toBe(false)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)
    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
    renderer.dispose()
    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('disposes the constructed addon when context listener registration fails', async () => {
    const addon = addonHarness()
    addon.onContextLoss.mockImplementation(() => { throw new Error('registration failed') })
    const terminal = { loadAddon: vi.fn() }
    const renderer = attachXtermWebglRenderer(terminal, async () => addon)

    await expect(renderer.ready).resolves.toBe(false)
    renderer.dispose()
    expect(terminal.loadAddon).not.toHaveBeenCalled()
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
    expect(addon.disposeContextListener).not.toHaveBeenCalled()
  })

  it('allows host cleanup to finish even when both third-party disposers throw', async () => {
    const addon = addonHarness()
    addon.disposeContextListener.mockImplementation(() => { throw new Error('listener cleanup failed') })
    addon.disposeAddon.mockImplementation(() => { throw new Error('GPU cleanup failed') })
    const renderer = attachXtermWebglRenderer({ loadAddon: vi.fn() }, async () => addon)
    await expect(renderer.ready).resolves.toBe(true)
    const disposeHost = vi.fn()

    // The wrapper is disposed before xterm and PTY subscriptions. Escaping
    // addon errors would skip later host cleanup and leak entire terminal panes.
    expect(() => {
      renderer.dispose()
      disposeHost()
    }).not.toThrow()
    renderer.dispose()
    expect(disposeHost).toHaveBeenCalledTimes(1)
    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('clears ownership before a disposer re-enters context-loss cleanup', async () => {
    const addon = addonHarness()
    addon.disposeContextListener.mockImplementation(() => addon.loseContext())
    const renderer = attachXtermWebglRenderer({ loadAddon: vi.fn() }, async () => addon)
    await expect(renderer.ready).resolves.toBe(true)

    renderer.dispose()

    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })
})
