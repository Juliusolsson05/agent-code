import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_PROVIDER_CHOICES } from '@renderer/workspace/providerChoices'
import type { HermesConnectionInfo } from '@shared/hermes/types'

import { SidekickPanelBody } from './SidekickPanel'
import { newSidekickChoices } from './SidekickPicker'

// Hermes is first-class in the Sidekick Picker (#1493, plan Decision 5):
// first when a connection can actually serve it, still listed — disabled,
// with the fix — when none is signed in, never silently hidden.

function connection(state: HermesConnectionInfo['state']): HermesConnectionInfo {
  return { id: 'conn', name: 'VPS', baseUrl: 'https://hermes.example', createdAt: 0, state, identity: null, backend: null, lastError: null }
}

const order = (rows: ReturnType<typeof newSidekickChoices>) => rows.map(row => `${row.choice.kind}${row.choice.providerRuntime ? `:${row.choice.providerRuntime}` : ''}${row.disabledReason ? ' (disabled)' : ''}`)

describe('New Sidekick choices', () => {
  it('puts Hermes first when a connection is ready', () => {
    const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, [connection('ready')])
    expect(order(rows)[0]).toBe('hermes')
    expect(rows.every(row => row.disabledReason === null)).toBe(true)
  })

  it('keeps Hermes enabled but last when the signed-in server is unreachable', () => {
    const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, [connection('unreachable')])
    expect(order(rows).at(-1)).toBe('hermes')
    expect(rows.find(row => row.choice.kind === 'hermes')?.disabledReason).toBeNull()
  })

  it('lists Hermes disabled, with the fix, when nothing is signed in', () => {
    for (const hermes of [null, [], [connection('signed-out')]]) {
      const rows = newSidekickChoices(AGENT_PROVIDER_CHOICES, hermes)
      expect(order(rows).at(-1)).toBe('hermes (disabled)')
      expect(rows.find(row => row.choice.kind === 'hermes')?.disabledReason).toBe('Sign in under Settings → Hermes')
    }
  })
})

describe('Sidekick panel body', () => {
  it('offers Open here for a sidekick live in another window', () => {
    const onOpenHere = vi.fn()
    render(<SidekickPanelBody state="elsewhere" failure={null} onOpenHere={onOpenHere} onRetry={vi.fn()} onNew={vi.fn()} />)
    expect(screen.getByText('Live in another window.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open here' }))
    expect(onOpenHere).toHaveBeenCalledOnce()
  })

  it('offers New Sidekick when there is none, and Retry with the reason on failure', () => {
    const onNew = vi.fn()
    const { unmount } = render(<SidekickPanelBody state="empty" failure={null} onOpenHere={vi.fn()} onRetry={vi.fn()} onNew={onNew} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Sidekick…' }))
    expect(onNew).toHaveBeenCalledOnce()
    unmount()
    render(<SidekickPanelBody state="failed" failure="This sidekick no longer exists." onOpenHere={vi.fn()} onRetry={vi.fn()} onNew={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('This sidekick no longer exists.')
  })
})
