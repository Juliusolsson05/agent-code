import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callback: null as (() => void) | null,
  register: vi.fn((_accelerator: string, callback: () => void) => {
    mocks.callback = callback
    return true
  }),
  unregister: vi.fn(),
  send: vi.fn(),
  stopNative: vi.fn(),
}))

vi.mock('electron', () => ({
  globalShortcut: {
    register: mocks.register,
    unregister: mocks.unregister,
  },
}))
vi.mock('@main/window/mainWindow.js', () => ({ sendToMainWindow: mocks.send }))
vi.mock('@main/dictation/macHotkeyHelper.js', () => ({
  startMacDictationHotkeyHelper: vi.fn(),
  stopMacDictationHotkeyHelper: mocks.stopNative,
}))

import {
  configureDictationHotkey,
  unregisterDictationHotkey,
} from './hotkey'

describe('Electron dictation accelerator lifecycle', () => {
  beforeEach(() => {
    // The module owns process-lifetime registration state. Drain it before
    // clearing spies so one test can never inherit another test's live toggle.
    unregisterDictationHotkey()
    mocks.callback = null
    vi.clearAllMocks()
  })

  it('toggles across activations instead of synthesizing a discarded short hold', async () => {
    await configureDictationHotkey('Cmd+Shift+D')

    mocks.callback?.()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenLastCalledWith('dictation:hotkey-down', {
      binding: 'Cmd+Shift+D',
    })

    mocks.callback?.()
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.send).toHaveBeenLastCalledWith('dictation:hotkey-up', {
      binding: 'Cmd+Shift+D',
    })
  })

  it('releases an active toggle before replacing its binding', async () => {
    await configureDictationHotkey('Cmd+Shift+D')
    mocks.callback?.()

    await configureDictationHotkey('Cmd+Shift+V')

    expect(mocks.send).toHaveBeenLastCalledWith('dictation:hotkey-up', {
      binding: 'Cmd+Shift+D',
    })
    expect(mocks.register).toHaveBeenLastCalledWith('Cmd+Shift+V', expect.any(Function))
  })
})
