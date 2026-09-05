import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalEditorWorkspaceSlot } from '@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot'
import { AgentInlineTerminal } from '@renderer/features/debug/ui/AgentInlineTerminal'
import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'
import { TerminalLeaf } from './TerminalLeaf'

type MockTerminal = {
  cols: number
  rows: number
  container: HTMLElement | null
  onDataListener: ((data: string) => void) | null
  writes: string[]
  dispose: ReturnType<typeof vi.fn>
  inputDispose: ReturnType<typeof vi.fn>
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
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
    writes: string[] = []
    onDataListener: ((data: string) => void) | null = null
    dispose = vi.fn()
    inputDispose = vi.fn(() => { this.onDataListener = null })
    constructor() { xtermHarness.instances.push(this) }
    loadAddon() {}
    open(container: HTMLElement) { this.container = container }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener
      return { dispose: this.inputDispose }
    }
    // Real xterm reports each write parsed via the callback; the input
    // forwarder (#745) holds its replay latch until then, so a mock that
    // never calls back would model a pane that is deaf forever.
    write(data: string, callback?: () => void) {
      this.writes.push(data)
      // A replay containing DSR queries used to flood stdin with stale cursor
      // replies. Generate a reply while parsing so the host tests exercise the
      // real input forwarder's suppression boundary, not merely its happy path.
      if (data.includes('\x1b[6n')) this.onDataListener?.('\x1b[1;1R')
      if (data.includes('\x1b]10;?\x07')) this.onDataListener?.('\x1b]10;rgb:ffff/ffff/ffff\x07')
      callback?.()
    }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() { xtermHarness.fit() }
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
  const resize = vi.fn<(sessionId: string, cols: number, rows: number) => Promise<void>>()
    .mockResolvedValue(undefined)
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  let observers: Array<{ notify(): void; disconnect: ReturnType<typeof vi.fn> }>
  type DataListener = (event: { sessionId: string; data: string }) => void
  const agentListeners = new Set<DataListener>()
  const shellListeners = new Set<DataListener>()
  // The production dispatcher intentionally owns one preload subscription for
  // the window's lifetime. Keep the same bridge and channel listeners across
  // tests: replacing them per test would strand the singleton on a fake old
  // window and make every subsequent mount appear to lose its output.
  const api = {
    attachAgentPty: vi.fn((_sessionId: string) => attach.promise),
    attachTerminal: vi.fn((_sessionId: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn((listener: DataListener) => {
      agentListeners.add(listener)
      return () => { agentListeners.delete(listener) }
    }),
    onSessionTerminalData: vi.fn((listener: DataListener) => {
      shellListeners.add(listener)
      return () => { shellListeners.delete(listener) }
    }),
    resize,
    sendInput: vi.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    attach = deferred<string | null>()
    resize.mockClear()
    nextFrameId = 0
    frames = new Map()
    observers = []
    xtermHarness.fit.mockClear()
    xtermHarness.instances.length = 0
    xtermHarness.attachWebgl.mockReset()
    xtermHarness.attachWebgl.mockImplementation(() => ({
      ready: Promise.resolve(true),
      dispose: vi.fn(),
    }))
    api.attachAgentPty.mockReset().mockImplementation(() => attach.promise)
    api.attachTerminal.mockReset().mockImplementation(() => attach.promise)
    api.detachAgentPty.mockClear()
    api.sendInput.mockClear()
    workspace.acknowledgeSession = vi.fn()

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
    // ResizeObserver must remain under test control: a real layout drag can
    // report dozens of notifications before one frame. Letting happy-dom choose
    // callback timing would hide the redundant fit/resize work we are guarding.
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn()
      constructor(private callback: ResizeObserverCallback) { observers.push(this) }
      observe() {}
      unobserve() {}
      notify() { this.callback([], this as unknown as ResizeObserver) }
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api,
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
    const terminal = xtermHarness.instances[0]!
    expect(terminal.onDataListener).not.toBeNull()
    expect(api.sendInput).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(terminal.container!, { key: 'x' })
      terminal.onDataListener!('x')
      await Promise.resolve()
    })
    expect(api.sendInput).toHaveBeenCalledWith('session-1', 'x')
    expect(workspace.acknowledgeSession).toHaveBeenCalledWith('session-1')
  })

  function agentPane(sessionId: string) {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId={sessionId}>
          <AgentTerminalLeaf
            sessionId={sessionId}
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={{ ...emptyRuntime(), processStatus: 'started' }}
            projectDir="/tmp/project"
            provider="claude"
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  function shellPane(sessionId: string) {
    return (
      <TerminalLeaf
        sessionId={sessionId}
        focused
        onFocusRequest={() => {}}
        workspace={workspace}
      />
    )
  }

  function emit(listeners: Set<DataListener>, sessionId: string, data: string) {
    for (const listener of listeners) listener({ sessionId, data })
  }

  it('shares subscriptions across mounted hosts while preserving replay, session routing, and input', async () => {
    // Mount the actual three host implementations, including concurrent pane
    // and debug views of one agent. Dispatcher unit tests alone cannot catch a
    // host accidentally retaining its old direct preload listener alongside the
    // shared path, which would restore the per-pane repaint fanout.
    const view = render(<>
      {agentPane('agent-a')}
      {agentPane('agent-b')}
      <AgentInlineTerminal sessionId="agent-a" active />
      {shellPane('agent-a')}
      {shellPane('shell-b')}
    </>)
    await act(async () => { await Promise.resolve() })
    expect(xtermHarness.instances).toHaveLength(5)
    const [agentA, agentB, inlineA, shellA, shellB] = xtermHarness.instances
    expect(api.onSessionAgentPtyData).toHaveBeenCalledTimes(1)
    expect(api.onSessionTerminalData).toHaveBeenCalledTimes(1)
    expect(agentListeners.size).toBe(1)
    expect(shellListeners.size).toBe(1)
    expect(api.attachAgentPty.mock.calls.map(([id]) => id)).toEqual(['agent-a', 'agent-b', 'agent-a'])
    expect(api.attachTerminal.mock.calls.map(([id]) => id)).toEqual(['agent-a', 'shell-b'])

    act(() => {
      emit(agentListeners, 'agent-a', 'queued agent A')
      emit(agentListeners, 'agent-b', 'queued agent B')
      // The deliberate shared id across channels catches routing by session
      // alone: shell bytes must never leak into an agent with the same id.
      emit(shellListeners, 'agent-a', 'queued shell A')
      emit(shellListeners, 'shell-b', 'queued shell B')
    })
    for (const terminal of xtermHarness.instances) expect(terminal.writes).toEqual([])
    await act(async () => {
      attach.resolve('replay\x1b[6n')
      await attach.promise
    })
    expect(agentA!.writes).toEqual(['replay\x1b[6n', 'queued agent A'])
    expect(inlineA!.writes).toEqual(agentA!.writes)
    expect(agentB!.writes).toEqual(['replay\x1b[6n', 'queued agent B'])
    expect(shellA!.writes).toEqual(['replay\x1b[6n', 'queued shell A'])
    expect(shellB!.writes).toEqual(['replay\x1b[6n', 'queued shell B'])
    expect(api.sendInput).not.toHaveBeenCalled()

    act(() => {
      emit(agentListeners, 'agent-a', 'live agent A')
      emit(shellListeners, 'shell-b', 'live shell B')
      emit(agentListeners, 'missing-session', 'unowned output')
    })
    expect(agentA!.writes).toEqual(['replay\x1b[6n', 'queued agent A', 'live agent A'])
    expect(inlineA!.writes).toEqual(agentA!.writes)
    expect(agentB!.writes).toEqual(['replay\x1b[6n', 'queued agent B'])
    expect(shellA!.writes).toEqual(['replay\x1b[6n', 'queued shell A'])
    expect(shellB!.writes).toEqual(['replay\x1b[6n', 'queued shell B', 'live shell B'])
    await act(async () => {
      for (const [index, terminal] of xtermHarness.instances.entries()) {
        terminal.onDataListener!(`key-${index}`)
      }
      await Promise.resolve()
    })
    expect(api.sendInput.mock.calls).toEqual([
      ['agent-a', 'key-0'], ['agent-b', 'key-1'], ['agent-a', 'key-2'],
      ['agent-a', 'key-3'], ['shell-b', 'key-4'],
    ])

    expect(xtermHarness.attachWebgl).toHaveBeenCalledTimes(5)
    for (const [index, terminal] of xtermHarness.instances.entries()) {
      expect(xtermHarness.attachWebgl).toHaveBeenNthCalledWith(index + 1, terminal)
      expect(xtermHarness.attachWebgl.mock.results[index]!.value.dispose).not.toHaveBeenCalled()
    }
    view.unmount()
    for (const [index, terminal] of xtermHarness.instances.entries()) {
      expect(terminal.dispose).toHaveBeenCalledTimes(1)
      expect(terminal.inputDispose).toHaveBeenCalledTimes(1)
      expect(xtermHarness.attachWebgl.mock.results[index]!.value.dispose).toHaveBeenCalledTimes(1)
    }
  })

  it('removes stale host callbacks across unmount and remount without resubscribing the window', async () => {
    const hosts = () => <>
      {agentPane('remounted-agent')}
      <AgentInlineTerminal sessionId="remounted-agent" active />
      {shellPane('remounted-shell')}
    </>
    const first = render(hosts())
    await act(async () => {
      attach.resolve('old replay')
      await attach.promise
    })
    const oldTerminals = [...xtermHarness.instances]
    const oldWrites = oldTerminals.map(terminal => [...terminal.writes])
    first.unmount()
    act(() => {
      emit(agentListeners, 'remounted-agent', 'between mounts')
      emit(shellListeners, 'remounted-shell', 'between mounts')
    })
    expect(oldTerminals.map(terminal => terminal.writes)).toEqual(oldWrites)

    attach = deferred<string | null>()
    const second = render(hosts())
    await act(async () => {
      attach.resolve('new replay')
      await attach.promise
    })
    act(() => {
      emit(agentListeners, 'remounted-agent', 'new agent output')
      emit(shellListeners, 'remounted-shell', 'new shell output')
    })
    expect(oldTerminals.map(terminal => terminal.writes)).toEqual(oldWrites)
    expect(xtermHarness.instances.slice(3).map(terminal => terminal.writes)).toEqual([
      ['new replay', 'new agent output'],
      ['new replay', 'new agent output'],
      ['new replay', 'new shell output'],
    ])
    expect(api.onSessionAgentPtyData).toHaveBeenCalledTimes(1)
    expect(api.onSessionTerminalData).toHaveBeenCalledTimes(1)
    second.unmount()
    for (const result of xtermHarness.attachWebgl.mock.results) {
      expect(result.value.dispose).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['agent', 'shell'] as const)(
    'forwards live terminal replies without acknowledging the %s pane, but acknowledges DOM engagement',
    async kind => {
      const sessionId = `engagement-${kind}`
      render(kind === 'agent' ? agentPane(sessionId) : shellPane(sessionId))
      await act(async () => {
        attach.resolve('')
        await attach.promise
      })
      const terminal = xtermHarness.instances[0]!
      // Live CSI/OSC probes legitimately need responses. They are generated by
      // xterm while parsing output, though, and must not mark a background agent
      // read or push workspace state on every provider repaint. Escape filtering
      // alone cannot solve this because genuine keyboard input also uses CSI.
      await act(async () => {
        emit(kind === 'agent' ? agentListeners : shellListeners, sessionId, '\x1b[6n\x1b]10;?\x07')
        await Promise.resolve()
      })
      expect(api.sendInput.mock.calls).toEqual([
        [sessionId, '\x1b[1;1R\x1b]10;rgb:ffff/ffff/ffff\x07'],
      ])
      expect(workspace.acknowledgeSession).not.toHaveBeenCalled()
      await act(async () => {
        terminal.onDataListener!('synthetic input')
        await Promise.resolve()
      })
      expect(api.sendInput).toHaveBeenLastCalledWith(sessionId, 'synthetic input')
      expect(workspace.acknowledgeSession).not.toHaveBeenCalled()

      // Keyboard, clipboard, and IME engagement enter through different DOM
      // events. Checking each independently prevents the performance fix from
      // restoring unread-state correctness only for ordinary physical typing.
      fireEvent.keyDown(terminal.container!, { key: 'ArrowUp' })
      expect(workspace.acknowledgeSession).toHaveBeenCalledTimes(1)
      fireEvent.paste(terminal.container!)
      expect(workspace.acknowledgeSession).toHaveBeenCalledTimes(2)
      fireEvent.compositionEnd(terminal.container!, { data: '字' })
      expect(workspace.acknowledgeSession).toHaveBeenCalledTimes(3)
      fireEvent.mouseDown(terminal.container!)
      expect(workspace.acknowledgeSession).toHaveBeenCalledTimes(4)
      expect(vi.mocked(workspace.acknowledgeSession).mock.calls).toEqual([
        [sessionId], [sessionId], [sessionId], [sessionId],
      ])
    },
  )

  it('coalesces inline-terminal layout bursts and only resizes the backend when grid dimensions change', async () => {
    const view = render(<AgentInlineTerminal sessionId="inline-layout" active />)
    await act(async () => {
      attach.resolve('')
      await attach.promise
    })
    const terminal = xtermHarness.instances[0]!
    expect(observers).toHaveLength(1)
    const observer = observers[0]!
    // Include initial fit in the same burst: debug-rail mount and a surrounding
    // layout commit may both request measurement before the very first paint.
    act(() => {
      for (let index = 0; index < 100; index += 1) observer.notify()
    })
    expect(frames.size).toBe(1)
    expect(xtermHarness.fit).not.toHaveBeenCalled()
    act(() => flushAnimationFrames())
    expect(xtermHarness.fit).toHaveBeenCalledTimes(1)
    expect(resize.mock.calls).toEqual([['inline-layout', 120, 40]])

    act(() => {
      for (let index = 0; index < 100; index += 1) observer.notify()
    })
    expect(frames.size).toBe(1)
    act(() => flushAnimationFrames())
    expect(xtermHarness.fit).toHaveBeenCalledTimes(2)
    expect(resize).toHaveBeenCalledTimes(1)

    // A pixel-size notification need not change the character grid. Keep the
    // dimensions explicit so this test catches both missing changed-grid writes
    // and unnecessary unchanged-grid IPC without depending on browser fonts.
    terminal.cols = 96
    terminal.rows = 28
    act(() => {
      observer.notify()
      observer.notify()
    })
    expect(frames.size).toBe(1)
    act(() => flushAnimationFrames())
    expect(xtermHarness.fit).toHaveBeenCalledTimes(3)
    expect(resize.mock.calls).toEqual([
      ['inline-layout', 120, 40], ['inline-layout', 96, 28],
    ])

    // Font changes can alter character geometry while the outer box stays the
    // same, so relying exclusively on ResizeObserver leaves the PTY mis-sized.
    terminal.cols = 90
    act(() => {
      window.dispatchEvent(new Event('agent-code:test-theme-change'))
      window.dispatchEvent(new Event('agent-code:test-theme-change'))
    })
    expect(frames.size).toBe(1)
    act(() => flushAnimationFrames())
    expect(xtermHarness.fit).toHaveBeenCalledTimes(4)
    expect(resize).toHaveBeenLastCalledWith('inline-layout', 90, 28)

    view.rerender(<AgentInlineTerminal sessionId="inline-layout" active />)
    expect(xtermHarness.instances).toHaveLength(1)
    expect(api.attachAgentPty).toHaveBeenCalledTimes(1)
    act(() => observer.notify())
    expect(frames.size).toBe(1)
    view.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    act(() => flushAnimationFrames())
    expect(xtermHarness.fit).toHaveBeenCalledTimes(4)
    expect(resize).toHaveBeenCalledTimes(3)
  })
})
