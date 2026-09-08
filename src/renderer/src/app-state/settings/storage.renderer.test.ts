import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSettingsStorage } from './storage'

// WHY this suite exists at all:
//
// createSettingsStorage's "storage is unavailable" guard only caught a THROWN
// access, which is the browser storage-denied case. It did not catch storage
// being merely absent — which is exactly what the renderer test environment
// provides. The adapter was therefore handed out live, and every store write
// died inside Zustand's persist middleware with "storage.setItem is not a
// function". Seven agent-name reconciler tests failed that way from the day
// they landed, and any future renderer test that writes a setting would have
// joined them. These cases pin the guard so that cannot silently return.

const original = Object.getOwnPropertyDescriptor(window, 'localStorage')

function stubStorage(value: unknown): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value })
}

afterEach(() => {
  if (original) Object.defineProperty(window, 'localStorage', original)
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'localStorage')
})

describe('createSettingsStorage', () => {
  it('returns undefined when storage is absent, rather than a broken adapter', () => {
    stubStorage(undefined)
    expect(createSettingsStorage()).toBeUndefined()
  })

  it('returns undefined when storage exists but is not a usable Storage', () => {
    // The shape that actually shipped: present enough to pass a truthiness
    // check, useless the moment persist calls it.
    stubStorage({})
    expect(createSettingsStorage()).toBeUndefined()
  })

  it('returns undefined when only some Storage methods are present', () => {
    stubStorage({ getItem: () => null, setItem: () => {} })
    expect(createSettingsStorage()).toBeUndefined()
  })

  it('returns undefined when the access itself throws', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied by policy') },
    })
    expect(createSettingsStorage()).toBeUndefined()
  })

  it('writes through to a usable Storage', () => {
    const setItem = vi.fn()
    stubStorage({ getItem: vi.fn(() => null), setItem, removeItem: vi.fn() })
    const adapter = createSettingsStorage()
    expect(adapter).toBeDefined()

    adapter?.setItem('agent-code', { version: 1, state: { settings: { a: 1 } } } as never)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem.mock.calls[0][0]).toBe('agent-code')
  })

  it('skips a repeat write of the same settings object', () => {
    // The whole reason this adapter exists instead of createJSONStorage:
    // persist runs after EVERY action, including stream ticks that never
    // touch settings.
    const setItem = vi.fn()
    stubStorage({ getItem: vi.fn(() => null), setItem, removeItem: vi.fn() })
    const adapter = createSettingsStorage()
    const settings = { a: 1 }

    adapter?.setItem('agent-code', { version: 1, state: { settings } } as never)
    adapter?.setItem('agent-code', { version: 1, state: { settings } } as never)
    expect(setItem).toHaveBeenCalledTimes(1)
  })
})
