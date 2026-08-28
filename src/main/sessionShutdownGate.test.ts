import { describe, expect, it, vi } from 'vitest'

import { installSessionShutdownGate } from './sessionShutdownGate.js'

interface FakeWillQuitEvent {
  preventDefault(): void
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

function createFakeApp(): {
  app: Parameters<typeof installSessionShutdownGate>[0]['app']
  emitWillQuit: () => FakeWillQuitEvent
  emitWindowAllClosed: () => void
} {
  let willQuitListener: ((event: FakeWillQuitEvent) => void) | null = null
  let windowAllClosedListener: (() => void) | null = null
  const quit = vi.fn<() => void>()
  const app = {
    on: vi.fn((event: string, next: (...args: unknown[]) => void) => {
      if (event === 'will-quit') {
        willQuitListener = next as (event: FakeWillQuitEvent) => void
      } else if (event === 'window-all-closed') {
        windowAllClosedListener = next
      } else {
        throw new Error(`unexpected app event: ${event}`)
      }
    }),
    quit,
  } as unknown as Parameters<typeof installSessionShutdownGate>[0]['app']
  return {
    app,
    emitWillQuit: () => {
      if (!willQuitListener) throw new Error('will-quit listener was not installed')
      const event: FakeWillQuitEvent = { preventDefault: vi.fn() }
      willQuitListener(event)
      return event
    },
    emitWindowAllClosed: () => {
      if (!windowAllClosedListener) {
        throw new Error('window-all-closed listener was not installed')
      }
      windowAllClosedListener()
    },
  }
}

describe('installSessionShutdownGate', () => {
  it('leaves the manager usable when Keep Editing prevents will-quit', async () => {
    const fake = createFakeApp()
    const onQuitAllowed = vi.fn()
    let shuttingDown = false
    const manager = {
      killAll: vi.fn(async () => {
        shuttingDown = true
      }),
      recover: vi.fn(async () => {
        if (shuttingDown) throw new Error('manager is shutting down')
        return 'recovered'
      }),
    }

    const gate = installSessionShutdownGate({
      app: fake.app,
      getManager: () => manager,
      onQuitAllowed,
    })

    // This is the recorded Keep Editing path: before-quit happened elsewhere,
    // Chromium vetoed the unload, and Electron therefore never emits will-quit.
    await expect(manager.recover()).resolves.toBe('recovered')
    expect(manager.killAll).not.toHaveBeenCalled()
    expect(fake.app.quit).not.toHaveBeenCalled()
    expect(onQuitAllowed).not.toHaveBeenCalled()
    expect(gate.isTerminalShutdownAdmitted()).toBe(false)
  })

  it('awaits one terminal teardown before allowing the re-entered quit', async () => {
    const fake = createFakeApp()
    const teardown = deferred()
    const manager = { killAll: vi.fn(() => teardown.promise) }
    const onQuitAllowed = vi.fn()

    installSessionShutdownGate({ app: fake.app, getManager: () => manager, onQuitAllowed })

    const first = fake.emitWillQuit()
    const duplicate = fake.emitWillQuit()
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(duplicate.preventDefault).toHaveBeenCalledOnce()
    expect(manager.killAll).toHaveBeenCalledOnce()
    expect(fake.app.quit).not.toHaveBeenCalled()

    teardown.resolve()
    await teardown.promise
    await Promise.resolve()

    expect(fake.app.quit).toHaveBeenCalledOnce()
    expect(onQuitAllowed).not.toHaveBeenCalled()
    const reentered = fake.emitWillQuit()
    expect(reentered.preventDefault).not.toHaveBeenCalled()
    expect(manager.killAll).toHaveBeenCalledOnce()
    expect(onQuitAllowed).toHaveBeenCalledOnce()
  })

  it('routes non-macOS last-window quit through the sole terminal teardown', async () => {
    const fake = createFakeApp()
    const teardown = deferred()
    const manager = { killAll: vi.fn(() => teardown.promise) }
    const onLastWindowClosed = vi.fn()

    installSessionShutdownGate({
      app: fake.app,
      getManager: () => manager,
      onQuitAllowed: vi.fn(),
      platform: 'linux',
      onLastWindowClosed,
    })

    fake.emitWindowAllClosed()
    expect(onLastWindowClosed).toHaveBeenCalledOnce()
    expect(fake.app.quit).toHaveBeenCalledOnce()
    expect(manager.killAll).not.toHaveBeenCalled()

    const first = fake.emitWillQuit()
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(manager.killAll).toHaveBeenCalledOnce()

    teardown.resolve()
    await teardown.promise
    await Promise.resolve()
    expect(fake.app.quit).toHaveBeenCalledTimes(2)
  })

  it('keeps macOS last-window closure outside application teardown', () => {
    const fake = createFakeApp()
    const manager = { killAll: vi.fn(async () => undefined) }
    const onLastWindowClosed = vi.fn()

    installSessionShutdownGate({
      app: fake.app,
      getManager: () => manager,
      onQuitAllowed: vi.fn(),
      platform: 'darwin',
      onLastWindowClosed,
    })

    fake.emitWindowAllClosed()
    expect(onLastWindowClosed).not.toHaveBeenCalled()
    expect(fake.app.quit).not.toHaveBeenCalled()
    expect(manager.killAll).not.toHaveBeenCalled()
  })

  it('latches terminal admission before a slow teardown can admit macOS activation', () => {
    const fake = createFakeApp()
    const teardown = deferred()
    const manager = { killAll: vi.fn(() => teardown.promise) }
    const gate = installSessionShutdownGate({
      app: fake.app,
      getManager: () => manager,
      onQuitAllowed: vi.fn(),
      platform: 'darwin',
    })
    const createWindow = vi.fn()
    const activateWithoutWindows = (): void => {
      if (!gate.isTerminalShutdownAdmitted()) createWindow()
    }

    // Activation is still valid before will-quit, including when an earlier
    // renderer veto means terminal teardown was never admitted.
    activateWithoutWindows()
    expect(createWindow).toHaveBeenCalledOnce()
    createWindow.mockClear()

    fake.emitWillQuit()
    expect(gate.isTerminalShutdownAdmitted()).toBe(true)
    activateWithoutWindows()
    expect(createWindow).not.toHaveBeenCalled()
    expect(fake.app.quit).not.toHaveBeenCalled()
  })
})
