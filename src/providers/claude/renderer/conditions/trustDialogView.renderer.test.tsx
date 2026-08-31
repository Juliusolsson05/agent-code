// claudeTrustView — the trust modal must dispatch condition ACTIONS, never raw
// keystrokes.
//
// The regression this fences (#705): the modal used to send a bare '\r' for
// accept, and Claude Code 2.1.251 pre-highlights "No, exit" — so the app's own
// Trust button confirmed the exit option and terminated the CLI. Accept must
// therefore leave the renderer as the custom `claude.trust-dialog.accept`
// action (resolved headless-side against the live screen); any pty payload
// containing '\r' from this view is the defect coming back.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ConditionAction } from '@shared/conditions-core/contract'
import { claudeTrustView } from './views'

function mountTrustView() {
  const dispatched: ConditionAction[] = []
  const Component = claudeTrustView.Component
  render(
    <Component
      state={{ visible: true, workspace: '/tmp/fresh-project' }}
      // The wire action list is deliberately unused by this view (it dispatches
      // its own literals — see views.tsx for why), so an empty list here also
      // pins that: a view that started reading `actions` would keep passing
      // only if it still never turns them into raw Enter bytes.
      actions={[]}
      dispatch={async action => {
        dispatched.push(action)
      }}
      interactionActive={false}
    />,
  )
  return dispatched
}

describe('claudeTrustView action dispatch', () => {
  it('accept dispatches the headless-resolved custom action, never Enter', () => {
    const dispatched = mountTrustView()
    fireEvent.click(screen.getByRole('button', { name: 'trust this folder' }))

    expect(dispatched).toEqual([
      {
        kind: 'custom',
        id: 'accept',
        label: 'Yes, I trust this folder',
        name: 'claude.trust-dialog.accept',
      },
    ])
    // Stated in both directions: no pty write, and in particular no '\r'.
    expect(
      dispatched.some(action => action.kind === 'pty' && action.data.includes('\r')),
    ).toBe(false)
  })

  it('cancel dispatches Esc — the only keystroke whose meaning survives a re-layout', () => {
    const dispatched = mountTrustView()
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(dispatched).toEqual([
      { kind: 'pty', id: 'decline', label: 'No, exit', data: '\x1b' },
    ])
  })
})
