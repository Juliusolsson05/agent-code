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

// The addon surface this module relies on is deliberately small: construct,
// activate (via terminal.loadAddon), dispose, onContextLoss. The 0.19.0 atlas
// bridge (texture-atlas events + a private invalidateTextureBindings seam) was
// removed with the move to the 0.20.0 beta line that fixes the atlas upstream
// (xterm.js #5883), so the harness no longer models it.
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

function terminalHarness() {
  return { loadAddon: vi.fn() }
}

describe('xtermWebglRenderer', () => {
  it('reports readiness after handing a complete addon to the live terminal', async () => {
    const addon = addonHarness()
    const terminal = terminalHarness()
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: async () => addon, enabled: true })

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
    const renderer = attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => addon, enabled: true })
    await expect(renderer.ready).resolves.toBe(true)

    renderer.dispose()
    renderer.dispose()

    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('loads WebGL into a live terminal and falls back by disposing it on context loss', async () => {
    const addon = addonHarness()
    const terminal = terminalHarness()
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: async () => addon, enabled: true })

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
    const terminal = terminalHarness()
    const load = vi.fn(() => pending.promise)
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: load, enabled: true })
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
      const terminal = terminalHarness()
      const load = () => {
        if (failure === 'synchronous throw') throw new Error('loader unavailable')
        return Promise.reject(new Error('chunk unavailable'))
      }
      // Optional GPU support must neither throw from attachment nor reject
      // ready: both turn recoverable renderer failures into broken terminals.
      const renderer = attachXtermWebglRenderer(terminal, { loadAddon: load, enabled: true })
      await expect(renderer.ready).resolves.toBe(false)
      expect(terminal.loadAddon).not.toHaveBeenCalled()
      expect(() => renderer.dispose()).not.toThrow()
    },
  )

  it('resolves false when construction fails without disposing an unowned addon', async () => {
    const addon = addonHarness()
    addon.construct.mockImplementation(() => { throw new Error('unsupported GPU') })
    const terminal = terminalHarness()
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: async () => addon, enabled: true })

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
      ...terminalHarness(),
      loadAddon: vi.fn(() => { throw new Error('context allocation failed') }),
    }
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: async () => addon, enabled: true })

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
    const terminal = terminalHarness()
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: async () => addon, enabled: true })

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
    const renderer = attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => addon, enabled: true })
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
    const renderer = attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => addon, enabled: true })
    await expect(renderer.ready).resolves.toBe(true)

    renderer.dispose()

    expect(addon.disposeContextListener).toHaveBeenCalledTimes(1)
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('asks the host to refit after WebGL takes over and again after a context-loss fallback', async () => {
    // WebGL floors the device cell width, the DOM renderer keeps it
    // fractional, so the same cols need a different width on each. A grid
    // fitted under one renderer is wrong under the other: under-filled after
    // the DOM -> WebGL upgrade, CLIPPED by the host's overflow-hidden after a
    // WebGL -> DOM fallback (PR #873 review). The hosts' ResizeObservers watch
    // the outer container, which does not change size when only the renderer
    // does, so the wrapper must say when it happened.
    const addon = addonHarness()
    const onRendererChange = vi.fn()
    const renderer = attachXtermWebglRenderer(terminalHarness(), {
      loadAddon: async () => addon,
      enabled: true,
      onRendererChange,
    })

    await expect(renderer.ready).resolves.toBe(true)
    expect(onRendererChange).toHaveBeenCalledTimes(1)

    addon.loseContext()
    expect(onRendererChange).toHaveBeenCalledTimes(2)
    // The fallback's addon disposal must have happened BEFORE the host is
    // told, or its refit would measure the renderer that is being removed.
    expect(addon.disposeAddon.mock.invocationCallOrder[0])
      .toBeLessThan(onRendererChange.mock.invocationCallOrder[1]!)
    renderer.dispose()
    expect(onRendererChange).toHaveBeenCalledTimes(2)
  })

  it('never asks for a refit when the renderer did not change or the host is gone', async () => {
    const onRendererChange = vi.fn()

    // Explicitly disabled: the DOM renderer stays, nothing changed.
    await attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => addonHarness(), enabled: false, onRendererChange }).ready

    // Construction failed: the DOM renderer stays, nothing changed.
    const broken = addonHarness()
    broken.construct.mockImplementation(() => { throw new Error('unsupported GPU') })
    await attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => broken, enabled: true, onRendererChange }).ready

    // Import resolved after teardown: the host is gone; a refit would touch
    // a disposed terminal.
    const pending = deferred<ReturnType<typeof addonHarness>>()
    const late = attachXtermWebglRenderer(terminalHarness(), { loadAddon: () => pending.promise, enabled: true, onRendererChange })
    await Promise.resolve()
    late.dispose()
    pending.resolve(addonHarness())
    await late.ready

    // Ordinary unmount after a successful attach: the host is tearing down,
    // not changing renderer, and a queued context-loss event must stay inert.
    const addon = addonHarness()
    const liveRefit = vi.fn()
    const live = attachXtermWebglRenderer(terminalHarness(), { loadAddon: async () => addon, enabled: true, onRendererChange: liveRefit })
    await live.ready
    expect(liveRefit).toHaveBeenCalledTimes(1) // the DOM -> WebGL upgrade itself
    live.dispose()
    addon.loseContext()
    expect(liveRefit).toHaveBeenCalledTimes(1)

    expect(onRendererChange).not.toHaveBeenCalled()
  })

  it('attaches the GPU renderer by default', async () => {
    // Pins the WEBGL_RENDERER_ENABLED decision (#871). WebGL was off from
    // 2026-09-08 because addon-webgl 0.19.0 corrupts its texture atlas under
    // streaming TUI output; the fix (xterm.js #5883) ships on the 0.20.0 beta
    // line, which this app now pins — the same line VS Code ships. If this case
    // starts failing, someone flipped the switch back off: that is the
    // documented rollback for renderer corruption, so make sure it was
    // deliberate and that #871's soak findings are recorded.
    const addon = addonHarness()
    const terminal = terminalHarness()
    const load = vi.fn(async () => addon)

    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: load })

    await expect(renderer.ready).resolves.toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1)
    renderer.dispose()
    expect(addon.disposeAddon).toHaveBeenCalledTimes(1)
  })

  it('costs nothing when explicitly disabled: no import, no addon, safe to dispose', async () => {
    // The switch is also the rollback, so the off path must stay cheap and
    // safe: not merely inactive but never importing the addon module (no
    // parse, no GPU context, no listeners), and disposable unconditionally —
    // every call site disposes on unmount whether or not WebGL attached.
    const terminal = terminalHarness()
    const load = vi.fn(async () => addonHarness())
    const renderer = attachXtermWebglRenderer(terminal, { loadAddon: load, enabled: false })

    await expect(renderer.ready).resolves.toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(terminal.loadAddon).not.toHaveBeenCalled()
    expect(() => renderer.dispose()).not.toThrow()
  })
})
