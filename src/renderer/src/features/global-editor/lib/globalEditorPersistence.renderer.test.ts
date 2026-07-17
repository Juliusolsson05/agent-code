import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import {
  loadPersistedGlobalEditorState,
  startGlobalEditorPersistence,
} from './globalEditorPersistence'

describe('global editor persistence lifecycle', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
    } satisfies Storage)
    useGlobalEditorStore.setState({
      byCwd: {},
      cwdRecency: [],
      activeCwd: null,
      splitterRatio: 0.5,
      fileTreeWidthPx: 260,
      fileTreeVisible: true,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('flushes a pending trailing write when its shell unmounts', () => {
    const stop = startGlobalEditorPersistence()
    useGlobalEditorStore.setState({
      byCwd: {
        '/repo': {
          fileOrder: ['src/index.ts'],
          activeFilePath: 'src/index.ts',
          openFiles: {},
        },
      },
      cwdRecency: ['/repo'],
      activeCwd: '/repo',
    })

    // The 500 ms debounce has not fired. stop() models Settings/Reader taking
    // over the surface and must synchronously preserve the newest tab graph.
    expect(loadPersistedGlobalEditorState()).toBeNull()
    stop()

    expect(loadPersistedGlobalEditorState()?.tabsByCwd['/repo']).toEqual({
      fileOrder: ['src/index.ts'],
      activeFilePath: 'src/index.ts',
    })
  })
})
