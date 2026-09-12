import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { act, render } from '@testing-library/react'
import { vi } from 'vitest'

import type { OpencodeTerminalLaunch } from 'opencode-terminal-headless'
import {
  buildReplayScript,
  FakePty,
  LiveFixtureWriter,
  nodeHttpFetch,
  ReplayServer,
  sessionRowFor,
  type LiveFixture,
  type ReplayStep,
} from 'opencode-terminal-headless/testing'

import type { LspManager } from '@main/lspManager'
import { SessionManager } from '@main/sessionManager'
import { wireSessionForwarder } from '@main/sessions/forwarder'
import { OpencodeTerminalSession } from '@providers/opencode/runtime/opencodeTerminalSession'
import type { ManagedAgentRecord } from '@mcp/shared/agentManagementTypes'
import type { OrchestrationLifecycleState } from '@mcp/shared/orchestrationTypes'
import { buildAgentStatusModel } from '@renderer/features/agent-status/model/agentStatusModel'
import { errorFields, identityFields, runtimeFields } from '@renderer/features/agent-status/model/formatAgentStatus'
import { createFakeSessionFeed, type FakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { listManagedAgentDescriptors } from '@renderer/workspace/agentManagementMcp'
import {
  dispatchActivity,
  dispatchSubtitle,
  dispatchUnreadBadge,
  type DispatchAgentActivity,
} from '@renderer/workspace/dispatch/DispatchAgentList'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import { useWorkspaceHelpers } from '@renderer/workspace/hook/helpers'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { listOrchestrationAgents } from '@renderer/workspace/orchestrationMcp'
import { paneHeaderStatusLit } from '@renderer/workspace/tile-tree/TileLeaf/paneHeaderStatus'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { useIpcSubscriptions } from '../useIpcSubscriptions'
import { mainStandIns } from './opencodeTerminalMainStandIns'
import { PANE_CWD, PARENT_ID, paneMeta, paneWorkspace, SESSION_ID, waitFor, type OpencodeTerminalScope } from './opencodeTerminalScope'
import { makeWorkspaceRefsForTest } from './workspaceRefsForTest'

// One OpenCode Terminal pane, driven by a recorded TUI session through the
// same code the app runs, top to bottom:
//
//   recorded OpenCode TUI session (real bus events + real durable rows)
//     → opencode-terminal-headless (real sockets, real SQLite)
//     → OpencodeTerminalSession adapter (real)
//     → SessionManager (real): per-session relay, ownership fence, readiness
//       revisions, cached conditions, exit → removed → exit
//     → wireSessionForwarder (real): JSONL / semantic / process-state
//       coalescers and their ordering barriers
//     → a structured clone per window message (what Electron IPC does)
//     → useIpcSubscriptions (real) with the workspace's real updateRuntime
//     → the pane's SessionRuntime
//
// and then the surfaces a user and an orchestrating parent read from that
// runtime, through their own pure functions: the pane header strip, the
// Dispatch row (activity, subtitle, badge), orchestration's lifecycle,
// Agent Management's list, the Agent Status panel and Copy Last Response.
//
// WHY this much of main is real: the harness this replaced forwarded adapter
// events straight into the feed, dropped `updateRuntime` on the floor and
// never let the PTY paint. So `session:started`, `input-readiness` and
// `jsonl-error` never reached the runtime, and main's coalescing (which is
// where a durable error once overtook the records before it, R4-F1) was not
// in the path at all. Everything a regression could hide in is now in it.
//
// What is still NOT modelled, deliberately:
// - The OpenCode TUI process. The PTY is a FakePty; its only output is the
//   one paint a test asks for, which is what arms the adapter's readiness.
// - The Electron transport. Main's `sendToSessionWindow` becomes a direct call
//   (after structuredClone) into a FakeSessionFeed, i.e. the preload's
//   channel subscription plus IpcSessionFeed's pass-through. Window routing,
//   ownership transfer and renderer reload are out of scope (adoption is
//   tested on its own).
// - Main-side modules with no bearing on this path are stand-ins (see
//   opencodeTerminalMainStandIns.ts for each one and why). Test files must
//   install them with `vi.mock` before importing this module.
// - React components. Surfaces are read through the pure functions the
//   components call, not by rendering them.

const USERNAME = 'opencode'
const PASSWORD = 'renderer-replay'

/** A caller-owned PTY that can also paint, like the TUI's first frame. */
export class AdapterPty extends FakePty {
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

export type PaneSurfaces = {
  sessionStatus: SessionRuntime['sessionStatus']
  streamPhase: SessionRuntime['streamPhase']
  processStatus: SessionRuntime['processStatus']
  inputReady: boolean
  transcriptStatus: SessionRuntime['transcriptStatus']
  /** The runtime's raw record of what happened while the user was away. */
  unreadKind: SessionRuntime['unreadKind']
  /** The pane header's status strip, with Status Mode on. */
  headerLit: boolean
  dispatchActivity: DispatchAgentActivity
  dispatchSubtitle: string
  /** The text the Dispatch row's badge paints (NEW, ACTION, …), or null. */
  dispatchBadge: string | null
  /** What `wait_agents` / `read_agent` report to the orchestrating parent. */
  lifecycle: OrchestrationLifecycleState | undefined
  managedBackend: ManagedAgentRecord['backendState'] | undefined
  managedActivity: ManagedAgentRecord['activityState'] | undefined
  /** Agent Status panel rows (runtime + errors), label → value. */
  agentStatus: Record<string, string>
  /** What Copy Last Response would put on the clipboard. */
  copyLastResponse: string | null
}

export function surfacesOf(state: WorkspaceState, runtimes: Record<SessionId, SessionRuntime>): PaneSurfaces {
  const runtime = runtimes[SESSION_ID] ?? emptyRuntime()
  const kind = state.sessions[SESSION_ID]?.kind
  const managed = listManagedAgentDescriptors({ state, runtimes, callerSessionId: PARENT_ID })
    .agents.find(item => item.agent.sessionId === SESSION_ID)?.agent
  const status = buildAgentStatusModel(state, runtime, SESSION_ID)
  const fields = status ? [...identityFields(status), ...runtimeFields(status), ...errorFields(status)] : []
  return {
    sessionStatus: runtime.sessionStatus,
    streamPhase: runtime.streamPhase,
    processStatus: runtime.processStatus,
    inputReady: runtime.inputReady,
    transcriptStatus: runtime.transcriptStatus,
    unreadKind: runtime.unreadKind,
    headerLit: paneHeaderStatusLit(true, runtime.sessionStatus === 'running'),
    dispatchActivity: dispatchActivity(runtime),
    dispatchSubtitle: dispatchSubtitle(runtime, kind),
    dispatchBadge: dispatchUnreadBadge(runtime, kind)?.text ?? null,
    lifecycle: listOrchestrationAgents({ state, runtimes, parentSessionId: PARENT_ID })
      .find(record => record.sessionId === SESSION_ID)?.lifecycleState,
    managedBackend: managed?.backendState,
    managedActivity: managed?.activityState,
    agentStatus: Object.fromEntries(fields.map(field => [field.label, field.value])),
    copyLastResponse: extractLastAssistantText(runtime.entries, kind ?? 'opencode'),
  }
}

// The preload subscribes one channel per SessionFeed method and IpcSessionFeed
// passes each through untouched; this is that mapping. A channel with no feed
// method (transcript diagnostics, raw PTY bytes) reaches no runtime in the app
// either, so it is recorded and not delivered.
function deliverToFeed(feed: FakeSessionFeed, channel: string, payload: unknown): boolean {
  switch (channel) {
    case 'session:started': feed.emitStarted(payload as Parameters<FakeSessionFeed['emitStarted']>[0]); return true
    case 'session:input-readiness': feed.emitInputReadiness(payload as Parameters<FakeSessionFeed['emitInputReadiness']>[0]); return true
    case 'session:jsonl-entries': feed.emitJsonlEntries(payload as Parameters<FakeSessionFeed['emitJsonlEntries']>[0]); return true
    case 'session:jsonl-error': feed.emitJsonlError(payload as Parameters<FakeSessionFeed['emitJsonlError']>[0]); return true
    case 'session:process-state': feed.emitProcessState(payload as Parameters<FakeSessionFeed['emitProcessState']>[0]); return true
    case 'session:conditions': feed.emitConditions(payload as Parameters<FakeSessionFeed['emitConditions']>[0]); return true
    case 'session:semantic-event': feed.emitSemantic(payload as Parameters<FakeSessionFeed['emitSemantic']>[0]); return true
    case 'session:sub-agents': feed.emitSubAgents(payload as Parameters<FakeSessionFeed['emitSubAgents']>[0]); return true
    case 'session:exit': feed.emitExit(payload as Parameters<FakeSessionFeed['emitExit']>[0]); return true
    default: return false
  }
}

export type MountedPane = {
  meta: SessionMeta
  refs: WorkspaceRefs
  state: () => WorkspaceState
  runtime: () => SessionRuntime
  runtimes: () => Record<SessionId, SessionRuntime>
  setRuntimes: WorkspaceSetRuntimes
  surfaces: () => PaneSurfaces
  /** The surfaces after every window message the renderer received. */
  timeline: PaneSurfaces[]
  /** Every window message main sent for the pane, by channel, in order. */
  channels: string[]
  /** `session:transcript-diagnostic` payloads (no SessionFeed method reads them). */
  diagnostics: Array<Record<string, unknown>>
}

type PaneHarnessProps = {
  feed: FakeSessionFeed
  refs: WorkspaceRefs
  setState: WorkspaceSetState
  setRuntimes: WorkspaceSetRuntimes
}

// The workspace hook's own wiring (hook/index.ts): useWorkspaceHelpers supplies
// updateRuntime/appendFeedDebug, which useIpcSubscriptions writes through.
function PaneHarness({ feed, refs, setState, setRuntimes }: PaneHarnessProps): null {
  const { updateRuntime, appendFeedDebug } = useWorkspaceHelpers(setRuntimes, refs)
  useIpcSubscriptions(feed, refs, setState, setRuntimes, updateRuntime, appendFeedDebug)
  return null
}

export type RecordedPaneOptions = {
  /**
   * Where the durable channel reads. Omitted: a fresh database the replay
   * writes into. A string: that file as it is (a database the store refuses,
   * say). `{ error }`: OpenCode could not tell the launch where its database
   * is, which is how `prepareOpencodeTerminalLaunch` reports it.
   */
  database?: string | { error: string }
}

export type RecordedPane = MountedPane & {
  manager: SessionManager
  pty: AdapterPty
  server: ReplayServer
  /** Null when the pane reads a database the test supplied as-is. */
  writer: LiveFixtureWriter | null
  dbPath: string | null
  script: ReplayStep[]
  /** Deliver whatever main's coalescers still hold, now. */
  flushMain: () => void
}

/** Live panes for a test file; their backends are torn down by the scope. */
export function opencodeTerminalPanes(scope: OpencodeTerminalScope) {
  function mountPane(meta: SessionMeta): MountedPane {
    let state = paneWorkspace(meta)
    let runtimes: Record<SessionId, SessionRuntime> = { [SESSION_ID]: emptyRuntime() }
    const refs = makeWorkspaceRefsForTest(state)
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
    const pane: MountedPane = {
      meta,
      refs,
      state: () => state,
      runtime: () => runtimes[SESSION_ID]!,
      runtimes: () => runtimes,
      setRuntimes,
      surfaces: () => surfacesOf(state, runtimes),
      timeline: [],
      channels: [],
      diagnostics: [],
    }
    mainStandIns.deliver = (_sessionId, channel, payload) => {
      pane.channels.push(channel)
      const cloned = structuredClone(payload)
      let delivered = false
      act(() => {
        delivered = deliverToFeed(feed, channel, cloned)
      })
      if (!delivered && channel === 'session:transcript-diagnostic') {
        pane.diagnostics.push((cloned as { diagnostic: Record<string, unknown> }).diagnostic)
      }
      pane.timeline.push(pane.surfaces())
    }
    scope.onCleanup(() => {
      mainStandIns.deliver = () => {}
      mainStandIns.createTerminalSession = null
    })
    const mounted = render(<PaneHarness feed={feed} refs={refs} setState={setState} setRuntimes={setRuntimes} />)
    scope.onCleanup(() => mounted.unmount())
    return pane
  }

  async function startRecordedPane(recording: LiveFixture, options: RecordedPaneOptions = {}): Promise<RecordedPane> {
    let dbPath: string | null
    let dbPathError: string | undefined
    let writer: LiveFixtureWriter | null = null
    if (options.database === undefined) {
      dbPath = join(scope.dir(), `${recording.scenario}.db`)
      const ownWriter = new LiveFixtureWriter(dbPath, recording.sessionID, sessionRowFor(recording.sessionID))
      scope.onCleanup(() => ownWriter.close())
      writer = ownWriter
    } else if (typeof options.database === 'string') {
      dbPath = options.database
    } else {
      dbPath = null
      dbPathError = options.database.error
    }

    const server = new ReplayServer({ username: USERNAME, password: PASSWORD })
    await server.listen()
    scope.onCleanup(() => server.close())

    const pty = new AdapterPty()
    mainStandIns.createTerminalSession = sessionOptions => new OpencodeTerminalSession(sessionOptions, {
      spawnPty: (() => pty) as never,
      prepareLaunch: async (launchOptions): Promise<OpencodeTerminalLaunch> => ({
        binary: launchOptions.binary,
        args: [],
        env: launchOptions.env,
        sessionID: launchOptions.sessionID,
        server: { url: server.url, username: USERNAME, password: PASSWORD },
        dbPath,
        ...(dbPathError ? { dbPathError } : {}),
      }),
      // Heartbeat off: its periodic activity re-publish is not in any
      // recording and would make the timeline depend on wall time.
      headlessOptions: { fetch: nodeHttpFetch, heartbeatMs: 0, durablePollIntervalMs: 40, sseInitialBackoffMs: 20, sseMaxBackoffMs: 80 },
    })

    const pane = mountPane(paneMeta(recording.sessionID))
    const manager = new SessionManager()
    const forwarder = wireSessionForwarder(manager, new EventEmitter() as unknown as LspManager)
    scope.onCleanup(async () => {
      await manager.killAll()
      forwarder.flush()
      manager.removeAllListeners()
    })

    // `recover` under the pane's persisted id is how a rehydrated or woken
    // pane gets its backend, and it keeps the local id stable for the
    // renderer state this harness seeded before any event arrives.
    const recovered = await manager.recover({
      sessionId: SESSION_ID,
      kind: 'opencode',
      providerRuntime: 'terminal',
      cwd: PANE_CWD,
      resumeSessionId: recording.sessionID,
    })
    if (!recovered.ok) throw new Error(`recover failed: ${recovered.message}`)

    // The TUI's first frame. The adapter treats first output plus a short
    // grace as "composer ready"; nothing else in this harness paints.
    pty.paint('\u001b[?1049h')
    await waitFor(() => pane.diagnostics.some(diagnostic => diagnostic.connected === true), 'live channel connected')
    // All three re-sync reads have reached the server. The package drops any
    // part of a snapshot that live events overtook, so the replay may start
    // while the answers are still in flight.
    await waitFor(() => ['/session/status', '/permission', '/question'].every(path => server.calls.some(call => call.path === path)), 're-sync reads')

    return {
      ...pane,
      manager,
      pty,
      server,
      writer,
      dbPath,
      script: buildReplayScript(recording),
      flushMain: () => forwarder.flush(),
    }
  }

  return { mountPane, startRecordedPane }
}
