import { act, renderHook } from '@testing-library/react'
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { CLEAR_AGENT_COMPOSER_PRESSES, CLEAR_AGENT_COMPOSER_SPACING_MS } from './clearAgentComposer'
import { useComposerKeybinds } from './useComposerKeybinds'

// #737: Tab from the normal-mode composer must never reach the provider PTY
// (Claude accepts its prompt suggestion on Tab, which latches the prompt
// gate `occupied`), and Escape must still give the user a way out of the
// `composer-occupied` state it used to be blocked behind.

const SESSION = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' as SessionId

function keyEvent(
  key: string,
  mods: Partial<Pick<React.KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>> = {},
): React.KeyboardEvent<HTMLTextAreaElement> {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>
}

function setup(options: { runtime?: Partial<SessionRuntime>; input?: string; provider?: 'claude' | 'codex' | 'opencode' } = {}) {
  const send = vi.fn(async () => {})
  const setInputText = vi.fn()
  const updateRuntime = vi.fn()
  const showPaneToast = vi.fn()
  const runtime = {
    ...emptyRuntime(),
    processStatus: 'started',
    inputReady: true,
    ...options.runtime,
  } as SessionRuntime
  const workspace = {
    dispatchMode: false,
    updateRuntime,
    showPaneToast,
    clearPendingRewindUndo: vi.fn(),
    getRuntime: () => runtime,
  } as unknown as Workspace
  const feed = createFakeSessionFeed()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionFeedProvider value={feed}>{children}</SessionFeedProvider>
  )
  const hook = renderHook(() =>
    useComposerKeybinds({
      sessionId: SESSION,
      provider: options.provider ?? 'claude',
      runtime,
      workspace,
      input: options.input ?? '',
      setInputText,
      send,
      sendConditionKey: vi.fn(async () => {}),
      history: [],
      historyIndex: null,
      historyAnchor: '',
      cyclingHistory: false,
      setHistoryIndex: vi.fn(),
      setHistoryAnchor: vi.fn(),
      endHistoryCycle: vi.fn(),
    }),
    { wrapper },
  )
  return { hook, send, setInputText, updateRuntime, showPaneToast }
}

describe('composer Tab handling', () => {
  it('accepts the suggestion chip into the textarea instead of forwarding Tab', async () => {
    const { hook, send, setInputText, updateRuntime } = setup({
      runtime: { promptSuggestion: { text: 'Run the tests and fix failures', receivedAt: 1 } },
    })
    const event = keyEvent('Tab')

    await act(async () => {
      await hook.result.current.onKeyDown(event)
    })

    expect(event.preventDefault).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(setInputText).toHaveBeenCalledWith('Run the tests and fix failures')
    expect(updateRuntime).toHaveBeenCalledWith(SESSION, { promptSuggestion: null })
  })

  it('forwards nothing on Tab with a draft, without a suggestion, or with a modifier', async () => {
    const withDraft = setup({ input: 'half-typed', runtime: { promptSuggestion: { text: 'x', receivedAt: 1 } } })
    await act(async () => { await withDraft.hook.result.current.onKeyDown(keyEvent('Tab')) })
    expect(withDraft.send).not.toHaveBeenCalled()
    expect(withDraft.setInputText).not.toHaveBeenCalled()

    const noSuggestion = setup()
    await act(async () => { await noSuggestion.hook.result.current.onKeyDown(keyEvent('Tab')) })
    expect(noSuggestion.send).not.toHaveBeenCalled()
    expect(noSuggestion.setInputText).not.toHaveBeenCalled()

    const shifted = setup({ runtime: { promptSuggestion: { text: 'x', receivedAt: 1 } } })
    await act(async () => { await shifted.hook.result.current.onKeyDown(keyEvent('Tab', { shiftKey: true })) })
    expect(shifted.send).not.toHaveBeenCalled()
    expect(shifted.setInputText).not.toHaveBeenCalled()
  })

  it('keeps forwarding Tab for opencode, whose TUI binds it to agent cycling', async () => {
    const { hook, send, setInputText } = setup({ provider: 'opencode' })
    await act(async () => { await hook.result.current.onKeyDown(keyEvent('Tab')) })
    expect(send).toHaveBeenCalledWith('\t')
    expect(setInputText).not.toHaveBeenCalled()
  })

  it('still forwards Tab in slash mode, where it means picker completion', async () => {
    const { hook, send } = setup()
    // Typing `/` into an empty composer enters slash mode and forwards it.
    await act(async () => { await hook.result.current.onKeyDown(keyEvent('/')) })
    expect(hook.result.current.slashMode).toBe(true)
    await act(async () => { await hook.result.current.onKeyDown(keyEvent('Tab')) })
    expect(send).toHaveBeenCalledWith('\t')
  })
})

