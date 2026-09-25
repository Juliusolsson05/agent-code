import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { CommandKeybindingsRow } from './CommandKeybindingsRow'

// #1272 (C4 hunt): the recorder captured every key on the window until
// Escape or a finished chord. Clicking elsewhere (the Settings search box) or
// leaving the window did not release it, so the next bare letter typed was
// swallowed AND saved as that command's shortcut.
const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true) })

function startRecording() {
  render(<CommandKeybindingsRow />)
  const add = screen.getAllByRole('button', { name: 'Add' })[0]!
  fireEvent.click(add)
  expect(screen.getByRole('button', { name: 'Press keys… (Esc)' })).toBeInTheDocument()
}

it('stops recording when the user clicks somewhere else', () => {
  startRecording()
  const elsewhere = document.createElement('input')
  document.body.appendChild(elsewhere)
  fireEvent.mouseDown(elsewhere)
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
  // The next key is ordinary typing again: not swallowed, not saved.
  const before = JSON.stringify(useAppStore.getState().settings.commandKeybindingOverrides ?? {})
  const typed = fireEvent.keyDown(elsewhere, { key: 't', code: 'KeyT' })
  expect(typed).toBe(true)
  expect(JSON.stringify(useAppStore.getState().settings.commandKeybindingOverrides ?? {})).toBe(before)
  elsewhere.remove()
})

it('stops recording when the window loses focus', () => {
  startRecording()
  fireEvent.blur(window)
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
})
