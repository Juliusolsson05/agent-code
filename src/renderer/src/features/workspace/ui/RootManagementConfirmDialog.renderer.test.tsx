import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RootManagementConfirmDialog } from '@renderer/features/workspace/ui/RootManagementConfirmDialog'

describe('Root Agent Code Management confirmation', () => {
  it('refuses to enable until the acknowledgement is checked, then confirms exactly once', () => {
    const onConfirm = vi.fn()
    render(
      <RootManagementConfirmDialog
        open
        agentLabel="Sasha · claude · agent-code"
        description="/work/agent-code"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    // The copy the user asked for: what it grants and why it is usually wrong,
    // plus the agent identity so the grant can be checked against the intent.
    expect(screen.getByText('Sasha · claude · agent-code')).toBeInTheDocument()
    expect(screen.getByText('What this turns on')).toBeInTheDocument()
    expect(screen.getByText('Why this is usually the wrong switch')).toBeInTheDocument()

    const enable = screen.getByRole('button', { name: 'Enable for this agent' })
    expect(enable).toBeDisabled()
    fireEvent.click(enable)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(enable).toBeEnabled()
    fireEvent.click(enable)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('treats cancel as a decline that grants nothing', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <RootManagementConfirmDialog
        open
        agentLabel="codex · app"
        description="/work/app"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
