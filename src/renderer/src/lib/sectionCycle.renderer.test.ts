import { describe, expect, it } from 'vitest'

import { sectionCycleTarget } from './sectionCycle'

// ⌘[ / ⌘] cycle dialog sections (plan D5), and must YIELD where they mean
// outdent / indent (B7's condition): a textarea, Monaco, contenteditable.

function key(code: 'BracketLeft' | 'BracketRight', target: HTMLElement, extra: Partial<KeyboardEvent> = {}) {
  const event = new KeyboardEvent('keydown', { code, metaKey: true, bubbles: true, ...extra })
  Object.defineProperty(event, 'target', { value: target })
  return event
}

describe('sectionCycleTarget', () => {
  it('moves and wraps from a neutral target', () => {
    const div = document.createElement('div')
    expect(sectionCycleTarget(key('BracketRight', div), 0, 3)).toBe(1)
    expect(sectionCycleTarget(key('BracketLeft', div), 0, 3)).toBe(2)
  })

  it('still cycles from a single-line input, which has no bracket meaning', () => {
    expect(sectionCycleTarget(key('BracketRight', document.createElement('input')), 1, 3)).toBe(2)
  })

  it('yields in a textarea, inside Monaco and in contenteditable', () => {
    expect(sectionCycleTarget(key('BracketRight', document.createElement('textarea')), 0, 3)).toBeNull()
    const editor = document.createElement('div')
    editor.className = 'monaco-editor'
    const inner = document.createElement('div')
    editor.appendChild(inner)
    document.body.appendChild(editor)
    expect(sectionCycleTarget(key('BracketRight', inner), 0, 3)).toBeNull()
    editor.remove()
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    document.body.appendChild(editable)
    expect(sectionCycleTarget(key('BracketRight', editable), 0, 3)).toBeNull()
    editable.remove()
  })

  it('ignores the chord with extra modifiers or a single section', () => {
    const div = document.createElement('div')
    expect(sectionCycleTarget(key('BracketRight', div, { shiftKey: true }), 0, 3)).toBeNull()
    expect(sectionCycleTarget(key('BracketRight', div), 0, 1)).toBeNull()
  })
})
