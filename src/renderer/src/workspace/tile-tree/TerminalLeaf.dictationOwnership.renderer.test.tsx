import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RetainedWorkspaceSurface } from '@renderer/app/shell/RetainedWorkspaceSurface'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TerminalLeaf } from './TerminalLeaf'

// #757 round-4 review blocker: a hidden focused shell pane must not own the
// dictation hotkey. TerminalLeaf stays mounted under display:none while
// Reader/Spotlight/Settings own the screen and the retained tree keeps
// focusedSessionId on it; an ungated useComposerDictation registration meant
// the registry's preferred focused target transcribed straight into the
// invisible pane's PTY. This pins the LEAF's contract — both registration
// flags visibility-gated, matching the TileLeaf/AgentTerminalLeaf pattern.
// The registry's own preference behavior is covered by useComposerDictation's
// tests; mocking the hook keeps audio/WebStack out of this file.

const xtermHarness = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 40
    options: Record<string, unknown> = {}
    loadAddon() {}
    open() {}
    onData(listener: (data: string) => void) {
      xtermHarness.onData = listener
      return { dispose() {} }
    }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: {
        dictationEnabled: true,
        dictationProvider: 'local',
        dictationShortcut: 'off',
      },
    }),
}))

vi.mock('@renderer/app-state/settings/theme', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  THEME_CHANGED_EVENT: 'agent-code:test-theme-change',
  getActiveAppFontFamily: () => 'monospace',
}))

vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({
  readXtermTheme: () => ({}),
  syncXtermTheme: () => {},
}))

const dictationSpy = vi.hoisted(() => vi.fn())

vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({
  useComposerDictation: dictationSpy,
}))

function registrationFlags(): { enabled: boolean; focused: boolean } {
  const last = dictationSpy.mock.calls[dictationSpy.mock.calls.length - 1]?.[0] as {
    enabled: boolean
    focused: boolean
  }
  return { enabled: last?.enabled === true, focused: last?.focused === true }
}

describe('TerminalLeaf dictation ownership', () => {
  let attach: { promise: Promise<string>; resolve: (value: string) => void }

  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  beforeEach(() => {
    dictationSpy.mockClear()
    let resolveAttach!: (value: string) => void
    attach = {
      promise: new Promise(done => { resolveAttach = done }),
      resolve: resolveAttach,
    }
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now())
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        attachTerminal: vi.fn(() => attach.promise),
        detachTerminal: vi.fn().mockResolvedValue(undefined),
        onSessionTerminalData: vi.fn(() => () => {}),
        resize: vi.fn().mockResolvedValue(undefined),
        sendInput: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
  })

  it('registers dictation only while the pane is visible, even when focused', async () => {
    const tree = (hidden: boolean) => (
      <RetainedWorkspaceSurface hidden={hidden}>
        <TerminalLeaf sessionId="shell-1" focused onFocusRequest={() => {}} workspace={workspace} />
      </RetainedWorkspaceSurface>
    )
    const view = render(tree(false))
    await act(async () => {
      attach.resolve('')
      await attach.promise
    })
    expect(registrationFlags()).toEqual({ enabled: true, focused: true })

    // Takeover: the pane keeps `focused` in the retained tree but must stop
    // claiming the dictation hotkey the reader/spotlight surface now owns.
    view.rerender(tree(true))
    expect(registrationFlags()).toEqual({ enabled: false, focused: false })

    view.rerender(tree(false))
    expect(registrationFlags()).toEqual({ enabled: true, focused: true })
  })
})
