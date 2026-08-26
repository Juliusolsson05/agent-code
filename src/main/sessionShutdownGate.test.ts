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
  app: {
    on: (event: 'will-quit', listener: (event: FakeWillQuitEvent) => void) => void
    quit: () => void
  }
  emitWillQuit: () => FakeWillQuitEvent
} {
  let listener: ((event: FakeWillQuitEvent) => void) | null = null
  const quit = vi.fn<() => void>()
  const app = {
    on: vi.fn((event: 'will-quit', next: (event: FakeWillQuitEvent) => void) => {
      expect(event).toBe('will-quit')
      listener = next
    }),
    quit,
  }
  return {
    app,
    emitWillQuit: () => {
      if (!listener) throw new Error('will-quit listener was not installed')
      const event: FakeWillQuitEvent = { preventDefault: vi.fn() }
      listener(event)
      return event
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

    installSessionShutdownGate({ app: fake.app, getManager: () => manager, onQuitAllowed })

    // This is the recorded Keep Editing path: before-quit happened elsewhere,
    // Chromium vetoed the unload, and Electron therefore never emits will-quit.
    await expect(manager.recover()).resolves.toBe('recovered')
    expect(manager.killAll).not.toHaveBeenCalled()
    expect(fake.app.quit).not.toHaveBeenCalled()
    expect(onQuitAllowed).not.toHaveBeenCalled()
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
})
