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

// #1308 review: the edges of the release rule.
// The scroller is the target for both its scrollbar and its own flex gaps;
// only the scrollbar, past the client box, keeps recording (#1308 round 2).
function listGeometry(): HTMLElement {
  const list = document.querySelector<HTMLElement>('[data-shortcut-list]')!
  list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 420, width: 400, height: 420, x: 0, y: 0, toJSON: () => ({}) })
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: 388 })
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 420 })
  return list
}

it('keeps recording while the user drags the list scrollbar', () => {
  startRecording()
  fireEvent.mouseDown(listGeometry(), { clientX: 395, clientY: 100 })
  expect(screen.getByRole('button', { name: 'Press keys… (Esc)' })).toBeInTheDocument()
})

it('ends recording on a click in the gap between category blocks', () => {
  startRecording()
  fireEvent.mouseDown(listGeometry(), { clientX: 120, clientY: 20 })
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
})

it('ends recording on a click on another row', () => {
  startRecording()
  const row = document.querySelector('[data-shortcut-list] [data-shortcut-recorder]')!.parentElement!.parentElement!
  fireEvent.mouseDown(row)
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
})

it('lets the recorder button toggle recording off itself', () => {
  startRecording()
  const recorder = screen.getByRole('button', { name: 'Press keys… (Esc)' })
  fireEvent.mouseDown(recorder)
  fireEvent.click(recorder)
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
})

it('ends recording even when the clicked control stops propagation', () => {
  startRecording()
  const stubborn = document.createElement('button')
  stubborn.addEventListener('mousedown', event => event.stopPropagation())
  document.body.appendChild(stubborn)
  fireEvent.mouseDown(stubborn)
  expect(screen.queryByRole('button', { name: 'Press keys… (Esc)' })).toBeNull()
  stubborn.remove()
})

