import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'

import { LazyTextProse } from '@providers/shared/renderer/components/lazy-prose'

describe('LazyTextProse browser boundary', () => {
  // WHY load the split chunk here (#1107, #700): its first transform under Vitest can take seconds
  // on a loaded machine, and the test used to measure that with a 5 s findByText — the same number
  // as Vitest's 5 s test default, so the test-level timeout always won and the useful message
  // ("the element never appeared") could never fire. Awaiting the import itself (not a timer) moves
  // compiler warm-up out of the assertion; production reuses a loaded chunk the same way. The lazy
  // boundary is still exercised: LazyTextProse resolves its own import() on render.
  beforeAll(async () => {
    await import('@renderer/features/feed/ui/markdown')
  })

  it('loads the bounded Markdown surface on demand in a renderer environment', async () => {
    render(<LazyTextProse text="**Evidence-backed** rendering" />)
    const strong = await screen.findByText('Evidence-backed')
    expect(strong.tagName).toBe('STRONG')
    expect(strong.parentElement).toHaveTextContent('Evidence-backed rendering')
  })
})