describe('composer Escape while the provider composer is occupied', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { sendInput: vi.fn(async () => true) },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the spaced clear routine instead of the "still starting" toast', async () => {
    const { hook, send, showPaneToast } = setup({
      runtime: { inputReady: false, inputReadinessReason: 'composer-occupied' },
    })
    const sendInput = vi.mocked(window.api.sendInput)

    await act(async () => {
      const pending = hook.result.current.onKeyDown(keyEvent('Escape'))
      await vi.advanceTimersByTimeAsync(CLEAR_AGENT_COMPOSER_PRESSES * CLEAR_AGENT_COMPOSER_SPACING_MS + 100)
      await pending
    })

    expect(send).not.toHaveBeenCalled()
    expect(sendInput).toHaveBeenCalledTimes(CLEAR_AGENT_COMPOSER_PRESSES)
    expect(sendInput.mock.calls.every(call => call[1] === '\x15')).toBe(true)
    expect(showPaneToast).toHaveBeenCalledWith(SESSION, expect.stringContaining('Clearing'))
  })

  it('runs one clear routine even when Escape repeats or is pressed again mid-clear', async () => {
    const { hook, showPaneToast } = setup({
      runtime: { inputReady: false, inputReadinessReason: 'composer-occupied' },
    })
    const sendInput = vi.mocked(window.api.sendInput)

    await act(async () => {
      const first = hook.result.current.onKeyDown(keyEvent('Escape'))
      // A held key auto-repeats; a nervous second press lands mid-loop.
      const repeat = hook.result.current.onKeyDown({ ...keyEvent('Escape'), repeat: true } as React.KeyboardEvent<HTMLTextAreaElement>)
      await vi.advanceTimersByTimeAsync(CLEAR_AGENT_COMPOSER_SPACING_MS * 3)
      const second = hook.result.current.onKeyDown(keyEvent('Escape'))
      await vi.advanceTimersByTimeAsync(CLEAR_AGENT_COMPOSER_PRESSES * CLEAR_AGENT_COMPOSER_SPACING_MS + 100)
      await Promise.all([first, repeat, second])
    })

    expect(sendInput).toHaveBeenCalledTimes(CLEAR_AGENT_COMPOSER_PRESSES)
    expect(showPaneToast).toHaveBeenCalledTimes(1)
  })

  it('keeps the plain toast for every other not-ready state and ESC when ready', async () => {
    const starting = setup({ runtime: { inputReady: false, inputReadinessReason: 'provider-not-ready' } })
    await act(async () => { await starting.hook.result.current.onKeyDown(keyEvent('Escape')) })
    expect(starting.send).not.toHaveBeenCalled()
    expect(vi.mocked(window.api.sendInput)).not.toHaveBeenCalled()
    expect(starting.showPaneToast).toHaveBeenCalledWith(SESSION, expect.stringContaining('still starting'))

    const ready = setup()
    await act(async () => { await ready.hook.result.current.onKeyDown(keyEvent('Escape')) })
    expect(ready.send).toHaveBeenCalledWith('\x1b')
  })
})
