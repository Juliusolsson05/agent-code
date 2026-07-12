import { describe, expect, it } from 'vitest'

import { extractActiveClaudeComposer, pasteAbsorbedVia } from './pasteConfirm.js'

describe('Claude active composer extraction', () => {
  it('excludes matching text and placeholders from transcript scrollback', () => {
    const screen = [
      '❯ old duplicated tail',
      '[Pasted text #7]',
      'assistant response',
      '❯ current draft',
      '────────────────────────',
      'status bar',
    ].join('\n')
    const composer = extractActiveClaudeComposer(screen)

    expect(composer).toBe('❯ current draft')
    expect(pasteAbsorbedVia(composer, 'old duplicated tail', 0, false)).toBeNull()
  })
})
