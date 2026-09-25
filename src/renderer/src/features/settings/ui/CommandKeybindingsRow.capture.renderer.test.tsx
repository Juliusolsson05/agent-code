import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { CommandKeybindingsRow } from './CommandKeybindingsRow'

// #1272 (C4 hunt): the recorder captured every key on the window until
// Escape or a finished chord. Clicking elsewhere (the Settings search box) or
// leaving the window did not release it, so the next bare letter typed was
// swallowed AND saved as that command's shortcut.
// Accessible names from #1221 (the keyboard-first pass): the Add button names
// its command and the recording state is spelled out, since the visible
// "Press keys… ⎋" chip is decorative. One helper for each, so the absence
// checks below cannot drift back to a name that no longer exists and pass
// vacuously.
const ADD = /^Add a shortcut to /
const RECORDING = /^Recording a shortcut for /
const recorder = () => screen.queryByRole('button', { name: RECORDING })

const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true) })

function startRecording() {
  render(<CommandKeybindingsRow />)
  const add = screen.getAllByRole('button', { name: ADD })[0]!
  fireEvent.click(add)
  expect(recorder()).toBeInTheDocument()
}

it('stops recording when the user clicks somewhere else', () => {
  startRecording()
  const elsewhere = document.createElement('input')
  document.body.appendChild(elsewhere)
  fireEvent.mouseDown(elsewhere)
  expect(recorder()).toBeNull()
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
  expect(recorder()).toBeNull()
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
  expect(recorder()).toBeInTheDocument()
})

it('ends recording on a click in the gap between category blocks', () => {
  startRecording()
  fireEvent.mouseDown(listGeometry(), { clientX: 120, clientY: 20 })
  expect(recorder()).toBeNull()
})

it('ends recording on a click on another row', () => {
  startRecording()
  const row = document.querySelector('[data-shortcut-list] [data-shortcut-recorder]')!.parentElement!.parentElement!
  fireEvent.mouseDown(row)
  expect(recorder()).toBeNull()
})

it('lets the recorder button toggle recording off itself', () => {
  startRecording()
  const button = recorder()!
  fireEvent.mouseDown(button)
  fireEvent.click(button)
  expect(recorder()).toBeNull()
})

it('ends recording even when the clicked control stops propagation', () => {
  startRecording()
  const stubborn = document.createElement('button')
  stubborn.addEventListener('mousedown', event => event.stopPropagation())
  document.body.appendChild(stubborn)
  fireEvent.mouseDown(stubborn)
  expect(recorder()).toBeNull()
  stubborn.remove()
})

