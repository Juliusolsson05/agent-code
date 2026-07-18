import { describe, expect, it } from 'vitest'

import {
  extractActiveClaudeComposer,
  isClaudePromptComposerReady,
  pasteAbsorbedVia,
} from './pasteConfirm.js'
import { isPasteLike } from './pasteConfirm.js'

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

  it('does not interpret prompt-owned ASCII dividers as Claude chrome', () => {
    const screen = ['❯ first line', '--------', 'tail after divider', '────────────'].join('\n')
    expect(extractActiveClaudeComposer(screen)).toBe(
      ['❯ first line', '--------', 'tail after divider'].join('\n'),
    )
  })

  it('routes bare carriage returns through bracketed paste', () => {
    expect(isPasteLike('first\rsecond')).toBe(true)
  })

  it('does not rebase on a quoted prompt marker inside the active composer', () => {
    const screen = [
      'assistant history',
      '────────────────────',
      '❯ explain this quote',
      '❯ quoted Claude output',
      'tail of my prompt',
      '────────────────────',
      'status',
    ].join('\n')
    expect(extractActiveClaudeComposer(screen)).toBe([
      '❯ explain this quote',
      '❯ quoted Claude output',
      'tail of my prompt',
    ].join('\n'))
  })

  it('requires an empty scoped composer before automated delivery', () => {
    expect(isClaudePromptComposerReady([
      'Claude Code',
      '────────────────────',
      '❯',
      '────────────────────',
      'status',
    ].join('\n'))).toBe(true)
    expect(isClaudePromptComposerReady('Starting Claude Code…')).toBe(false)
    expect(isClaudePromptComposerReady('❯ existing manual draft')).toBe(false)
  })
})
