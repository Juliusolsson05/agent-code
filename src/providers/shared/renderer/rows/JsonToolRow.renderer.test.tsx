import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'

describe('generic JSON tool command headline', () => {
  it('applies the command budget to an unknown provider tool without checking its name', () => {
    render(
      <JsonToolRow
        block={{
          type: 'tool_use',
          id: 'future-shell-1',
          name: 'future_provider_shell',
          input: {
            command: 'first line\nsecond line\nthird line that must stay outside the headline',
          },
        }}
      />,
    )

    expect(screen.getByText('future_provider_shell')).toBeInTheDocument()
    const headline = document.querySelector('pre')
    expect(headline?.textContent).toBe('first line\nsecond line…')
    expect(headline?.textContent).not.toContain('third line')
  })
})
