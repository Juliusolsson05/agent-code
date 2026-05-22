import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { toolHintFromBlock } from '@renderer/features/feed/workIndicatorHints'

function SmokeComponent(): JSX.Element {
  return <button type="button">Renderer test stack</button>
}

describe('renderer test project', () => {
  it('runs React component tests in happy-dom', () => {
    render(<SmokeComponent />)

    const button = screen.getByRole('button', { name: 'Renderer test stack' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Renderer test stack')
  })

  it('resolves renderer aliases in renderer tests', () => {
    const block = {
      parsedInput: { file_path: '/repo/src/app.ts' },
    } as Parameters<typeof toolHintFromBlock>[0]

    expect(toolHintFromBlock(block)).toBe('/repo/src/app.ts')
  })
})
