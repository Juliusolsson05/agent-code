import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'

import { WelcomeEmpty } from './WelcomeEmpty'

// The empty-workspace button used to read "new tab (⌘T)" as literal text, so
// it kept advertising ⌘T after a user rebound New Tab. It now resolves the
// chord live; this pins that the chip follows the store.

const original = useAppStore.getState().settings

afterEach(() => {
  useAppStore.setState({ settings: original })
})

describe('WelcomeEmpty', () => {
  it('shows the user-rebound New Tab chord, not the shipped default', () => {
    useAppStore.setState({
      settings: { ...original, commandKeybindingOverrides: { 'new-tab': ['Cmd+Shift+Y'] } },
    })
    render(<WelcomeEmpty onNewTabRequest={() => {}} />)
    const button = screen.getByRole('button', { name: 'New Tab' })
    expect(button.querySelector('[data-slot="kbd"]')?.textContent).toBe('⌘⇧Y')
    expect(button).not.toHaveTextContent('⌘T')
  })
})
