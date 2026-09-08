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
  buffer: { active: { viewportY: number; length: number; baseY: number } }
  scrollToBottom: ReturnType<typeof vi.fn>
  onScrollListener: ((line: number) => void) | null
  markers: Array<{ line: number; isDisposed: boolean }>
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
  // Deferred-write mode for race regression tests: real xterm parses chunks
  // on a setTimeout cadence, so write completion callbacks fire macrotasks
  // after the write — long enough for tail to disengage in between. Sync
  // mode (the default) models the common case and keeps the bulk of the
  // suite deterministic.
  deferWrites: false,
  pendingWriteCallbacks: [] as Array<() => void>,
  flushWriteCallbacks(): void {
    const pending = xtermHarness.pendingWriteCallbacks.splice(0)
    for (const callback of pending) callback()
  },
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
    buffer = { active: {
      type: 'normal', viewportY: 0, length: 1,
      get baseY() { return Math.max(0, this.length - xtermHarness.rows) },
      cursorY: xtermHarness.rows - 1,
    } }
    // The real-engine system test owns trim/reflow behavior. This marker only
    // supplies the public API needed by lifecycle and deferred-callback tests.
    markers: Array<{ line: number; isDisposed: boolean }> = []
    registerMarker(offset: number) {
      const marker = {
        line: this.buffer.active.baseY + this.buffer.active.cursorY + offset,
        isDisposed: false,
        dispose() { this.isDisposed = true; this.line = -1 },
      }
      this.markers.push(marker)
      return marker
    }
    // scrollToBottom emits onScroll AFTER moving the viewport, like real
    // xterm fires the public scroll event for programmatic moves. The re-pin
    // handler then sees an at-bottom viewport and no-ops, so the harness
    // exercises the self-termination instead of asserting it in a comment.
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = Math.max(0, this.buffer.active.length - this.rows)
      this.onScrollListener?.(this.buffer.active.viewportY)
    })
    // viewportY is readonly on xterm v6's public type; scrollToLine is the
    // sanctioned writer. Mirrors scrollToBottom's clamping behavior.
    scrollToLine = vi.fn((line: number) => {
      this.buffer.active.viewportY = Math.max(0, Math.min(line, this.buffer.active.length - this.rows))
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
    write(_data: string, callback?: () => void) {
      if (!callback) return
      if (xtermHarness.deferWrites) xtermHarness.pendingWriteCallbacks.push(callback)
      else callback()
    }
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
  // The REAL sessionDataDispatcher is a module singleton that subscribes to
  // the window.api channel exactly once and keeps that subscription across
  // tests (its unsubscribe only runs on dispose/HMR). So the channel listener
  // captured by the FIRST mount stays valid for the whole file — later tests
  // must not null it, they only replace the per-session handler by remounting.
  // beforeEach therefore leaves this capture alone.
  let channelListener: ((event: PtyEvent) => void) | null = null
  const api = {
    attachAgentPty: vi.fn((_id: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn((listener: (event: PtyEvent) => void) => {
      channelListener = listener
      return () => {}
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

  function leaf(runtime: SessionRuntime = runtimeWith({}), leafSessionId = 'session-1') {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId={leafSessionId}>
          <AgentTerminalLeaf
            sessionId={leafSessionId}
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
    xtermHarness.deferWrites = false
    xtermHarness.pendingWriteCallbacks.length = 0
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

  it('follows PTY output through the dispatcher while per-session tail is on', async () => {
    render(leaf(runtimeWith({ tailMode: true })))
    await attachResolved()
    term().buffer.active.length = 500
    act(() => { channelListener?.({ sessionId: 'session-1', data: 'stream' }) })
    expect(term().scrollToBottom).toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(460)
  })

  it('pins after the attach replay when tail is on', async () => {
    xtermHarness.deferWrites = true
    render(leaf(runtimeWith({ tailMode: true })))
    await attachResolved('backfill')
    term().buffer.active.length = 500
    expect(term().scrollToBottom).not.toHaveBeenCalled()
    await act(async () => { xtermHarness.flushWriteCallbacks() })
    expect(term().buffer.active.viewportY).toBe(460)
  })

  it('leaves the viewport alone on PTY output while tail is off', async () => {
    render(leaf())
    await attachResolved()
    term().buffer.active.viewportY = 10
    term().buffer.active.length = 500
    act(() => { channelListener?.({ sessionId: 'session-1', data: 'stream' }) })
    expect(term().scrollToBottom).not.toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(10)
  })

  it('re-pins when the user scrolls away while tailing, deferred out of the scroll dispatch', async () => {
    render(leaf(runtimeWith({ tailMode: true })))
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 200 // user wheel-scrolled up
    act(() => { term().onScrollListener?.(200) })
    // Real xterm suppresses reentrant scroll handling: a synchronous pin from
    // inside the onScroll dispatch does not move the viewport. The handler
    // must schedule instead — nothing has moved yet.
    expect(term().buffer.active.viewportY).toBe(200)
    await act(async () => { await Promise.resolve() }) // flush the microtask
    expect(term().scrollToBottom).toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(460)
  })

  it('keeps the restored position when a queued write callback lands after tail-off', async () => {
    xtermHarness.deferWrites = true
    const view = render(leaf())
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 100
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) }) // engage, save line 100
    act(() => { channelListener?.({ sessionId: 'session-1', data: 'stream' }) }) // write queued, callback pending
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) }) // disengage, restore line 100
    expect(term().buffer.active.viewportY).toBe(100)
    act(() => { xtermHarness.flushWriteCallbacks() }) // xterm finishes parsing now
    expect(term().buffer.active.viewportY).toBe(100)
  })

  it('discards queued write and scroll work after unmount', async () => {
    const view = render(leaf(runtimeWith({ tailMode: true })))
    await attachResolved()
    xtermHarness.deferWrites = true
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 100
    act(() => { channelListener!({ sessionId: 'session-1', data: 'stream' }) })
    act(() => { term().onScrollListener!(100) })
    term().scrollToBottom.mockClear()
    view.unmount()
    await act(async () => { xtermHarness.flushWriteCallbacks() })
    expect(term().scrollToBottom).not.toHaveBeenCalled()
  })

  it('does not carry a saved position across a session swap in the same leaf', async () => {
    const view = render(leaf(runtimeWith({}), 'session-1'))
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 100
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }), 'session-1')) }) // session A saves line 100
    // TileTree swaps renderedSessionId under the mounted leaf; the mount
    // effect re-runs and builds a fresh xterm for session B.
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }), 'session-2')) })
    expect(term().markers.every(marker => marker.isDisposed)).toBe(true)
    const swapped = xtermHarness.instances.at(-1)!
    expect(swapped).not.toBe(term())
    swapped.buffer.active.length = 500
    swapped.buffer.active.viewportY = 460 // session B sits at the bottom
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }), 'session-2')) })
    // Without the session-identity reset, disengage restored A's line 100
    // inside B's terminal (review reproduction).
    expect(swapped.buffer.active.viewportY).toBe(460)
  })

  it('does not re-pin on scroll while tail is off', async () => {
    render(leaf())
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 100
    act(() => { term().onScrollListener?.(100) })
    expect(term().scrollToBottom).not.toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(100)
  })

  it('shows the TAIL pill in the header while tail is active', async () => {
    const view = render(leaf())
    await attachResolved()
    expect(screen.queryByText('TAIL')).toBeNull()
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
    expect(screen.getByText('TAIL')).toBeTruthy()
  })

  it('follows output when Tail All is on', async () => {
    appStore.tailAllMode = true
    render(leaf())
    await attachResolved()
    expect(screen.getByText('TAIL')).toBeTruthy()
    term().buffer.active.length = 500
    act(() => { channelListener?.({ sessionId: 'session-1', data: 'stream' }) })
    expect(term().buffer.active.viewportY).toBe(460)
  })

  it('stays inert for Tail All while the pane subtree is hidden', async () => {
    appStore.tailAllMode = true
    render(
      <AgentTerminalOwnerVisibilityProvider visible={false}>
        {leaf()}
      </AgentTerminalOwnerVisibilityProvider>,
    )
    await attachResolved()
    // Masked: no pill, no forced scroll on output — mirroring TileLeaf's
    // re-reveal argument for folding visibility into the tail mask.
    expect(screen.queryByText('TAIL')).toBeNull()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 10
    act(() => { channelListener?.({ sessionId: 'session-1', data: 'stream' }) })
    expect(term().scrollToBottom).not.toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(10)
  })

  describe('tail engage/disengage', () => {
    it('pins to bottom on engage and restores the pre-tail viewport line on disengage', async () => {
      const view = render(leaf())
      await attachResolved()
      term().buffer.active.length = 500
      term().buffer.active.viewportY = 100 // user scrolled up
      act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
      expect(term().scrollToBottom).toHaveBeenCalled()
      expect(term().buffer.active.viewportY).toBe(460) // 500 - rows(40)
      act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
      expect(term().buffer.active.viewportY).toBe(100)
    })

    it('keeps the bottom on disengage when tail engaged at the bottom', async () => {
      const view = render(leaf())
      await attachResolved()
      term().buffer.active.length = 500
      term().buffer.active.viewportY = 460 // at bottom
      act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
      act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
      expect(term().buffer.active.viewportY).toBe(460)
    })

    it('does not restore when tail was already on at mount (fresh terminal)', async () => {
      const view = render(leaf(runtimeWith({ tailMode: true })))
      await attachResolved()
      term().buffer.active.length = 500
      term().buffer.active.viewportY = 460 // user sat at the bottom
      act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
      // Engage happened before xterm existed — nothing was saved, disengage
      // must not invent a position and yank the user to the top.
      expect(term().buffer.active.viewportY).toBe(460)
    })
  })
})
