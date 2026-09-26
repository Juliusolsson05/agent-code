import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ConditionAction } from '@shared/conditions-core/contract'

import { ConditionPromptShell } from './ConditionPromptShell'

// The shared must-answer shell for runtime-authored prompts (Grok, OpenCode).
// Pins what the UI pass unified: the app's dialog grammar (header +
// description + footer), Enter-safe initial focus on the first NON-reject
// action, and that Escape never dismisses a must-answer prompt.

const actions: ConditionAction[] = [
  { kind: 'custom', id: 'reject', label: 'Reject' } as ConditionAction,
  { kind: 'custom', id: 'once', label: 'Allow once' } as ConditionAction,
  { kind: 'custom', id: 'always', label: 'Allow always' } as ConditionAction,
]

describe('ConditionPromptShell', () => {
  it('uses the dialog grammar and focuses the first non-reject action', async () => {
    const dispatch = vi.fn(async () => {})
    render(
      <ConditionPromptShell
        heading="OpenCode wants to run a command"
        description="OpenCode is waiting for an explicit response before it can continue."
        actions={actions}
        dispatch={dispatch}
        isReject={action => /reject/i.test(action.label)}
      >
        <p>rm -rf build</p>
      </ConditionPromptShell>,
    )
    const dialog = screen.getByRole('dialog', { name: 'OpenCode wants to run a command' })
    expect(dialog.querySelector('[data-slot="dialog-header"]')).not.toBeNull()
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull()
    expect(screen.getByText(/waiting for an explicit response/)).toBeVisible()
    // Radix focuses on the next frame; let it run.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allow once' }))

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
