import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FONT_FAMILIES, SYMBOL_FALLBACK_FONTS } from './types'

// #1194. The feed draws symbols with the Unicode Emoji property (`⏺` on
// every Claude row, `⏸`, `☑`, `🖼`, `↗`) that the curated coding faces lack.
// When no named face has the glyph, iOS Safari falls back to Apple Color
// Emoji — the phone's recurring "why are there Apple emojis" bug, which
// replacing emoji in the phone's own chrome never reached. These are the two
// halves that must both hold for the monochrome fallback to exist at all.

describe('app font stacks', () => {
  it.each(FONT_FAMILIES.map(font => [font.id, font.family] as const))(
    '%s falls back to the symbol faces before the generic family',
    (_id, family) => {
      // Before `monospace`: a generic family ends the author's say, and the
      // platform's last resort after it is exactly the emoji font. After the
      // system monospace faces: glyphs Menlo/Monaco already draw (and the
      // terminal, which renders from this same string) must not change.
      expect(family).toContain(`Monaco, ${SYMBOL_FALLBACK_FONTS}, monospace`)
    },
  )

  it('loads the symbol faces the stacks name', () => {
    // A face named in the stack but never loaded resolves to nothing, which is
    // indistinguishable from not naming it: the emoji fallback comes back.
    const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
    const fontImport = css.match(/@import url\('(https:\/\/fonts\.googleapis\.com[^']+)'\)/)?.[1] ?? ''
    expect(fontImport).toContain('family=Noto+Sans+Symbols+2')
    expect(fontImport).toContain('family=Noto+Sans+Symbols&')
  })
})
