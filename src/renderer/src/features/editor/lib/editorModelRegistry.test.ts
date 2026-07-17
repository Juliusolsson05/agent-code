import { describe, expect, it } from 'vitest'

import {
  acquireEditorModel,
  releaseEditorModel,
  releaseEditorModelOwner,
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
  return {
    text: initialText,
    language: initialLanguage,
    disposed: false,
    getValue() {
      return this.text
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

  it('reuses one owner across remount and rename without losing its model', () => {
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

    expect(renamedModel).toBe(oldModel)
    expect(oldModel.disposed).toBe(false)
    releaseEditorModel(100_003)
    releaseEditorModelOwner(100_003)
    expect(oldModel.disposed).toBe(true)
  })
})
