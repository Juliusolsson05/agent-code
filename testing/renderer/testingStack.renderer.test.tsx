import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import '../setup/renderer'

function SmokeComponent(): JSX.Element {
  return <button type="button">Renderer test stack</button>
}

describe('renderer test project', () => {
  it('runs React component tests in happy-dom', () => {
    render(<SmokeComponent />)

    expect(screen.getByRole('button', { name: 'Renderer test stack' })).toBeInTheDocument()
  })
})
