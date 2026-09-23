import { EventEmitter } from 'node:events'

import { act, render } from '@testing-library/react'
import { vi } from 'vitest'

import { createReplaySandbox, FakePty, playReplay, type LiveFixture, type ReplayOptions, type ReplaySandbox } from 'pi-terminal-headless/testing/index'

import type { LspManager } from '@main/lspManager'
import { SessionManager } from '@main/sessionManager'
import { wireSessionForwarder } from '@main/sessions/forwarder'
import { PiSession } from '@providers/pi/runtime/piSession'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { mainStandIns } from './opencodeTerminalMainStandIns'
import { deliverToFeed, PaneHarness, surfacesOf, type PaneSurfaces } from './opencodeTerminalPane'
import { waitFor } from './opencodeTerminalScope'
import { makeWorkspaceRefsForTest } from './workspaceRefsForTest'

// One Pi pane, driven by a Stage 0 recording of the real pi 0.87.1 through
// the same code the app runs, top to bottom:
//
//   recorded pi session (the bridge's real events over a real Unix socket,
//   the session file written byte for byte in pi's own order)
//     → pi-terminal-headless (real: BridgeServer, DurableReader, sequencer)
//     → PiSession adapter (real)
//     → SessionManager (real): terminal-only runtime resolution, per-session
//       relay, ownership fence, readiness, transcript-file cache
//     → wireSessionForwarder (real): coalescers and ordering barriers
//     → a structured clone per window message (what Electron IPC does)
//     → useIpcSubscriptions (real) with the workspace's real updateRuntime
//     → the pane's SessionRuntime and its workspace meta
//
// and then the surfaces a user and an orchestrating parent read from those,
// through the same pure functions the components call.
//
// The pane is created the way the catalog, a split chord or a provider
// switch creates it: kind 'pi' with NO providerRuntime. That is the shape the
// terminal-only resolution exists for, so it is the one worth running.
//
// Not modelled: pi itself (the replay stands in for it, and the live tier
// runs the real one), the Electron transport (a structured clone into a
// FakeSessionFeed), and main modules with no bearing on this path (the
// stand-ins test files install with vi.mock; see
// opencodeTerminalMainStandIns.ts, which this harness shares).

export const PI_PANE = 'pi-pane' as SessionId
export const PI_PARENT = 'pi-orchestrator' as SessionId
export const PI_CWD = '/sandbox/project'

/** A caller-owned PTY that can paint, like the TUI's first frame. */
export class PiAdapterPty extends FakePty {
  readonly kill = vi.fn(() => this.exit(0, 15))
  private readonly dataListeners = new Set<(data: string) => void>()
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }
  paint(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }
}

export type PiPane = {
  manager: SessionManager
  sandbox: ReplaySandbox
  pty: PiAdapterPty
  state: () => WorkspaceState
  meta: () => SessionMeta
  runtime: () => SessionRuntime
  surfaces: () => PaneSurfaces
  /** Surfaces after every window message the renderer received. */
  timeline: PaneSurfaces[]
  /** The live condition kinds after every window message (same indexes). */
  conditionTimeline: string[][]
  channels: string[]
  /** Play the recording through, once (a replay cannot resume). */
  play: (options?: ReplayOptions) => Promise<void>
  flushMain: () => void
}

export function piPaneMeta(): SessionMeta {
  return {
    cwd: PI_CWD,
    kind: 'pi',
    // Deliberately no providerRuntime (see the header).
    orchestrationParentId: PI_PARENT,
    orchestrationRootId: PI_PARENT,
    orchestrationRunId: 'run-1',
    orchestrationRole: 'child',
  }
}

function piWorkspace(meta: SessionMeta): WorkspaceState {
  return {
    tabs: [{ id: 'project', title: 'project' }],
    activeTabId: 'project',
    stage: freshStage(),
    sessions: {
      [PI_PARENT]: { cwd: PI_CWD, kind: 'claude', projectId: 'project', joinedAt: 0 },
      [PI_PANE]: { ...meta, projectId: 'project', joinedAt: 1 },
    },
    pinnedSessionIds: [],
  }
}

