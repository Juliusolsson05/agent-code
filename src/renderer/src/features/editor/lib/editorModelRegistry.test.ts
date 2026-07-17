import { describe, expect, it } from 'vitest'

import {
  acquireEditorModel,
  editorViewState,
  releaseEditorModel,
  releaseEditorModelOwner,
  saveEditorViewState,
} from './editorModelRegistry'

function fakeMonaco() {
  const models = new Map<string, ReturnType<typeof makeModel>>()
  return {
    models,
    api: {
      Uri: {
        file: (path: string) => ({
          with: ({ query }: { query: string }) => ({
            toString: () => `${path}?${query}`,
          }),
        }),
      },
      editor: {
        getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
        createModel: (text: string, language: string, uri: { toString(): string }) => {
          const model = makeModel(text, language)
          models.set(uri.toString(), model)
          return model
        },
        setModelLanguage: (model: ReturnType<typeof makeModel>, language: string) => {
          model.language = language
        },
      },
    },
  }
}

function makeModel(initialText: string, initialLanguage: string) {
  const initialHasBom = initialText.startsWith('\ufeff')
  return {
    text: initialHasBom ? initialText.slice(1) : initialText,
    bom: initialHasBom ? '\ufeff' : '',
    language: initialLanguage,
    disposed: false,
    setValueCalls: 0,
    getValue(_eol?: unknown, preserveBom = false) {
      return preserveBom ? `${this.bom}${this.text}` : this.text
    },
    getLanguageId() {
      return this.language
    },
    isDisposed() {
      return this.disposed
    },
    dispose() {
      this.disposed = true
    },
    getFullModelRange() {
      return {}
    },
    pushEditOperations(_before: unknown, edits: Array<{ text: string }>) {
      this.text = edits[0]?.text ?? this.text
    },
    setValue(text: string) {
      this.setValueCalls += 1
      this.bom = text.startsWith('\ufeff') ? '\ufeff' : ''
      this.text = this.bom ? text.slice(1) : text
    },
  }
}

describe('editor model ownership', () => {
  it('isolates independent buffer owners of the same absolute path', () => {
    const { api } = fakeMonaco()
    const path = '/repo/shared.ts'
    const first = acquireEditorModel(api as never, {
      absolutePath: path,
      text: 'first',
      monacoLangId: 'typescript',
      ownerId: 100_001,
    }) as unknown as ReturnType<typeof makeModel>
    releaseEditorModel(100_001)

    const second = acquireEditorModel(api as never, {
      absolutePath: path,
      text: 'second surface',
      monacoLangId: 'typescript',
      ownerId: 100_002,
    })
    releaseEditorModel(100_002)
    expect(second).not.toBe(first)
    expect(first.text).toBe('first')

    releaseEditorModelOwner(100_001)
    expect(first.disposed).toBe(true)
    expect((second as unknown as ReturnType<typeof makeModel>).disposed).toBe(false)
    releaseEditorModelOwner(100_002)
    expect((second as unknown as ReturnType<typeof makeModel>).disposed).toBe(true)
  })

  it('reuses one owner across remount but migrates an immutable URI after rename', () => {
    const { api } = fakeMonaco()
    const oldPath = '/repo/old.ts'
    const oldModel = acquireEditorModel(api as never, {
      absolutePath: oldPath,
      text: 'content',
      monacoLangId: 'typescript',
      ownerId: 100_003,
    }) as unknown as ReturnType<typeof makeModel>
    releaseEditorModel(100_003)

    const renamedModel = acquireEditorModel(api as never, {
      absolutePath: '/repo/new.ts',
      text: 'content',
      monacoLangId: 'typescript',
      ownerId: 100_003,
    })

    expect(renamedModel).not.toBe(oldModel)
    expect(oldModel.disposed).toBe(true)
    expect((renamedModel as unknown as ReturnType<typeof makeModel>).text).toBe('content')
    releaseEditorModel(100_003)
    releaseEditorModelOwner(100_003)
    expect(oldModel.disposed).toBe(true)
  })

  it('preserves a hidden BOM without inserting it into Monaco editable text', () => {
    const { api } = fakeMonaco()
    const model = acquireEditorModel(api as never, {
      absolutePath: '/repo/bom.ts',
      text: '\ufeffconst before = 1',
      monacoLangId: 'typescript',
      ownerId: 100_004,
    }) as unknown as ReturnType<typeof makeModel>
    releaseEditorModel(100_004)

    acquireEditorModel(api as never, {
      absolutePath: '/repo/bom.ts',
      text: '\ufeffconst after = 2',
      monacoLangId: 'typescript',
      ownerId: 100_004,
    })

    expect(model.bom).toBe('\ufeff')
    expect(model.text).toBe('const after = 2')
    expect(model.setValueCalls).toBe(0)
    releaseEditorModel(100_004)
    releaseEditorModelOwner(100_004)
  })

  it('retains editor view state for the open buffer lifetime', () => {
    const { api } = fakeMonaco()
    acquireEditorModel(api as never, {
      absolutePath: '/repo/view.ts',
      text: 'content',
      monacoLangId: 'typescript',
      ownerId: 100_005,
    })
    const state = { cursorState: [], viewState: {} }
    saveEditorViewState(100_005, state as never)
    releaseEditorModel(100_005)

    expect(editorViewState(100_005)).toBe(state)
    releaseEditorModelOwner(100_005)
    expect(editorViewState(100_005)).toBeNull()
  })
})
