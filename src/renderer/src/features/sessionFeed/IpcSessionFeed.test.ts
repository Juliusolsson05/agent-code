import { beforeEach, describe, expect, it, vi } from 'vitest'

// IpcSessionFeed is a pure pass-through to the flat `window.api` preload
// bridge. These tests stub `window` BEFORE importing the module (node env,
// no happy-dom) and assert delegation — one listener and every command —
// because the whole value of the desktop feed is that it changes NOTHING
// about how the renderer talks to main. `vi.resetModules()` forces a fresh
// import per test so the module never captures a stale stub.

type AnyFn = (...args: unknown[]) => unknown
const listenerNames = [
  'onSessionStarted',
  'onSessionScreen',
  'onSessionJsonlEntries',
  'onSessionJsonlError',
  'onSessionSemanticEvent',
  'onSessionConditions',
  'onSessionProcessState',
  'onSessionSubAgents',
  'onSessionExit',
] as const

function stubWindowApi(): Record<string, AnyFn> {
  const api: Record<string, AnyFn> = {}
  for (const name of listenerNames) {
    api[name] = vi.fn(() => () => {})
  }
  api.sendInput = vi.fn(async () => true)
  api.deliverPrompt = vi.fn(async () => ({ ok: true as const }))
  api.resolveCondition = vi.fn(async () => ({ ok: true as const }))
  ;(globalThis as Record<string, unknown>).window = { api }
  return api
}

beforeEach(() => {
  vi.resetModules()
})

describe('IpcSessionFeed', () => {
  it('delegates every listener to the flat window.api surface', async () => {
    const api = stubWindowApi()
    const { ipcSessionFeed } = await import('./IpcSessionFeed')
    const cb = (): void => {}
    for (const name of listenerNames) {
      const unsub = (ipcSessionFeed as unknown as Record<string, AnyFn>)[name](cb)
      expect(api[name], name).toHaveBeenCalledWith(cb)
      expect(typeof unsub, `${name} unsub`).toBe('function')
    }
  })

  it('delegates sendInput with the pasteId passthrough', async () => {
    const api = stubWindowApi()
    const { ipcSessionFeed } = await import('./IpcSessionFeed')
    await ipcSessionFeed.sendInput('s1', 'hi', 'paste-1')
    expect(api.sendInput).toHaveBeenCalledWith('s1', 'hi', 'paste-1')
  })

  it('delegates deliverPrompt and resolveCondition', async () => {
    const api = stubWindowApi()
    const { ipcSessionFeed } = await import('./IpcSessionFeed')
    await ipcSessionFeed.deliverPrompt('s1', 'do the thing')
    expect(api.deliverPrompt).toHaveBeenCalledWith(
      's1',
      'do the thing',
      undefined,
      undefined,
    )
    const action = { kind: 'select-option', optionIndex: 0 } as never
    await ipcSessionFeed.resolveCondition('s1', action)
    expect(api.resolveCondition).toHaveBeenCalledWith('s1', action)
  })
})