/**
 * Start a Pi pane on a recording. The caller owns cleanup through
 * `onCleanup` (every step runs even when an earlier one throws).
 */
export async function startRecordedPiPane(fixture: LiveFixture, onCleanup: (cleanup: () => unknown) => void, options: { noBridge?: boolean } = {}): Promise<PiPane> {
  const sandbox = createReplaySandbox(fixture)
  onCleanup(() => sandbox.cleanup())
  // The one bridge call these paths make (the live worktree reconciler); the
  // pane has no git repository, which is the answer it gets.
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', { configurable: true, value: { gitWorktrees: vi.fn(async () => ({ ok: false })) } })
  onCleanup(() => {
    if (originalApi) Object.defineProperty(window, 'api', originalApi)
    else Reflect.deleteProperty(window, 'api')
  })

  let state = piWorkspace(piPaneMeta())
  let runtimes: Record<SessionId, SessionRuntime> = { [PI_PANE]: emptyRuntime() }
  const refs: WorkspaceRefs = makeWorkspaceRefsForTest(state)
  refs.latestRuntimesRef.current = runtimes
  const feed = createFakeSessionFeed()
  const setState: WorkspaceSetState = next => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  const setRuntimes: WorkspaceSetRuntimes = next => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  const surfaces = () => surfacesOf(state, runtimes, PI_PANE, PI_PARENT)
  const timeline: PaneSurfaces[] = []
  const conditionTimeline: string[][] = []
  const channels: string[] = []
  mainStandIns.deliver = (_sessionId, channel, payload) => {
    channels.push(channel)
    const cloned = structuredClone(payload)
    act(() => { deliverToFeed(feed, channel, cloned) })
    timeline.push(surfaces())
    conditionTimeline.push(Object.keys(runtimes[PI_PANE]?.conditions?.conditions ?? {}))
  }
  const pty = new PiAdapterPty()
  mainStandIns.createTerminalSession = sessionOptions => new PiSession(sessionOptions, {
    spawnPty: (() => pty) as never,
    prepareLaunch: (async () => sandbox.launch) as never,
    bridgeScriptPath: '/staged/bridge.ts',
    newSessionId: () => fixture.sessionIdLaunched!,
    // Heartbeat off: its periodic re-publish is in no recording and would make
    // the timeline depend on wall time.
    headlessOptions: { heartbeatMs: 0, fastPollMs: 20, slowPollMs: 200, discoverPollMs: 20, bridgeConnectDeadlineMs: 400 },
  })
  onCleanup(() => {
    mainStandIns.deliver = () => {}
    mainStandIns.createTerminalSession = null
  })
  const mounted = render(<PaneHarness feed={feed} refs={refs} setState={setState} setRuntimes={setRuntimes} />)
  onCleanup(() => mounted.unmount())

  const manager = new SessionManager()
  const forwarder = wireSessionForwarder(manager, new EventEmitter() as unknown as LspManager)
  onCleanup(async () => {
    await manager.killAll()
    forwarder.flush()
    manager.removeAllListeners()
  })

  // Kind only: main must resolve Pi to its terminal runtime by itself.
  const recovered = await manager.recover({ sessionId: PI_PANE, kind: 'pi', cwd: PI_CWD })
  if (!recovered.ok) throw new Error(`recover failed: ${recovered.message}`)
  pty.paint('\u001b[?1049h')

  const pane: PiPane = {
    manager,
    sandbox,
    pty,
    state: () => state,
    meta: () => state.sessions[PI_PANE]!,
    runtime: () => runtimes[PI_PANE]!,
    surfaces,
    timeline,
    conditionTimeline,
    channels,
    play: async (replayOptions = {}) => {
      await playReplay(fixture, sandbox, { ...replayOptions, ...(options.noBridge ? { noBridge: true } : {}) })
    },
    flushMain: () => forwarder.flush(),
  }
  return pane
}

export { waitFor }
