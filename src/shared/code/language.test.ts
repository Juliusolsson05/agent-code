import { describe, expect, it } from 'vitest'

import { inferLanguageFromPath, normalizeCodeLanguage } from './language'

describe('code language inference', () => {
  it('recognizes conventional extensionless build files', () => {
    expect(inferLanguageFromPath('/repo/Makefile')).toBe('makefile')
    expect(inferLanguageFromPath('/repo/GNUmakefile')).toBe('makefile')
    expect(inferLanguageFromPath('/repo/Dockerfile')).toBe('dockerfile')
    expect(inferLanguageFromPath('/repo/Containerfile')).toBe('dockerfile')
  })

  it('uses a portable shebang when a filename has no known language', () => {
    expect(
      normalizeCodeLanguage(null, '/repo/bin/release', '#!/usr/bin/env -S python3 -u\n'),
    ).toBe('python')
    expect(normalizeCodeLanguage(null, '/repo/bin/dev', '#!/usr/bin/env node\n')).toBe(
      'javascript',
    )
    expect(normalizeCodeLanguage(null, '/repo/bin/check', '#!/bin/zsh\n')).toBe('shell')
    expect(normalizeCodeLanguage(null, '/repo/bin/check', '\ufeff#!/bin/zsh\n')).toBe('shell')
  })

  it('keeps an explicit caller language authoritative', () => {
    expect(
      normalizeCodeLanguage('typescript', '/repo/tool', '#!/usr/bin/env python3\n'),
    ).toBe('typescript')
  })
})
