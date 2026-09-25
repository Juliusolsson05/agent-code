import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Alert } from '@renderer/components/ui/alert'

// The one inline error box (UI pass, G-13). It must be announced (it mounts
// with its message) and follow the theme's soft/border tokens rather than
// hand-mixed `bg-danger/10` opacities.
describe('Alert', () => {
  it('announces itself and uses the theme danger tokens', () => {
    render(<Alert>Could not save the skill.</Alert>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not save the skill.')
    expect(alert.className).toMatch(/\bbg-danger-soft\b/)
    expect(alert.className).toMatch(/\bborder-danger-border\b/)
  })
})
