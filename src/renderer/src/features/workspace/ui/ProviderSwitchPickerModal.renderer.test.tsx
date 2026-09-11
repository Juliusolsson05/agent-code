import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProviderSwitchPickerModal } from './ProviderSwitchPickerModal'
import type { Workspace } from '@renderer/workspace/workspaceStore'

function harness() {
  const switchSessionProvider = vi.fn(async () => undefined)
  const onClose = vi.fn()
  const workspace = {
    state: {
      activeTabId: 'other-tab',
      dispatchMode: { focusedSessionId: 'other-agent', scope: 'global' },
      sessions: {
        'captured-agent': { cwd: '/projects/captured', kind: 'claude' },
        'other-agent': { cwd: '/projects/other', kind: 'codex' },
      },
      tabs: [
        {
          id: 'captured-tab',
          title: 'Captured',
          focusedSessionId: 'captured-agent',
          root: { type: 'leaf', sessionId: 'captured-agent' },
        },
        {
          id: 'other-tab',
          title: 'Other',
          focusedSessionId: 'other-agent',
          root: { type: 'leaf', sessionId: 'other-agent' },
        },
      ],
    },
    switchSessionProvider,
  } as unknown as Workspace
  const mounted = render(
    <ProviderSwitchPickerModal
      open
      sessionId="captured-agent"
      workspace={workspace}
      onClose={onClose}
    />,
  )
  return { switchSessionProvider, onClose, mounted }
}

describe('ProviderSwitchPickerModal', () => {
  it('shows declared destinations and keeps both OpenCode runtime choices distinct', () => {
    harness()

    expect(screen.getByText('Current: Claude · captured')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('OpenCode')).toBeTruthy()
    expect(screen.getByText('OpenCode Terminal')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Claude/ })).toBeNull()
  })

  it('switches the captured session to the clicked provider runtime despite later focus', () => {
    const { switchSessionProvider, onClose } = harness()

    fireEvent.click(screen.getByText('OpenCode Terminal').closest('button')!)

    expect(onClose).toHaveBeenCalledOnce()
    expect(switchSessionProvider).toHaveBeenCalledWith(
      'captured-agent',
      'opencode',
      'terminal',
    )
  })

  it('leaves Enter to a focused Cancel instead of switching to the highlighted provider (#862)', () => {
    // The list's Enter handler used to preventDefault (killing Cancel's native
    // click) and then commit the highlighted row, so Tab -> Cancel -> Enter
    // started a provider switch. `true` = default not prevented, so the real
    // browser still delivers Cancel's click.
    const { switchSessionProvider } = harness()

    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)

    expect(switchSessionProvider).not.toHaveBeenCalled()
  })

  it('supports keyboard choice and cancellation without starting an implicit switch', () => {
    const first = harness()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(first.switchSessionProvider).toHaveBeenCalledWith(
      'captured-agent',
      'opencode',
      undefined,
    )

    first.mounted.unmount()
    // A fresh modal invocation proves Cancel itself never commits whichever
    // row happens to be highlighted.
    const second = harness()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(second.onClose).toHaveBeenCalledOnce()
    expect(second.switchSessionProvider).not.toHaveBeenCalled()
  })
})
