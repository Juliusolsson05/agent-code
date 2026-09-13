import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  requestRootCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { CloseConfirmationDialog } from './CloseConfirmationDialog'

afterEach(__resetCloseConfirmationForTests)

const root = { sessionId: 'root', title: 'Old root', live: false }
const worker = { sessionId: 'worker', title: 'Running worker', live: true }

function rootRequest(noun: 'agent' | 'terminal' = 'agent') {
  return {
    required: true as const, reason: 'multi' as const, targets: [root, worker],
    summary: 'Project contains 2 sessions.', agentOnly: { title: root.title, targets: [root], noun },
  }
}

it.each([
  ['Cancel', null], ['Close Agent', 'agent'], ['Close Tab (2)', 'tab'],
] as const)('root-close button %s resolves only its named scope', async (button, expected) => {
  render(<CloseConfirmationDialog />)
  let answer!: ReturnType<typeof requestRootCloseConfirmation>
  act(() => { answer = requestRootCloseConfirmation(rootRequest()) })
  expect(screen.getByRole('heading', { name: 'Close the agent or the tab?' })).toBeInTheDocument()
  expect(screen.getByText('Running worker')).toBeInTheDocument()
  expect(screen.getByText('working')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: button }))
  expect(await answer).toBe(expected)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('names a terminal root as a terminal, not an agent', () => {
  // #865/#872 made terminals sessions in close flows, so a grid terminal can be
  // the project root. "Close Agent ends zsh" would name the wrong thing.
  render(<CloseConfirmationDialog />)
  act(() => { void requestRootCloseConfirmation(rootRequest('terminal')) })
  expect(screen.getByRole('heading', { name: 'Close the terminal or the tab?' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Close Terminal' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Close Agent' })).not.toBeInTheDocument()
})

// #867 pattern. This dialog has no Enter handler of its own, and that absence is
// the contract: a dialog-level handler calls preventDefault, cancelling the
// focused button's native activation and running its own action instead — how
// Enter on a focused Cancel came to APPLY changes in three other dialogs. On a
// close dialog that would be Enter-on-Cancel killing agents.
//
// jsdom does not synthesize a button's Enter activation, so each test asserts
// the two halves separately: keyDown's default is not prevented (`true`) and
// nothing resolved, then the click the browser would perform resolves only that
// button's own answer.
describe('root-close keyboard ownership', () => {
  it('opens with Cancel focused, and Enter there can only cancel', async () => {
    render(<CloseConfirmationDialog />)
    let answer!: ReturnType<typeof requestRootCloseConfirmation>
    act(() => { answer = requestRootCloseConfirmation(rootRequest()) })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())

    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)
    expect(currentCloseConfirmation()).not.toBeNull()

    fireEvent.click(cancel)
    expect(await answer).toBeNull()
  })

  it('leaves Enter on a Tab-focused Close Agent to that button, never Close Tab', async () => {
    render(<CloseConfirmationDialog />)
    let answer!: ReturnType<typeof requestRootCloseConfirmation>
    act(() => { answer = requestRootCloseConfirmation(rootRequest()) })
    const closeAgent = screen.getByRole('button', { name: 'Close Agent' })
    act(() => closeAgent.focus())

    expect(fireEvent.keyDown(closeAgent, { key: 'Enter' })).toBe(true)
    expect(currentCloseConfirmation()).not.toBeNull()

    fireEvent.click(closeAgent)
    expect(await answer).toBe('agent')
  })
})
