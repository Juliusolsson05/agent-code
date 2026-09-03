import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalEditorWorkspaceSlot } from '@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot'
import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

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

describe('AgentTerminalLeaf dimension ownership', () => {
  let attach: Deferred<string | null>
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
    attach = deferred<string | null>()
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
        attachAgentPty: vi.fn(() => attach.promise),
        detachAgentPty: vi.fn().mockResolvedValue(undefined),
        onSessionAgentPtyData: vi.fn(() => () => {}),
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

  it('drops a visible-pane resize queued behind attach after editor fullscreen releases ownership', async () => {
    const runtime = {
      ...emptyRuntime(),
      processStatus: 'started' as const,
    }
    const tree = (editorFullscreen: boolean) => (
      <AgentTerminalOwnershipProvider>
        <GlobalEditorWorkspaceSlot
          open
          editorFullscreen={editorFullscreen}
          splitWorkspaceWidth="60%"
        >
          <MountedAgentTerminalOwner sessionId="session-1">
            <AgentTerminalLeaf
              sessionId="session-1"
              focused
              onFocusRequest={() => {}}
              workspace={workspace}
              runtime={runtime}
              projectDir="/tmp/project"
              provider="codex"
            />
          </MountedAgentTerminalOwner>
        </GlobalEditorWorkspaceSlot>
      </AgentTerminalOwnershipProvider>
    )
    const view = render(tree(false))

    // The measured pane size is now waiting for the delayed main-process
    // attach. This reproduces the real wake/attach interval identified by the
    // orchestration gate; resolving immediately would never exercise the stale
    // replay path that overwrote the inline terminal.
    act(() => flushAnimationFrames())
    expect(resize).not.toHaveBeenCalled()

    view.rerender(tree(true))
    await act(async () => {
      attach.resolve('')
      await attach.promise
    })

    // The retained xterm is mounted but its workspace is display:none and the
    // debug terminal is now the only dimension owner. The old pane measurement
    // must be discarded, not replayed when attach finally settles.
    expect(resize).not.toHaveBeenCalled()

    view.rerender(tree(false))
    act(() => flushAnimationFrames())

    // Reacquisition remeasures instead of trusting the discarded dimensions,
    // so a pane with the same cols/rows still restores its size after the
    // inline terminal may have changed the backend while fullscreen was open.
    expect(resize).toHaveBeenCalledWith('session-1', 120, 40)
  })

  it('forwards a keystroke typed after attach through the replay-silenced input path', async () => {
    const runtime = {
      ...emptyRuntime(),
      processStatus: 'started' as const,
    }
    render(
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <AgentTerminalLeaf
            sessionId="session-1"
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={runtime}
            projectDir="/tmp/project"
            provider="codex"
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>,
    )
    act(() => flushAnimationFrames())
    await act(async () => {
      attach.resolve('replayed screen \x1b[6n')
      await attach.promise
    })
    // The replay has been "parsed" (the mock calls back synchronously), so
    // the latch is down and a real keystroke must reach the provider; had
    // the latch stuck, this pane would silently drop every key.
    expect(xtermHarness.onData).not.toBeNull()
    await act(async () => {
      xtermHarness.onData!('x')
      await Promise.resolve()
    })
    const api = window.api as unknown as { sendInput: ReturnType<typeof vi.fn> }
    expect(api.sendInput).toHaveBeenCalledWith('session-1', 'x')
    expect(workspace.acknowledgeSession).toHaveBeenCalledWith('session-1')
  })
})
