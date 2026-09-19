import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UserBand } from './primitives'

// WHY a class-contract test instead of pixel math: the bug was a hardcoded
// 32px negative margin (-mx-8 px-8) mirroring a gutter that has been
// container-relative since the 2026-07-08 mobile-feed-rewrite (px-3 under
// 480px). At phone widths the band started 20px outside the scroller on each
// side and made the whole feed horizontally scrollable. The contract is "the
// band derives its bleed from --feed-gutter", which the column sets at the
// same 480/768px container steps its px-* utilities use — class presence is
// the honest assertion here because the pixel values live in styles.css
// container rules that jsdom cannot evaluate.
describe('UserBand', () => {
  it('derives its bleed from --feed-gutter instead of a hardcoded 32px mirror', () => {
    const { container } = render(<UserBand>hi</UserBand>)
    const band = container.firstElementChild as HTMLElement
    expect(band.className).toContain('bg-user-bg')
    // The hardcoded mirror classes must be gone — they were the bug.
    expect(band.className).not.toContain('-mx-8')
    expect(band.className).not.toContain('px-8')
    // Negative-margin + padding both track the container-set var, with a
    // 0px fallback so a band rendered outside a feed column loses its bleed
    // instead of overflowing (the safe failure direction).
    expect(band.className).toMatch(/-mx-\[var\(--feed-gutter,0px\)\]/)
    expect(band.className).toMatch(/px-\[var\(--feed-gutter,0px\)\]/)
  })
})
