import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => {
  let value = ''
  const offsetAt = (lineNumber: number, column: number) => {
    const lines = value.split('\n')
    return (
      lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) +
      column -
      1
    )
  }
  const positionAt = (offset: number) => {
    const before = value.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
  }

  const applyEdits = vi.fn((edits: Array<{
    range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }
    text: string
  }>) => {
    const edit = edits[0]
    if (!edit) return
    const start = offsetAt(edit.range.startLineNumber, edit.range.startColumn)
    const end = offsetAt(edit.range.endLineNumber, edit.range.endColumn)
    value = `${value.slice(0, start)}${edit.text}${value.slice(end)}`
  })
  const model = {
    getValue: vi.fn(() => value),
    getPositionAt: vi.fn(positionAt),
    applyEdits,
    dispose: vi.fn(),
  }
  const editor = {
    dispose: vi.fn(),
    getContentHeight: vi.fn(() => 64),
    layout: vi.fn(),
    onDidContentSizeChange: vi.fn(() => ({ dispose: vi.fn() })),
    updateOptions: vi.fn(),
  }
  const createModel = vi.fn((content: string) => {
    value = content
    return model
  })
  const createEditor = vi.fn(() => editor)
  const monaco = {
    Uri: { parse: vi.fn((uri: string) => ({ uri })) },
    MarkerSeverity: { Error: 1, Warning: 2, Info: 3, Hint: 4 },
    editor: {
      createModel,
      create: createEditor,
      setModelMarkers: vi.fn(),
    },
  }
  const getMonaco = vi.fn(async () => monaco)
  const ensureSemanticProvider = vi.fn(async () => undefined)

  return {
    model,
    editor,
    applyEdits,
    createModel,
    createEditor,
    monaco,
    getMonaco,
    ensureSemanticProvider,
    reset() {
      value = ''
      for (const candidate of [
        model.getValue,
        model.getPositionAt,
        model.applyEdits,
        model.dispose,
        editor.dispose,
        editor.getContentHeight,
        editor.layout,
        editor.onDidContentSizeChange,
        editor.updateOptions,
        createModel,
        createEditor,
        monaco.Uri.parse,
        monaco.editor.setModelMarkers,
        getMonaco,
        ensureSemanticProvider,
      ]) {
        candidate.mockClear()
      }
    },
  }
})

vi.mock('./monacoRuntime', () => ({
  getMonaco: fakes.getMonaco,
  ensureSemanticProvider: fakes.ensureSemanticProvider,
}))

import { CodeBlock } from './CodeBlock'

describe('CodeBlock incremental Monaco lifecycle', () => {
  const openLspDocument = vi.fn(async () => undefined)
  const changeLspDocument = vi.fn(async () => undefined)
  const closeLspDocument = vi.fn(async () => undefined)
  const unsubscribeDiagnostics = vi.fn()
  const onLspDiagnostics = vi.fn(() => unsubscribeDiagnostics)

  beforeEach(() => {
    fakes.reset()
    openLspDocument.mockClear()
    changeLspDocument.mockClear()
    closeLspDocument.mockClear()
    unsubscribeDiagnostics.mockClear()
    onLspDiagnostics.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openLspDocument,
        changeLspDocument,
        closeLspDocument,
        onLspDiagnostics,
      },
    })
  })

  it('keeps one model/editor/LSP document across streaming code deltas', async () => {
    const { container, rerender, unmount } = render(
      <CodeBlock
        code="const answer = 4"
        language="typescript"
        path="src/live.ts"
        workspaceRoot="/repo"
        codeId="live-write"
        engine="monaco"
      />,
    )

    // The language server is lazy; users must see lexical code while it starts
    // instead of an empty 48px slab.
    expect(container.querySelector('pre')?.textContent).toBe('const answer = 4')

    await waitFor(() => expect(fakes.createEditor).toHaveBeenCalledTimes(1))
    expect(fakes.createModel).toHaveBeenCalledTimes(1)
    expect(openLspDocument).toHaveBeenCalledTimes(1)
    expect(openLspDocument).toHaveBeenCalledWith(expect.objectContaining({
      clientUri: 'agent-code://file/src%2Flive.ts#live-write',
      filePath: null,
    }))

    rerender(
      <CodeBlock
        code={'const answer = 42\n'}
        language="typescript"
        path="src/live.ts"
        workspaceRoot="/repo"
        codeId="live-write"
        engine="monaco"
      />,
    )

    await waitFor(() => expect(fakes.applyEdits).toHaveBeenCalledTimes(1))
    expect(changeLspDocument).toHaveBeenCalledWith(
      'agent-code://file/src%2Flive.ts#live-write',
      'const answer = 42\n',
    )
    expect(fakes.createModel).toHaveBeenCalledTimes(1)
    expect(fakes.createEditor).toHaveBeenCalledTimes(1)
    expect(openLspDocument).toHaveBeenCalledTimes(1)
    expect(closeLspDocument).not.toHaveBeenCalled()

    unmount()
    expect(fakes.model.dispose).toHaveBeenCalledTimes(1)
    expect(fakes.editor.dispose).toHaveBeenCalledTimes(1)
    expect(unsubscribeDiagnostics).toHaveBeenCalledTimes(1)
    expect(closeLspDocument).toHaveBeenCalledTimes(1)
  })
})
