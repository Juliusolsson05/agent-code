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
      // The user is commanding `other-agent` — deliberately NOT the captured
      // one, which is the point of this suite.
      stage: { lanes: [{ selectedSessionId: 'other-agent' }], rows: [{ length: 1 }], focusedLane: 0 },
        pinnedSessionIds: [],
      sessions: {
        'captured-agent': { cwd: '/projects/captured', kind: 'claude', projectId: 'captured-tab', joinedAt: 0 },
        'other-agent': { cwd: '/projects/other', kind: 'codex', projectId: 'other-tab', joinedAt: 0 },
      },
      tabs: [
        {
          id: 'captured-tab',
          title: 'Captured',
        },
        {
          id: 'other-tab',
          title: 'Other',
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

  it('never lets keyboard focus rest on a provider row (#862)', () => {
    // Tab to a row, ArrowDown to move the highlight, Space: the browser clicks
    // the FOCUSED row, so the switch went to a provider other than the
    // highlighted one. happy-dom does not synthesize keyboard clicks, so the
    // pin is the structure that makes the path impossible.
    harness()

    const rows = document.querySelectorAll('[data-provider-switch-choice]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(row => expect(row).toHaveAttribute('tabindex', '-1'))
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

  // Plan S5: the shared list keys, the listbox as focus owner, and Enter's
  // meaning on a Switch button instead of a prose legend.
  it('focuses the listbox, jumps with End, and switches to that destination on Enter', () => {
    const { switchSessionProvider } = harness()
    const listbox = screen.getByRole('listbox')
    expect(document.activeElement).toBe(listbox)
    fireEvent.keyDown(listbox, { key: 'End' })
    // Whatever the LAST destination is (the list grows with providers), End
    // highlights it and Enter switches to exactly it.
    const options = screen.getAllByRole('option')
    const last = options[options.length - 1]!
    expect(listbox.getAttribute('aria-activedescendant')).toBe(last.id)
    const [kind, runtime] = last.getAttribute('data-provider-switch-choice')!.split(':')
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(switchSessionProvider).toHaveBeenCalledWith('captured-agent', kind, runtime === 'structured' ? undefined : runtime)
  })

  it('shows Switch ↩ and Cancel ⎋ instead of the old prose legend', () => {
    harness()
    expect(screen.getByRole('button', { name: 'Switch' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
    expect(screen.queryByText(/Enter switch/)).toBeNull()
  })
})

