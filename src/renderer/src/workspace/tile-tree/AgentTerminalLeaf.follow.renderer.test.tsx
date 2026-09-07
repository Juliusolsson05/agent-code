import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  AgentTerminalOwnerVisibilityProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

// Integration harness for follow behavior (jump-to-latest + tail) on the raw
// agent terminal surface. Modeled on AgentTerminalLeaf.submit.renderer.test.tsx
// with three deltas: the mocked Terminal grows scroll surface area
// (scrollToBottom / onScroll / buffer viewport), the app-store mock is MUTABLE
// so tests can flip tailAllMode like the real store would, and the agent PTY
// channel listener is captured so tests push bytes through the REAL
// sessionDataDispatcher fanout instead of calling leaf internals.
type MockTerminal = {
  rows: number
  buffer: { active: { viewportY: number; length: number } }
  scrollToBottom: ReturnType<typeof vi.fn>
  onScrollListener: ((line: number) => void) | null
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
}))

const appStore = vi.hoisted(() => ({
  settings: {
    dictationEnabled: false,
    dictationProvider: 'local',
    dictationShortcut: 'off',
    mouseModeEnabled: false,
  },
  tailAllMode: false,
}))

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
    buffer = { active: { viewportY: 0, length: 1 } }
    // scrollToBottom intentionally does NOT emit onScroll: real xterm does,
    // but our handler then sees an at-bottom viewport and no-ops, so the mock
    // keeps call counts deterministic. Re-pin behavior is tested by invoking
    // the registered onScroll listener directly.
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = Math.max(0, this.buffer.active.length - this.rows)
    })
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
    onScroll(listener: (line: number) => void) {
      this.onScrollListener = listener
      return { dispose: this.scrollDispose }
    }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { xtermHarness.fit() } },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appStore) => unknown) => selector(appStore),
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

type PtyEvent = { sessionId: string; data: string }

describe('AgentTerminalLeaf follow (jump-to-latest + tail)', () => {
  let attach: Deferred<string | null>
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  let ptyListener: ((event: PtyEvent) => void) | null = null
  const api = {
    attachAgentPty: vi.fn((_id: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn((listener: (event: PtyEvent) => void) => {
      ptyListener = listener
      return () => { ptyListener = null }
    }),
    onSessionTerminalData: vi.fn(() => () => {}),
    resize: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
  }
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  const runtimeWith = (patch: Partial<SessionRuntime>): SessionRuntime => ({
    ...emptyRuntime(),
    processStatus: 'started',
    ...patch,
  })

  function leaf(runtime: SessionRuntime = runtimeWith({})) {
    return (
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
      </AgentTerminalOwnershipProvider>
    )
  }

  function flushAnimationFrames() {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  }

  async function attachResolved(buffer = '') {
    act(() => flushAnimationFrames())
    await act(async () => {
      attach.resolve(buffer)
      await attach.promise
    })
  }

  function term(): MockTerminal {
    return xtermHarness.instances[0]
  }

  beforeEach(() => {
    appStore.tailAllMode = false
    attach = deferred<string | null>()
    nextFrameId = 0
    frames = new Map()
    ptyListener = null
    xtermHarness.fit.mockClear()
    xtermHarness.instances.length = 0
    xtermHarness.attachWebgl.mockReset()
    xtermHarness.attachWebgl.mockImplementation(() => ({
      ready: Promise.resolve(true),
      dispose: vi.fn(),
    }))
    api.attachAgentPty.mockReset().mockImplementation(() => attach.promise)
    api.detachAgentPty.mockClear()

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

  it('ignores the pre-existing jump request baseline on mount', async () => {
    render(leaf(runtimeWith({ scrollToLatestRequest: 3 })))
    await attachResolved()
    expect(term().scrollToBottom).not.toHaveBeenCalled()
  })

  it('scrolls the xterm viewport once when a new jump-to-latest request arrives', async () => {
    const view = render(leaf(runtimeWith({ scrollToLatestRequest: 3 })))
    await attachResolved()
    act(() => { view.rerender(leaf(runtimeWith({ scrollToLatestRequest: 4 }))) })
    expect(term().scrollToBottom).toHaveBeenCalledTimes(1)
  })
})
