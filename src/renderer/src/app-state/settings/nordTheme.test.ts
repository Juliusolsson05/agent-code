import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CUSTOM_APPEARANCE_CSS_VARS } from '@renderer/app-state/settings/customAppearance'

// Built-in themes exist ONLY as CSS (see savedThemes.ts), so the only way to
// assert "Nord defines every appearance token" is to read the stylesheet. The
// parser below is deliberately naive: styles.css declares its token blocks at
// the top level with no nesting, and that is all this needs to understand.
const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')

type Block = { selectors: string[]; declarations: Map<string, string> }

function blocks(): Block[] {
  const out: Block[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(s => s.trim()).filter(Boolean)
    const declarations = new Map<string, string>()
    for (const decl of match[2].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
      const [name, ...rest] = decl.split(':')
      if (name?.trim().startsWith('--')) declarations.set(name.trim(), rest.join(':').trim())
    }
    out.push({ selectors, declarations })
  }
  return out
}

const NORD = '[data-mode="dark-nord"]'

function nordScoped(block: Block): boolean {
  return block.selectors.some(s => s === ':root' || s === NORD || s === `:root${NORD}`)
}

describe('Nord built-in theme', () => {
  // The whole point of shipping Nord as a built-in rather than a saved theme
  // is that every one of the 81 tokens has a Nord value. A token that falls
  // through to the alias block is fine ONLY when the alias derivation equals
  // the Nord value; this test checks the union, so a token nobody defines
  // anywhere (a typo in the block, a new token added later) fails loudly.
  it('defines every appearance token for the default mode', () => {
    const defined = new Set<string>()
    for (const block of blocks().filter(nordScoped)) {
      for (const name of block.declarations.keys()) defined.add(name)
    }
    const missing = Object.values(CUSTOM_APPEARANCE_CSS_VARS).filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })

  // First paint and unknown-mode degradation both read `:root`; if Nord ever
  // stops sharing that block the app flashes a different palette on launch.
  it('shares the first-paint palette with :root', () => {
    const base = blocks().find(b => b.selectors.includes(NORD) && b.declarations.has('--theme-canvas'))
    expect(base?.selectors).toContain(':root')
    expect(base?.declarations.get('--theme-canvas')).toBe('#171b21')
  })

  it('participates in the dark high-contrast override', () => {
    const contrast = blocks().find(b => b.selectors.includes(`[data-contrast="high"]${NORD}`))
    expect(contrast?.declarations.get('--theme-canvas')).toBe('#000000')
  })

  // The accent picker must keep working on Nord: every accent-tinted token in
  // the Nord blocks has to be expressed through var(--theme-accent), never as
  // a literal frost value that would ignore a user's Amber.
  it('derives accent tints from the accent variable', () => {
    for (const block of blocks().filter(b => b.selectors.includes(NORD) || b.selectors.includes(`:root${NORD}`))) {
      for (const [name, value] of block.declarations) {
        if (name === '--theme-accent') continue
        expect(value.toLowerCase(), name).not.toContain('136, 192, 208')
        expect(value.toLowerCase(), name).not.toContain('#88c0d0')
      }
    }
  })
})
