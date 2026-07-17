import { beforeEach, describe, expect, it } from 'vitest'

import { useGlobalEditorStore } from './store'

const cwd = '/repo'

function open(path: string, text = path): void {
  useGlobalEditorStore
    .getState()
    .openFile({ cwd, path, text, mtimeMs: 10, diskVersion: `${path}:v1` })
}

beforeEach(() => {
  // Zustand's singleton is intentional in production, but each transition
  // test needs a blank project graph so ordering assertions do not depend on
  // whichever test Vitest happened to execute first.
  useGlobalEditorStore.setState({
    byCwd: {},
    cwdRecency: [cwd],
    activeCwd: cwd,
  })
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

  it('preserves a canonical model root across an Explorer rename', () => {
    useGlobalEditorStore.getState().openFile({
      cwd,
      path: 'src/index.ts',
      absolutePath: '/physical/repo/src/index.ts',
      text: 'content',
      mtimeMs: 10,
      diskVersion: 'v1',
    })

    useGlobalEditorStore.getState().renameOpenPath(cwd, 'src', 'client')

    expect(
      useGlobalEditorStore.getState().byCwd[cwd]?.openFiles['client/index.ts']?.absolutePath,
    ).toBe('/physical/repo/client/index.ts')
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
      .acknowledgeFileWrite(cwd, 'late.ts', 'submitted', 20, 'late-version', oldGeneration)

    expect(useGlobalEditorStore.getState().byCwd[cwd]?.openFiles['late.ts']).toMatchObject({
      currentText: 'second lifetime',
      savedText: 'second lifetime',
      mtimeMs: 10,
    })
  })

  it('refuses to discard a clean buffer after its disk file was deleted', () => {
    open('deleted.ts', 'last recoverable copy')
    useGlobalEditorStore.getState().setFileError(cwd, 'deleted.ts', 'file was deleted on disk', {
      conflict: true,
      externalChange: 'deleted',
    })

    expect(useGlobalEditorStore.getState().closeFile(cwd, 'deleted.ts')).toBe(false)
    expect(useGlobalEditorStore.getState().byCwd[cwd]?.openFiles['deleted.ts']).toBeDefined()
    expect(useGlobalEditorStore.getState().closeFile(cwd, 'deleted.ts', { force: true })).toBe(true)
  })

  it('reveals a selection without changing a recoverable buffer disk state', () => {
    open('deleted.ts', 'last recoverable copy')
    useGlobalEditorStore.getState().setFileError(cwd, 'deleted.ts', 'file was deleted on disk', {
      conflict: true,
      externalChange: 'deleted',
    })

    useGlobalEditorStore.getState().setActiveFile(cwd, 'deleted.ts', {
      focus: true,
      selection: { line: 4, column: 7 },
    })

    expect(useGlobalEditorStore.getState().byCwd[cwd]?.openFiles['deleted.ts']).toMatchObject({
      currentText: 'last recoverable copy',
      savedText: 'last recoverable copy',
      dirty: false,
      conflict: true,
      externalChange: 'deleted',
      selection: { line: 4, column: 7 },
    })
  })
})
