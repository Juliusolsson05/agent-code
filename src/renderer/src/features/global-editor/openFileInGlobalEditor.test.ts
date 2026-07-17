import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const properties = new Map<string, string>()
  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    document: {
      documentElement: {
        dataset: {},
        style: {
          setProperty: (key: string, value: string) => properties.set(key, value),
          removeProperty: (key: string) => properties.delete(key),
          getPropertyValue: (key: string) => properties.get(key) ?? '',
        },
      },
    },
    window: { dispatchEvent: () => true },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    CustomEvent: class {
      constructor(
        public type: string,
        public init: unknown,
      ) {}
    },
  })
})

import { useAppStore } from '@renderer/app-state/store'
import {
  cancelAllPendingGlobalEditorFileOpens,
  openFileInGlobalEditor,
} from './openFileInGlobalEditor'
import { useGlobalEditorStore } from './store'

afterEach(() => {
  vi.unstubAllGlobals()
  cancelAllPendingGlobalEditorFileOpens()
  useAppStore.setState({ globalEditorOpen: false })
})

describe('openFileInGlobalEditor cancellation', () => {
  it('reports a no-op and does not populate the old root after a root switch', async () => {
    let finishRead!: (result: {
      ok: true
      path: string
      absolutePath: string
      text: string
      mtimeMs: number
      size: number
      version: string
    }) => void
    const read = new Promise<Parameters<typeof finishRead>[0]>(resolve => {
      finishRead = resolve
    })
    vi.stubGlobal('window', {
      api: {
        editorReadTextFile: () => read,
      },
    })
    useGlobalEditorStore.setState({ byCwd: {}, activeCwd: '/old-root' })
    useAppStore.setState({ globalEditorOpen: true })

    const pending = openFileInGlobalEditor({ root: '/old-root', path: 'src/slow.ts' })
    useGlobalEditorStore.getState().setActiveCwd('/new-root')
    cancelAllPendingGlobalEditorFileOpens()
    finishRead({
      ok: true,
      path: 'src/slow.ts',
      absolutePath: '/old-root/src/slow.ts',
      text: 'stale navigation',
      mtimeMs: 1,
      size: 16,
      version: 'v1',
    })

    await expect(pending).resolves.toEqual({ ok: true, opened: false })
    expect(useGlobalEditorStore.getState().activeCwd).toBe('/new-root')
    expect(useGlobalEditorStore.getState().byCwd['/old-root']).toBeUndefined()
  })

  it('does not surface a stale read failure after the root was switched', async () => {
    let rejectRead!: (error: Error) => void
    const read = new Promise<never>((_resolve, reject) => {
      rejectRead = reject
    })
    vi.stubGlobal('window', {
      api: {
        editorReadTextFile: () => read,
      },
    })
    useGlobalEditorStore.setState({ byCwd: {}, activeCwd: '/old-root' })
    useAppStore.setState({ globalEditorOpen: true })

    const pending = openFileInGlobalEditor({ root: '/old-root', path: 'src/slow.ts' })
    useGlobalEditorStore.getState().setActiveCwd('/new-root')
    cancelAllPendingGlobalEditorFileOpens()
    rejectRead(new Error('permission denied'))

    await expect(pending).resolves.toEqual({ ok: true, opened: false })
    expect(useGlobalEditorStore.getState().activeCwd).toBe('/new-root')
  })
})
