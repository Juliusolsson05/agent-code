import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LazyTextProse } from '@providers/shared/renderer/components/lazy-prose'

describe('LazyTextProse browser boundary', () => {
  it('loads the bounded Markdown surface on demand in a renderer environment', async () => {
    render(<LazyTextProse text="**Evidence-backed** rendering" />)
    // The first transform of the split Markdown chunk can exceed Testing
    // Library's one-second default in CI/dev Vitest; production reuses the
    // loaded chunk. This timeout tests eventual ownership without turning
    // compiler warm-up into a renderer failure.
    const strong = await screen.findByText('Evidence-backed', {}, { timeout: 5_000 })
    expect(strong.tagName).toBe('STRONG')
    expect(strong.parentElement).toHaveTextContent('Evidence-backed rendering')
  })
})
