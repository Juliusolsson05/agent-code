import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

type MockTerminal = Record<string, unknown> & {
  cols: number
  rows: number
  container: HTMLElement | null
  onDataListener: ((data: string) => void) | null
  onScrollListener: ((line: number) => void) | null
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
}))

const settings = vi.hoisted(() => ({
  dictationEnabled: false,
  dictationProvider: 'local',
  dictationShortcut: 'off',
  mouseModeEnabled: false,
  dispatchColorFlags: {},
}))

// Read by the follow wiring in AgentTerminalLeaf; absent it would be
// undefined, which happens to behave as "off" but hides the contract.
const appStoreTail = vi.hoisted(() => ({ tailAllMode: false }))

vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: xtermHarness.attachWebgl,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = xtermHarness.cols
    rows = xtermHarness.rows
    options: Record<string, unknown> = {}
    container: HTMLElement | null = null
    onDataListener: ((data: string) => void) | null = null
    onScrollListener: ((line: number) => void) | null = null
    dispose = vi.fn()
    inputDispose = vi.fn(() => { this.onDataListener = null })
    scrollDispose = vi.fn(() => { this.onScrollListener = null })
    constructor() { xtermHarness.instances.push(this as unknown as MockTerminal) }
    loadAddon() {}
    open(container: HTMLElement) { this.container = container }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener
      return { dispose: this.inputDispose }
    }
    // Follow wiring (agentTerminalFollow) subscribes to viewport movement on
    // mount; these scroll surfaces exist so the Submit harness exercises the
    // same Terminal API the real component consumes.
    onScroll(listener: (line: number) => void) {
      this.onScrollListener = listener
      return { dispose: this.scrollDispose }
    }
    scrollToBottom() {}
    scrollToLine(_line: number) {}
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { xtermHarness.fit() } },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: settings, tailAllMode: appStoreTail.tailAllMode }),
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('AgentTerminalLeaf Mouse Mode Submit', () => {
  let attach: Deferred<string | null>
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  const resize = vi.fn().mockResolvedValue(undefined)
  const sendInput = vi.fn().mockResolvedValue(undefined)
  const api = {
    attachAgentPty: vi.fn((_id: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn(() => () => {}),
    onSessionTerminalData: vi.fn(() => () => {}),
    resize,
    sendInput,
  }
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

  function leaf() {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <AgentTerminalLeaf
            sessionId="session-1"
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={{ ...emptyRuntime(), processStatus: 'started' }}
            projectDir="/tmp/project"
            provider="codex"
            showStatusMode={false}
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  beforeEach(() => {
    settings.mouseModeEnabled = false
    attach = deferred<string | null>()
    nextFrameId = 0
    frames = new Map()
    xtermHarness.fit.mockClear()
    xtermHarness.instances.length = 0
    xtermHarness.attachWebgl.mockReset()
    xtermHarness.attachWebgl.mockImplementation(() => ({
      ready: Promise.resolve(true),
      dispose: vi.fn(),
    }))
    api.attachAgentPty.mockReset().mockImplementation(() => attach.promise)
    api.detachAgentPty.mockClear()
    resize.mockClear()
    sendInput.mockClear()
    workspace.acknowledgeSession = vi.fn()

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn()
      observe() {}
      unobserve() {}
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
  })

  it('hides Submit entirely when Mouse Mode is off', () => {
    render(leaf())
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
  })

  it('sends the Enter byte to the agent PTY after attach when Mouse Mode is on', async () => {
    settings.mouseModeEnabled = true
    render(leaf())
    act(() => flushAnimationFrames())
    await act(async () => {
      attach.resolve('')
      await attach.promise
    })

    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await act(async () => { await Promise.resolve() })

    expect(sendInput).toHaveBeenCalledWith('session-1', '\r')
  })

  it('queues a pre-attach Submit and delivers it once attach lands', async () => {
    settings.mouseModeEnabled = true
    render(leaf())
    act(() => flushAnimationFrames())
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(sendInput).not.toHaveBeenCalled()

    await act(async () => {
      attach.resolve('')
      await attach.promise
    })
    expect(sendInput).toHaveBeenCalledWith('session-1', '\r')
  })
})