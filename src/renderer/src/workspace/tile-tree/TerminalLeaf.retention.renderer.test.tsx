import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RetainedWorkspaceSurface } from '@renderer/app/shell/RetainedWorkspaceSurface'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TerminalLeaf } from './TerminalLeaf'

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  onData: null as ((data: string) => void) | null,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = xtermHarness.cols
    rows = xtermHarness.rows
    options: Record<string, unknown> = {}
    loadAddon() {}
    open() {}
    onData(listener: (data: string) => void) {
      xtermHarness.onData = listener
      return { dispose() {} }
    }
    // Real xterm reports each write parsed via the callback; the input
    // forwarder (#745) holds its replay latch until then, so a mock that
    // never calls back would model a pane that is deaf forever.
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
        dictationEnabled: false,
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

vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({
  useComposerDictation: () => {},
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('TerminalLeaf retention', () => {
  let attach: Deferred<string>
  let resize: ReturnType<typeof vi.fn>
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>

  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  function flushAnimationFrames() {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  }

  beforeEach(() => {
    attach = deferred<string>()
    resize = vi.fn().mockResolvedValue(undefined)
    nextFrameId = 0
    frames = new Map()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        attachTerminal: vi.fn(() => attach.promise),
        detachTerminal: vi.fn().mockResolvedValue(undefined),
        onSessionTerminalData: vi.fn(() => () => {}),
        resize,
        sendInput: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
  })

  // #752 review B3: shell panes have no dimension-ownership hook, so on a
  // takeover they must reset the size they last sent and refit on reveal —
  // Spotlight's copy may have resized the PTY meanwhile, and the de-dupe
  // would otherwise swallow the resize the shell now needs.
  it('sends exactly one resize when revealed after a takeover, none while hidden', async () => {
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
    act(() => flushAnimationFrames())
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith('shell-1', 120, 40)

    view.rerender(tree(true))
    act(() => flushAnimationFrames())
    expect(resize).toHaveBeenCalledTimes(1)

    view.rerender(tree(false))
    act(() => flushAnimationFrames())
    expect(resize).toHaveBeenCalledTimes(2)
    expect(resize).toHaveBeenLastCalledWith('shell-1', 120, 40)
  })
})
