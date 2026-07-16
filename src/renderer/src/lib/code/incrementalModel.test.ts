import { describe, expect, it, vi } from 'vitest'

import {
  applyIncrementalModelText,
  type IncrementalTextModel,
} from './incrementalModel'

function positionAt(text: string, offset: number) {
  const before = text.slice(0, offset)
  const lines = before.split('\n')
  return {
    lineNumber: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  }
}

function fakeModel(value: string) {
  let current = value
  const applyEdits = vi.fn((edits: Parameters<IncrementalTextModel['applyEdits']>[0]) => {
    const edit = edits[0]
    if (!edit) return
    // Tests below assert the actual range. Updating the backing string keeps
    // the fake honest enough to prove a second identical update is a no-op.
    const lines = current.split('\n')
    const toOffset = (line: number, column: number) =>
      lines.slice(0, line - 1).reduce((sum, part) => sum + part.length + 1, 0) + column - 1
    const start = toOffset(edit.range.startLineNumber, edit.range.startColumn)
    const end = toOffset(edit.range.endLineNumber, edit.range.endColumn)
    current = `${current.slice(0, start)}${edit.text}${current.slice(end)}`
  })
  const model: IncrementalTextModel = {
    getValue: () => current,
    getPositionAt: offset => positionAt(current, offset),
    applyEdits,
  }
  return { model, applyEdits, value: () => current }
}

describe('applyIncrementalModelText', () => {
  it('sends an append as one zero-width edit instead of replacing the model', () => {
    const fake = fakeModel('const answer = 4')

    expect(applyIncrementalModelText(fake.model, 'const answer = 42\n')).toBe(true)
    expect(fake.applyEdits).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 1,
          startColumn: 17,
          endLineNumber: 1,
          endColumn: 17,
        },
        text: '2\n',
      },
    ])
    expect(fake.value()).toBe('const answer = 42\n')
    expect(applyIncrementalModelText(fake.model, 'const answer = 42\n')).toBe(false)
    expect(fake.applyEdits).toHaveBeenCalledTimes(1)
  })

  it('keeps a shared suffix outside a repaired streaming-tail edit', () => {
    const fake = fakeModel('before old after')

    applyIncrementalModelText(fake.model, 'before new after')

    expect(fake.applyEdits).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 1,
          startColumn: 8,
          endLineNumber: 1,
          endColumn: 11,
        },
        text: 'new',
      },
    ])
    expect(fake.value()).toBe('before new after')
  })

  it('never splits an astral character at the edit boundary', () => {
    const fake = fakeModel('const icon = "🚀"')

    applyIncrementalModelText(fake.model, 'const icon = "🛠️"')

    const edit = fake.applyEdits.mock.calls[0]?.[0]?.[0]
    expect(edit?.range.startColumn).toBe(15)
    expect(edit?.text).toBe('🛠️')
    expect(fake.value()).toBe('const icon = "🛠️"')
  })
})
