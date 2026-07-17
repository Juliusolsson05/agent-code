import { describe, expect, it } from 'vitest'

import { buildPersistedGlobalEditorState } from './globalEditorPersistence'

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
})
