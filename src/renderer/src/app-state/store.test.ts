import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APP_STORE_STORAGE_KEY,
  PROMPT_TEMPLATES_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'

type StorageMock = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
}

function createStorageMock(seed: Record<string, string> = {}): StorageMock {
  const data = new Map(Object.entries(seed))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: key => {
      data.delete(key)
    },
    clear: () => {
      data.clear()
    },
  }
}

describe('useAppStore prompt template migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates legacy standalone prompt templates into persisted settings during a version upgrade', async () => {
    const storage = createStorageMock({
      [APP_STORE_STORAGE_KEY]: JSON.stringify({
        state: { settings: {} },
        version: 5,
      }),
      [PROMPT_TEMPLATES_STORAGE_KEY]: JSON.stringify([
        {
          id: 'custom:legacy',
          title: 'Legacy Prompt',
          body: 'Goal: {{goal}}',
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    })
    vi.stubGlobal('localStorage', storage)

    const { useAppStore } = await import('@renderer/app-state/store')
    await useAppStore.persist.rehydrate()

    expect(useAppStore.getState().settings.savedPromptTemplates).toHaveLength(1)
    expect(useAppStore.getState().settings.savedPromptTemplates[0]?.title).toBe('Legacy Prompt')
  })

  it('backfills built-in MCP defaults when hydrating a version-7 settings blob', async () => {
    const storage = createStorageMock({
      [APP_STORE_STORAGE_KEY]: JSON.stringify({
        state: { settings: {} },
        version: 7,
      }),
    })
    vi.stubGlobal('localStorage', storage)

    const { useAppStore } = await import('@renderer/app-state/store')
    await useAppStore.persist.rehydrate()

    expect(useAppStore.getState().settings.defaultBuiltInMcpDomains).toEqual([])
  })
})
