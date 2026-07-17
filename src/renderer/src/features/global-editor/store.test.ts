import { beforeEach, describe, expect, it } from 'vitest'

import { useGlobalEditorStore } from './store'

const cwd = '/repo'

function open(path: string, text = path): void {
  useGlobalEditorStore.getState().openFile({ cwd, path, text, mtimeMs: 10 })
}

beforeEach(() => {
  // Zustand's singleton is intentional in production, but each transition
  // test needs a blank project graph so ordering assertions do not depend on
  // whichever test Vitest happened to execute first.
  useGlobalEditorStore.setState({ byCwd: {}, activeCwd: cwd })
})

describe('global editor store transitions', () => {
  it('selects the nearest surviving tab when the active tab closes', () => {
    open('a.ts')
    open('b.ts')
    open('c.ts')
    useGlobalEditorStore.getState().setActiveFile(cwd, 'b.ts')

    expect(useGlobalEditorStore.getState().closeFile(cwd, 'b.ts')).toBe(true)
    expect(useGlobalEditorStore.getState().byCwd[cwd]?.activeFilePath).toBe('c.ts')

    expect(useGlobalEditorStore.getState().closeFile(cwd, 'c.ts')).toBe(true)
    expect(useGlobalEditorStore.getState().byCwd[cwd]?.activeFilePath).toBe('a.ts')
  })

  it('renames an exact path and descendants without touching prefix lookalikes', () => {
    open('src/index.ts', 'base')
    open('src/nested/view.tsx')
    open('src-old/keep.ts')
    useGlobalEditorStore.getState().updateFileText(cwd, 'src/index.ts', 'unsaved')

    useGlobalEditorStore.getState().renameOpenPath(cwd, 'src', 'client')

    const state = useGlobalEditorStore.getState().byCwd[cwd]
    expect(state?.fileOrder).toEqual([
      'client/index.ts',
      'client/nested/view.tsx',
      'src-old/keep.ts',
    ])
    expect(state?.openFiles['client/index.ts']).toMatchObject({
      currentText: 'unsaved',
      savedText: 'base',
      dirty: true,
      absolutePath: '/repo/client/index.ts',
    })
    expect(state?.openFiles['src-old/keep.ts']).toBeDefined()
  })

  it('ignores a late save acknowledgement after a path was closed and reopened', () => {
    open('late.ts', 'first lifetime')
    useGlobalEditorStore.getState().updateFileText(cwd, 'late.ts', 'submitted')
    const oldGeneration =
      useGlobalEditorStore.getState().byCwd[cwd]!.openFiles['late.ts']!.generation
    useGlobalEditorStore.getState().closeFile(cwd, 'late.ts', { force: true })
    open('late.ts', 'second lifetime')

    useGlobalEditorStore
      .getState()
      .acknowledgeFileWrite(cwd, 'late.ts', 'submitted', 20, oldGeneration)

    expect(useGlobalEditorStore.getState().byCwd[cwd]?.openFiles['late.ts']).toMatchObject({
      currentText: 'second lifetime',
      savedText: 'second lifetime',
      mtimeMs: 10,
    })
  })
})
