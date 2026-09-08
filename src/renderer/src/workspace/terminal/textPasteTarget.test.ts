import { describe, expect, it } from 'vitest'
import { encodeTerminalPaste, registerTerminalPasteTarget, getTerminalPasteTarget } from './textPasteTarget'

describe('terminal text insertion', () => {
  it('wraps multiline text only when the application enables bracketed paste', () => {
    expect(encodeTerminalPaste('one\r\ntwo', true)).toBe('\x1b[200~one\ntwo\x1b[201~')
    expect(() => encodeTerminalPaste('one\ntwo', false)).toThrow(/multiline/i)
    expect(encodeTerminalPaste('single line', false)).toBe('single line')
  })
  it('refuses control bytes that could terminate a paste or execute a command', () => {
    expect(() => encodeTerminalPaste('safe\x1b[201~\rcommand', true)).toThrow(/control/i)
    expect(() => encodeTerminalPaste('text\x03', false)).toThrow(/control/i)
    expect(() => encodeTerminalPaste('text\t', false)).toThrow(/control/i)
  })
  it('selects only the active view and cannot revive a disposed target', () => {
    const target = { isActive: () => true, paste: async () => true }
    const hidden = { isActive: () => false, paste: async () => true }
    const remove = registerTerminalPasteTarget('a', target)
    const removeHidden = registerTerminalPasteTarget('a', hidden)
    expect(getTerminalPasteTarget('a')).toBe(target)
    remove()
    expect(getTerminalPasteTarget('a')).toBeNull()
    removeHidden()
  })
})
