import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  __resetCloseConfirmationForTests,
  requestRootCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { CloseConfirmationDialog } from './CloseConfirmationDialog'

afterEach(__resetCloseConfirmationForTests)

it.each([
  ['Cancel', null], ['Close Agent', 'agent'], ['Close Tab (2)', 'tab'],
] as const)('root-close button %s resolves only its named scope', async (button, expected) => {
  render(<CloseConfirmationDialog />)
  const root = { sessionId: 'root', title: 'Old root', live: false }
  const worker = { sessionId: 'worker', title: 'Running worker', live: true }
  let answer!: ReturnType<typeof requestRootCloseConfirmation>
  act(() => {
    answer = requestRootCloseConfirmation({
      required: true, reason: 'multi', targets: [root, worker],
      summary: 'Project contains 2 sessions.', agentOnly: { title: root.title, targets: [root] },
    })
  })
  expect(screen.getByRole('heading', { name: 'Close the agent or the tab?' })).toBeInTheDocument()
  expect(screen.getByText('Running worker')).toBeInTheDocument()
  expect(screen.getByText('working')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: button }))
  expect(await answer).toBe(expected)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
