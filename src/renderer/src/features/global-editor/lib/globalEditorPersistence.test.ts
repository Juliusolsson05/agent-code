import { describe, expect, it } from 'vitest'

import {
  buildPersistedGlobalEditorState,
  mergePersistedCwdRecency,
} from './globalEditorPersistence'

const previous = {
  version: 2 as const,
  splitterRatio: 0.4,
  fileTreeWidthPx: 240,
  fileTreeVisible: true,
  tabsByCwd: {
    '/repo-a': { fileOrder: ['a.ts'], activeFilePath: 'a.ts' },
    '/repo-b': { fileOrder: ['b.ts'], activeFilePath: 'b.ts' },
  },
  cwdRecency: ['/repo-a', '/repo-b'],
}

describe('global editor persistence projection', () => {
  it('keeps saved cwd recency instead of falling back to object insertion order', () => {
    expect(mergePersistedCwdRecency(['/repo-a', '/repo-b'], ['/repo-b', '/repo-a'])).toEqual([
      '/repo-b',
      '/repo-a',
    ])
  })
  it('preserves projects not lazily visited in this process', () => {
    const result = buildPersistedGlobalEditorState(
      {
        byCwd: {
          '/repo-a': {
            fileOrder: ['next.ts'],
            activeFilePath: 'next.ts',
            openFiles: {},
          },
        },
        cwdRecency: ['/repo-b', '/repo-a'],
        activeCwd: '/repo-a',
        splitterRatio: 0.6,
        fileTreeWidthPx: 300,
        fileTreeVisible: false,
      },
      previous,
    )

    expect(result.tabsByCwd['/repo-a']?.fileOrder).toEqual(['next.ts'])
    expect(result.tabsByCwd['/repo-b']?.fileOrder).toEqual(['b.ts'])
    expect(result.cwdRecency.at(-1)).toBe('/repo-a')
  })

  it('treats a live project with no tabs as an intentional deletion', () => {
    const result = buildPersistedGlobalEditorState(
      {
        byCwd: {
          '/repo-a': { fileOrder: [], activeFilePath: null, openFiles: {} },
        },
        cwdRecency: ['/repo-b', '/repo-a'],
        activeCwd: '/repo-a',
        splitterRatio: 0.5,
        fileTreeWidthPx: 260,
        fileTreeVisible: true,
      },
      previous,
    )

    expect(result.tabsByCwd['/repo-a']).toBeUndefined()
    expect(result.tabsByCwd['/repo-b']).toBeDefined()
  })

  it('retains the active tab when a project exceeds the restore budget', () => {
    const fileOrder = Array.from({ length: 30 }, (_, index) => `file-${index}.ts`)
    const result = buildPersistedGlobalEditorState(
      {
        byCwd: {
          '/repo-a': { fileOrder, activeFilePath: 'file-2.ts', openFiles: {} },
        },
        cwdRecency: ['/repo-a'],
        activeCwd: '/repo-a',
        splitterRatio: 0.5,
        fileTreeWidthPx: 260,
        fileTreeVisible: true,
      },
      previous,
    )

    expect(result.tabsByCwd['/repo-a']?.fileOrder).toHaveLength(24)
    expect(result.tabsByCwd['/repo-a']?.fileOrder.at(-1)).toBe('file-2.ts')
    expect(result.tabsByCwd['/repo-a']?.activeFilePath).toBe('file-2.ts')
  })
})
