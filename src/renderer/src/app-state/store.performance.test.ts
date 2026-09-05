import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_STORE_STORAGE_KEY } from '@renderer/app-state/localStorageMigration'
import type { AppStore } from '@renderer/app-state/types'

function createStorageMock(): {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
  removeItem: ReturnType<typeof vi.fn<(key: string) => void>>
} {
  const data = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
  }
}

let storage: ReturnType<typeof createStorageMock>

beforeEach(() => {
  // Persistence owns an identity cache for this store instance. Reset modules
  // along with storage so a preceding test cannot accidentally prime its cache.
  vi.resetModules()
  storage = createStorageMock()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function persistedStore(): Promise<typeof import('./store')['useAppStore']> {
  const { useAppStore } = await import('./store')
  useAppStore.getState().setSettings({ showStatusMode: false })
  expect(storage.setItem).toHaveBeenCalled()
  storage.setItem.mockClear()
  return useAppStore
}

describe('settings persistence work budget', () => {
  it('does not serialize or write unchanged settings during real workspace and UI updates', async () => {
    const store = await persistedStore()
    const settings = store.getState().settings
    const stringify = vi.spyOn(JSON, 'stringify')

    // Skipping setItem after comparing serialized strings would save disk work
    // but still stringify all settings on every terminal frame. The byte
    // production itself must disappear, even when the rest of the store changes.
    for (let index = 0; index < 25; index += 1) {
      store.getState().setWorkspaceRuntimes(previous => ({ ...previous }))
      store.getState().setWorkspaceState(previous => ({ ...previous }))
      store.getState().openCommandPalette()
      store.getState().closeCommandPalette()
    }

    expect(store.getState().settings).toBe(settings)
    expect(stringify).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('writes changed settings immediately with the existing storage envelope and version', async () => {
    const store = await persistedStore()
    store.getState().setSettings({ showStatusMode: true })

    expect(storage.setItem).toHaveBeenCalledTimes(1)
    const [name, raw] = storage.setItem.mock.calls[0]!
    expect(name).toBe(APP_STORE_STORAGE_KEY)
    expect(JSON.parse(raw)).toEqual({ state: { settings: store.getState().settings }, version: 10 })
    store.getState().openCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('retries a failed settings write on the next unrelated update', async () => {
    const store = await persistedStore()
    const durableBeforeFailure = storage.getItem(APP_STORE_STORAGE_KEY)
    storage.setItem.mockImplementationOnce(() => { throw new Error('storage temporarily unavailable') })

    // Zustand may propagate a synchronous storage failure after updating its
    // in-memory state. Whether callers handle that error is separate from the
    // durability invariant: the failed settings reference must remain retryable.
    try {
      store.getState().setSettings({ showStatusMode: true })
    } catch {
      // The retry below is deliberately driven by ordinary store traffic.
    }
    expect(store.getState().settings.showStatusMode).toBe(true)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.getItem(APP_STORE_STORAGE_KEY)).toBe(durableBeforeFailure)

    store.getState().openCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.getItem(APP_STORE_STORAGE_KEY)!)).toMatchObject({
      state: { settings: { showStatusMode: true } },
    })
    store.getState().closeCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
  })

  it('persists unchanged settings again after clearStorage removes the durable copy', async () => {
    const store = await persistedStore()
    const settings = store.getState().settings
    store.persist.clearStorage()
    expect(storage.getItem(APP_STORE_STORAGE_KEY)).toBeNull()
    store.getState().openCommandPalette()
    expect(store.getState().settings).toBe(settings)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(APP_STORE_STORAGE_KEY)!)).toEqual({
      state: { settings }, version: 10,
    })
  })

  it('invalidates a successful write when persistence reads storage again', async () => {
    const store = await persistedStore()
    const settings = store.getState().settings
    const adapter = store.persist.getOptions().storage!
    await adapter.getItem(APP_STORE_STORAGE_KEY)
    store.getState().openCommandPalette()

    // Test the read boundary without a merge changing settings identity: a
    // same-version rehydrate also creates a coerced object and would otherwise
    // let a broken read-invalidation implementation pass accidentally.
    expect(store.getState().settings).toBe(settings)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    store.getState().closeCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('rehydrates externally changed settings and persists the hydrated state on the next update', async () => {
    const store = await persistedStore()
    storage.setItem(APP_STORE_STORAGE_KEY, JSON.stringify({
      state: { settings: { ...store.getState().settings, showStatusMode: true } }, version: 10,
    }))
    storage.setItem.mockClear()
    await store.persist.rehydrate()
    expect(store.getState().settings.showStatusMode).toBe(true)
    store.getState().openCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(APP_STORE_STORAGE_KEY)!)).toMatchObject({
      state: { settings: { showStatusMode: true } }, version: 10,
    })
  })

  it('does not reuse a settings cache across a storage key or schema version change', async () => {
    const store = await persistedStore()
    const settings = store.getState().settings
    const nextKey = `${APP_STORE_STORAGE_KEY}:alternate`
    store.persist.setOptions({ name: nextKey })
    store.getState().openCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getItem(nextKey)!)).toEqual({ state: { settings }, version: 10 })
    store.persist.setOptions({ version: 11 })
    store.getState().closeCommandPalette()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.getItem(nextKey)!)).toEqual({ state: { settings }, version: 11 })
  })
})

