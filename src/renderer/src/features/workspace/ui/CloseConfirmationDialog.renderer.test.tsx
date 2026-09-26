import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  requestCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { CloseConfirmationDialog } from './CloseConfirmationDialog'

afterEach(__resetCloseConfirmationForTests)

// WHAT THIS FILE USED TO PIN, because half of it was deleted on purpose (#992).
//
// The dialog had a second, THREE-way presentation — "Close the agent or the
// tab?" with Close Agent / Close Tab (N) — raised for one specific session: a
// tab's root tile leaf, whose close would otherwise have emptied the tile tree
// and taken the project with it. These tests pinned that each of the three
// buttons resolved only its named scope, that a terminal root was called a
// terminal, and that Enter on a Tab-focused Close Agent could never become
// Close Tab.
//
// There is no tile tree, so there is no root and no second scope: every close
// is session-scoped, and "everything in this project" is the Close Tab command
// with its own list. What survives is the part that was never about the root —
// the list the user approves, and the #867 keyboard contract — now asserted
// against the only presentation the dialog has.

const parent = { sessionId: 'parent', title: 'Old parent', live: false }
const worker = { sessionId: 'worker', title: 'Running worker', live: true }

function multiRequest() {
  return {
    required: true as const, reason: 'multi' as const, targets: [parent, worker],
    summary: 'This closes 2 sessions, 1 still working.',
  }
}

it.each([
  ['Cancel', false], ['Close 2', true],
] as const)('button %s resolves its own answer and closes the dialog', async (button, expected) => {
  render(<CloseConfirmationDialog />)
  let answer!: Promise<boolean>
  act(() => { answer = requestCloseConfirmation(multiRequest()) })
  expect(screen.getByRole('heading', { name: 'Close these sessions?' })).toBeInTheDocument()
  // The list, not just the count: the user can check these are the two they
  // meant, and sees which one is mid-turn.
  expect(screen.getByText('Old parent')).toBeInTheDocument()
  expect(screen.getByText('Running worker')).toBeInTheDocument()
  expect(screen.getByText('working')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: button }))
  expect(await answer).toBe(expected)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('asks about one working session without a list or a count', () => {
  render(<CloseConfirmationDialog />)
  act(() => {
    void requestCloseConfirmation({
      required: true, reason: 'running', targets: [worker],
      summary: 'Running worker is still working. Close it anyway?',
    })
  })
  expect(screen.getByRole('heading', { name: 'Close a working session?' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
})

it('escapes the summary, the ONLY identity a single-target close shows (#1049 re-review)', () => {
  // With one target the list below never renders, so the summary — which
  // embeds the session's own title — is the whole of what the user reads
  // before authorising a kill. A title carrying a bidi override could name a
  // different session than the one that dies.
  render(<CloseConfirmationDialog />)
  act(() => {
    void requestCloseConfirmation({
      required: true, reason: 'running', targets: [worker],
      summary: 'staging \u202Eprod deploy is still working. Close it anyway?',
    })
  })
  const description = screen.getByText(/is still working/)
  expect(description.textContent).not.toContain('\u202E')
  expect(description.textContent).toContain('U+202E')
})

it('offers exactly two answers — no narrower or wider scope than the list shown', () => {
  // The regression guard for the deleted branch: a third button means some
  // close path has grown a second scope again, and the user is once more
  // approving a list that is not the list that dies.
  render(<CloseConfirmationDialog />)
  act(() => { void requestCloseConfirmation(multiRequest()) })
  // By ACCESSIBLE NAME, not textContent: the buttons carry aria-hidden key
  // chips (Cancel ⎋), which are decoration, not a different answer.
  const footerButtons = screen.getAllByRole('button', { name: /^(Cancel|Close.*)$/ })
    .map(button => button.getAttribute('aria-label') ?? button.textContent?.replace(/[⎋↩⌘]/g, '').trim())
  expect(footerButtons).toEqual(['Cancel', 'Close 2'])
})

it('opens with focus on Cancel, labels Cancel ⎋, and puts no Enter chip on the destructive Close', async () => {
  // K1: Enter on open must never destroy. Focus is placed on Cancel
  // explicitly (not by footer-order luck), and Close advertises no key
  // because none performs it.
  render(<CloseConfirmationDialog />)
  act(() => { void requestCloseConfirmation(multiRequest()) })
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  expect(cancel.querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  expect(screen.getByRole('button', { name: 'Close 2' }).querySelector('[data-slot="kbd"]')).toBeNull()
})

it('declines the first request when a second one supersedes it', async () => {
  // One slot: two destructive grants can never be open at once, and the
  // superseded close path gets an answer instead of awaiting forever.
  render(<CloseConfirmationDialog />)
  let first!: Promise<boolean>
  act(() => { first = requestCloseConfirmation(multiRequest()) })
  act(() => { void requestCloseConfirmation(multiRequest()) })
  expect(await first).toBe(false)
  expect(currentCloseConfirmation()).not.toBeNull()
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
describe('close confirmation keyboard ownership', () => {
  it('opens with Cancel focused, and Enter there can only cancel', async () => {
    render(<CloseConfirmationDialog />)
    let answer!: Promise<boolean>
    act(() => { answer = requestCloseConfirmation(multiRequest()) })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())

    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)
    expect(currentCloseConfirmation()).not.toBeNull()

    fireEvent.click(cancel)
    expect(await answer).toBe(false)
  })

  it('leaves Enter on a Tab-focused Close to that button', async () => {
    render(<CloseConfirmationDialog />)
    let answer!: Promise<boolean>
    act(() => { answer = requestCloseConfirmation(multiRequest()) })
    const close = screen.getByRole('button', { name: 'Close 2' })
    act(() => close.focus())

    expect(fireEvent.keyDown(close, { key: 'Enter' })).toBe(true)
    expect(currentCloseConfirmation()).not.toBeNull()

    fireEvent.click(close)
    expect(await answer).toBe(true)
  })
})
