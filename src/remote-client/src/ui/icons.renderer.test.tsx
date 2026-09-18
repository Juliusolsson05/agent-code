import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { IconMic } from './icons'

// Two contracts live here:
//
// 1. The icon pipeline renders real inline SVG (bundled, currentColor,
//    decorative) — not emoji glyphs, which broke the app's visual language
//    in the v1 chrome (🎤 ⏺ for the mic states).
// 2. The chrome source itself stays emoji-free. A render-level scan would
//    only cover mounted branches; scanning the source files catches an
//    emoji smuggled into any branch, label, or fallback of any chrome
//    component. The codepoint ranges cover the symbol/pictograph blocks
//    that read as emoji; typographic punctuation (‹ … ❯ ⎿ ●) is
//    deliberately NOT flagged — those are the app's marker vocabulary.

const here = dirname(fileURLToPath(import.meta.url))
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{FE0F}]/u

describe('phone chrome icons', () => {
  it('renders the mic as inline SVG in both states', () => {
    const idle = render(<IconMic />)
    const svg = idle.container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')

    const recording = render(<IconMic active />)
    // active = filled capsule (strokeWidth 0), the glance-trackable state
    // transition instead of two different emoji.
    expect(recording.container.querySelector('svg')?.getAttribute('stroke-width')).toBe('0')
  })

  it('keeps chrome source free of emoji glyphs', () => {
    const files = ['SessionView.tsx', 'SessionList.tsx', 'PairScreen.tsx', 'App.tsx', 'ToastHost.tsx', 'icons.tsx']
    for (const file of files) {
      const source = readFileSync(resolve(here, file), 'utf8')
      const hits = source.match(EMOJI_RE)
      expect(hits, `${file} contains emoji glyphs: ${hits?.join(' ')}`).toBeNull()
    }
  })
})