type WorkspaceUpdateCase = {
  name: string
  directNoop: (state: AppStore) => void
  updaterNoop: (state: AppStore) => void
  change: (state: AppStore) => void
  value: (state: AppStore) => unknown
}

const workspaceCases: WorkspaceUpdateCase[] = [
  {
    name: 'state',
    directNoop: state => state.setWorkspaceState(state.workspaceState),
    updaterNoop: state => state.setWorkspaceState(previous => previous),
    change: state => state.setWorkspaceState(previous => ({ ...previous, activeTabId: 'changed-tab' })),
    value: state => state.workspaceState,
  },
  {
    name: 'runtimes',
    directNoop: state => state.setWorkspaceRuntimes(state.workspaceRuntimes),
    updaterNoop: state => state.setWorkspaceRuntimes(previous => previous),
    change: state => state.setWorkspaceRuntimes(previous => ({ ...previous })),
    value: state => state.workspaceRuntimes,
  },
  {
    name: 'spotlight',
    directNoop: state => state.setWorkspaceSpotlight(state.workspaceSpotlight),
    updaterNoop: state => state.setWorkspaceSpotlight(previous => previous),
    change: state => state.setWorkspaceSpotlight({ tabId: 'tab', focusedSessionId: 'session' }),
    value: state => state.workspaceSpotlight,
  },
  {
    name: 'readerMode',
    directNoop: state => state.setWorkspaceReaderMode(state.workspaceReaderMode),
    updaterNoop: state => state.setWorkspaceReaderMode(previous => previous),
    change: state => state.setWorkspaceReaderMode({ tabId: 'tab', focusedSessionId: 'session' }),
    value: state => state.workspaceReaderMode,
  },
  {
    name: 'tileTabs',
    directNoop: state => state.setWorkspaceTileTabs(state.workspaceTileTabs),
    updaterNoop: state => state.setWorkspaceTileTabs(previous => previous),
    change: state => state.setWorkspaceTileTabs({
      tabIds: ['tab-a', 'tab-b'], focusedTabId: 'tab-a', direction: 'horizontal', ratios: [0.5, 0.5],
    }),
    value: state => state.workspaceTileTabs,
  },
]

describe('workspace setter notification isolation', () => {
  it.each(workspaceCases)('preserves the root on $name no-ops and notifies for a real change', async entry => {
    const store = await persistedStore()
    const before = store.getState()
    const notify = vi.fn()
    const unsubscribe = store.subscribe(notify)
    try {
      entry.directNoop(store.getState())
      entry.updaterNoop(store.getState())
      expect(store.getState()).toBe(before)
      expect(notify).not.toHaveBeenCalled()
      expect(storage.setItem).not.toHaveBeenCalled()

      // A new runtime map is a real change even when it happens to be empty.
      // The optimization must preserve Object.is semantics, not add expensive
      // deep comparisons that might suppress legitimate snapshot replacement.
      entry.change(store.getState())
      const changed = store.getState()
      expect(changed).not.toBe(before)
      expect(entry.value(changed)).not.toBe(entry.value(before))
      expect(notify).toHaveBeenCalledExactlyOnceWith(changed, before)
      notify.mockClear()
      entry.directNoop(store.getState())
      entry.updaterNoop(store.getState())
      expect(store.getState()).toBe(changed)
      expect(notify).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })
})
