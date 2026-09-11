import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { render } from '@testing-library/react'
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Agent Code's node-pty is built for Electron's ABI; the adapter's spawn is
// injected below, so the module only has to be importable.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import type { OpencodeTerminalLaunch } from 'opencode-terminal-headless'
import {
  buildReplayScript,
  ensureAbortSignalTimeout,
  FakePty,
  LiveFixtureWriter,
  loadLiveFixture,
  nodeHttpFetch,
  playReplay,
  ReplayServer,
  sessionRowFor,
  settle,
  waitUntil,
  type LiveFixture,
  type ReplayStep,
} from 'opencode-terminal-headless/testing/index'

import { createOpencodeHistorySource } from '@providers/opencode/runtime/opencodeHistory'
import { OpencodeTerminalSession } from '@providers/opencode/runtime/opencodeTerminalSession'
import type { ConditionCustomAction } from '@shared/types/providerConditions'
import type { Entry } from '@shared/types/transcript'
import { createFakeSessionFeed, type FakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import {
  commandAllowedByRenderedViewPolicy,
  getEffectiveAgentSurfaceForSession,
  type RenderedViewPolicy,
} from '@renderer/workspace/agentDisplayMode'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { listOrchestrationAgents } from '@renderer/workspace/orchestrationMcp'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { makeWorkspaceRefsForTest } from './testing/workspaceRefsForTest'
import { useIpcSubscriptions } from './useIpcSubscriptions'

// The whole stack, top to bottom, for an OpenCode Terminal pane:
//
//   recorded OpenCode TUI session (real bus events + real durable rows)
//     → opencode-terminal-headless (real sockets, real SQLite)
//     → OpencodeTerminalSession adapter (real)
//     → the IPC events SessionManager forwards
//     → useIpcSubscriptions (real) → the pane's SessionRuntime
//
// and then what a user and an orchestrating parent actually see: running
// while the agent works and idle after, the NEW and ACTION badges, the
// conversation in runtime.entries, and orchestration's lifecycle moving from
// running to completed. This is the regression #857 describes (permanently
// idle) and #864's acceptance criteria, checked end to end instead of layer
// by layer.
//
// WHY node:http fetch is injected: happy-dom replaces the global fetch, and
// the live channel needs a real streaming socket for the TUI server's SSE.

class AdapterPty extends FakePty {
  readonly kill = vi.fn(() => this.exit(0, 15))
  onData(): { dispose(): void } {
    return { dispose: () => undefined }
  }
}

const SESSION_ID = 'opencode-terminal-pane' as SessionId
const PARENT_ID = 'orchestrating-parent' as SessionId
const PASSWORD = 'renderer-replay'
const originalWindowApi = window.api

let dir: string
let cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  ensureAbortSignalTimeout()
  dir = mkdtempSync(join(tmpdir(), 'oc-terminal-renderer-'))
  cleanups = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
  })
})
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
  if (originalWindowApi === undefined) Reflect.deleteProperty(window, 'api')
  else Object.defineProperty(window, 'api', { configurable: true, value: originalWindowApi })
})

type View = {
  sessionStatus: SessionRuntime['sessionStatus']
  streamPhase: SessionRuntime['streamPhase']
  unreadKind: SessionRuntime['unreadKind']
  attentionLabel: string | null
  lifecycle: string | undefined
}

function paneMeta(recording: LiveFixture): SessionMeta {
  return {
    cwd: '/sandbox/project',
    kind: 'opencode',
    providerRuntime: 'terminal',
    providerSessionId: recording.sessionID,
    providerSessionIdSource: 'jsonl-entry',
    orchestrationParentId: PARENT_ID,
    orchestrationRootId: PARENT_ID,
    orchestrationRunId: 'run-1',
    orchestrationRole: 'child',
  } as unknown as SessionMeta
}

function mountPane(recording: LiveFixture) {
  const meta = paneMeta(recording)
  let state = { sessions: { [SESSION_ID]: meta } } as unknown as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = { [SESSION_ID]: emptyRuntime() }
  let refs!: WorkspaceRefs
  const feed = createFakeSessionFeed()
  const commitRuntimes = (
    updater: Record<SessionId, SessionRuntime> | ((current: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
  ): void => {
    runtimes = typeof updater === 'function' ? updater(runtimes) : updater
    refs.latestRuntimesRef.current = runtimes
  }
  function Harness(): React.JSX.Element {
    const holder = useRef<WorkspaceRefs | null>(null)
    if (holder.current === null) {
      holder.current = makeWorkspaceRefsForTest(state)
      holder.current.latestRuntimesRef.current = runtimes
      refs = holder.current
    }
    useIpcSubscriptions(
      feed,
      holder.current,
      updater => {
        state = typeof updater === 'function' ? updater(state) : updater
        holder.current!.stateRef.current = state
        holder.current!.latestStateRef.current = state
      },
      commitRuntimes,
      () => {},
      () => {},
    )
    return <div />
  }
  render(<Harness />)
  const view = (): View => {
    const runtime = runtimes[SESSION_ID]!
    const record = listOrchestrationAgents({ state, runtimes, parentSessionId: PARENT_ID })[0]
    return {
      sessionStatus: runtime.sessionStatus,
      streamPhase: runtime.streamPhase,
      unreadKind: runtime.unreadKind,
      attentionLabel: dispatchAttentionLabelFromConditions(runtime.conditions),
      lifecycle: record?.lifecycleState,
    }
  }
  return { feed, meta, refs: () => refs, setRuntimes: commitRuntimes, runtime: () => runtimes[SESSION_ID]!, view }
}

// Forward AgentSession events exactly as SessionManager's forwarder does, in
// order. (Main coalesces process-state and deltas, but never reorders a
// committed entry past the structural event that follows it.)
function bridge(session: OpencodeTerminalSession, feed: FakeSessionFeed, onEach: () => void): void {
  const send = (fn: () => void) => {
    act(fn)
    onEach()
  }
  session.on('started', () => send(() => feed.emitStarted({ sessionId: SESSION_ID, kind: 'opencode' })))
  session.on('process-state', stateUpdate => send(() => feed.emitProcessState({ sessionId: SESSION_ID, ...stateUpdate })))
  session.on('semantic-event', event => send(() => feed.emitSemantic({ sessionId: SESSION_ID, event })))
  session.on('jsonl-entry', (entry, file) => send(() => feed.emitJsonlEntries({ sessionId: SESSION_ID, entries: [{ entry, file }] })))
  session.on('conditions', snapshot => send(() => feed.emitConditions({ sessionId: SESSION_ID, snapshot })))
  session.on('exit', ({ exitCode, signal }) => send(() => feed.emitExit({ sessionId: SESSION_ID, exitCode, signal })))
}

async function runPane(recording: LiveFixture) {
  const pane = mountPane(recording)
  const timeline: View[] = []
  const dbPath = join(dir, `${recording.scenario}.db`)
  const writer = new LiveFixtureWriter(dbPath, recording.sessionID, sessionRowFor(recording.sessionID))
  const server = new ReplayServer({ username: 'opencode', password: PASSWORD })
  await server.listen()
  const pty = new AdapterPty()
  const session = new OpencodeTerminalSession(
    { cwd: '/sandbox/project', resumeSessionId: recording.sessionID },
    {
      spawnPty: (() => pty) as never,
      prepareLaunch: async (opts): Promise<OpencodeTerminalLaunch> => ({
        binary: opts.binary,
        args: [],
        env: opts.env,
        sessionID: opts.sessionID,
        server: { url: server.url, username: 'opencode', password: PASSWORD },
        dbPath,
      }),
      headlessOptions: { fetch: nodeHttpFetch, heartbeatMs: 0, durablePollIntervalMs: 40, sseInitialBackoffMs: 20, sseMaxBackoffMs: 80 },
    },
  )
  let connected = false
  session.on('transcript-diagnostic', diagnostic => {
    if ((diagnostic as { connected?: boolean }).connected) connected = true
  })
  bridge(session, pane.feed, () => timeline.push(pane.view()))
  cleanups.push(async () => {
    await session.stop()
    await server.close()
    writer.close()
  })
  await session.start()
  await waitUntil(() => connected, 5000, 'live channel')
  await waitUntil(() => server.calls.some(call => call.path === '/question'), 5000, 're-sync')
  await settle(20)
  return { pane, timeline, session, writer, server, pty, dbPath, script: buildReplayScript(recording) }
}

const recordedPrompt = (recording: LiveFixture) => recording.prompts[0]!.text

describe('an OpenCode Terminal pane driven by a recorded TUI session, end to end', () => {
  it('shows running while the agent works, then idle with the answer, NEW, and a completed orchestration child', async () => {
    const recording = loadLiveFixture('plain.json')
    const { pane, timeline, writer, server, script } = await runPane(recording)
    expect(pane.view().sessionStatus).toBe('idle')

    await playReplay(script, writer, server)
    await waitUntil(() => pane.view().sessionStatus === 'idle' && timeline.some(view => view.sessionStatus === 'running'), 5000, 'turn end')
    await settle(60)

    // While the turn ran, every surface that reads the runtime said so.
    const running = timeline.filter(view => view.sessionStatus === 'running')
    expect(running.length).toBeGreaterThan(0)
    expect(running.some(view => view.streamPhase !== 'idle')).toBe(true)
    expect(running.some(view => view.lifecycle === 'running')).toBe(true)

    // Afterwards: idle, NEW, and the conversation in the runtime.
    const final = pane.view()
    expect(final.sessionStatus).toBe('idle')
    expect(final.streamPhase).toBe('idle')
    expect(final.unreadKind).toBe('output')
    const entries = pane.runtime().entries
    expect(entries.filter(entry => entry.type === 'user').map(entryTextContent).join('\n')).toContain(recordedPrompt(recording))
    expect(entries.some(entry => entry.type === 'assistant' && (entryTextContent(entry) ?? '').length > 0)).toBe(true)

    // Orchestration's wait loop stops on "completed"; the old runtime left
    // children at "waiting" forever.
    expect(final.lifecycle).toBe('completed')
  })

  it('keeps a queued second prompt inside one running span and ends with both answers', async () => {
    const recording = loadLiveFixture('queued.json')
    const { pane, timeline, writer, server, script } = await runPane(recording)
    await playReplay(script, writer, server)
    await waitUntil(() => pane.view().sessionStatus === 'idle' && timeline.some(view => view.sessionStatus === 'running'), 5000, 'turn end')
    await settle(60)

    // Running never flickered to idle between the two prompts.
    const firstRunning = timeline.findIndex(view => view.sessionStatus === 'running')
    const lastRunning = timeline.map(view => view.sessionStatus).lastIndexOf('running')
    expect(timeline.slice(firstRunning, lastRunning + 1).every(view => view.sessionStatus === 'running')).toBe(true)
    const userTexts = pane.runtime().entries.filter(entry => entry.type === 'user').map(entryTextContent)
    for (const prompt of recording.prompts.map(p => p.text)) expect(userTexts.join('\n')).toContain(prompt)
    expect(pane.view().lifecycle).toBe('completed')
  })

  it('raises ACTION for a recorded permission, clears it when answered through the pane, and keeps attention until acknowledged', async () => {
    const recording = loadLiveFixture('permission-once.json')
    const { pane, session, writer, server, script } = await runPane(recording)
    let atPermission: View | null = null
    await playReplay(script, writer, server, {
      beforeStep: async (step: ReplayStep) => {
        if (atPermission || step.kind !== 'sse' || step.event.type !== 'permission.replied') return
        await settle(30)
        atPermission = pane.view()
        const snapshot = pane.runtime().conditions!
        const once = snapshot.conditions['opencode.permission']!.actions.find(action => action.label === 'Allow once') as ConditionCustomAction
        await expect(session.resolveCondition(once)).resolves.toEqual({ ok: true })
        await settle(20)
        expect(pane.view().attentionLabel).toBeNull()
      },
    })
    await waitUntil(() => pane.view().sessionStatus === 'idle', 5000, 'turn end')
    await settle(60)

    expect(atPermission).toMatchObject({ sessionStatus: 'running', unreadKind: 'attention', attentionLabel: 'ACTION' })
    // Attention outranks the later NEW until the user opens the pane.
    expect(pane.view().unreadKind).toBe('attention')
    expect(pane.view().attentionLabel).toBeNull()
    expect(pane.view().lifecycle).toBe('completed')
  })

  it('shows the pane exited, not running, when the TUI dies mid-turn', async () => {
    const recording = loadLiveFixture('plain.json')
    const { pane, timeline, writer, server, script, pty } = await runPane(recording)
    const busyAt = script.findIndex(step => step.kind === 'sse' && step.event.type === 'session.status' && (step.event.properties?.status as { type: string }).type === 'busy')
    await playReplay(script.slice(0, busyAt + 1), writer, server)
    await waitUntil(() => timeline.some(view => view.sessionStatus === 'running'), 3000, 'running')
    pty.exit(137, 9)
    await waitUntil(() => pane.runtime().exited !== null, 3000, 'exit reached the pane')
    // The closing turn arrived before exit, so nothing is left "running".
    expect(pane.view().sessionStatus).not.toBe('running')
    expect(pane.view().streamPhase).toBe('idle')
    expect(pane.view().lifecycle).toBe('closed')
  })
})

// After a reload, a restart or a park, the pane's conversation comes back
// from OpenCode's database through the real history source — the path main's
// history loader delegates to — and the real renderer loader. The oracle is
// what the SAME pane showed live for the same recorded session: a reloaded
// agent must read (to the user's features and to MCP) exactly as it did
// before the reload, and the TUI must keep the pane.

type Seen = { uuid: string | undefined; type: string; text: string | null }
const seen = (entries: readonly Entry[]): Seen[] =>
  entries.map(entry => ({ uuid: (entry as { uuid?: string }).uuid, type: entry.type, text: entryTextContent(entry) }))

function serveHistoryFrom(dbPath: string) {
  const source = createOpencodeHistorySource({ resolveDbPath: async () => dbPath })
  cleanups.push(() => source.release())
  const loadInitialHistory = vi.fn((request: { cwd: string; providerSessionId: string; limit: number }) =>
    source.loadHistoryChunk({ cwd: request.cwd, providerSessionId: request.providerSessionId, limit: request.limit }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, loadInitialHistory },
  })
  return loadInitialHistory
}

describe('an OpenCode Terminal pane after a reload', () => {
  it('loads the conversation it showed live, and still never mounts the rendered feed', async () => {
    const recording = loadLiveFixture('queued.json')
    const live = await runPane(recording)
    await playReplay(live.script, live.writer, live.server)
    await waitUntil(() => live.pane.view().sessionStatus === 'idle' && live.timeline.some(view => view.sessionStatus === 'running'), 5000, 'turn end')
    await settle(60)
    const shownLive = seen(live.pane.runtime().entries)
    expect(shownLive.some(entry => entry.type === 'assistant')).toBe(true)

    // The reloaded pane: same metadata, a runtime seeded the way rehydrate
    // seeds every durable agent (transcript `loading`).
    const loadInitialHistory = serveHistoryFrom(live.dbPath)
    const meta = paneMeta(recording)
    let runtimes: Record<SessionId, SessionRuntime> = {
      [SESSION_ID]: { ...emptyRuntime(), ...seedResumedRuntimeFields(undefined, meta) },
    }
    expect(runtimes[SESSION_ID]!.transcriptStatus).toBe('loading')
    const refs = makeWorkspaceRefsForTest({ sessions: { [SESSION_ID]: meta } } as unknown as WorkspaceState)
    refs.latestRuntimesRef.current = runtimes
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID,
      meta,
      refs,
      setRuntimes: updater => {
        runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        refs.latestRuntimesRef.current = runtimes
      },
    })

    expect(loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'opencode', providerSessionId: recording.sessionID }))
    const reloaded = runtimes[SESSION_ID]!
    expect(reloaded.transcriptStatus).toBe('ready')
    expect(reloaded.hasOlderHistory).toBe(false)
    expect(seen(reloaded.entries)).toEqual(shownLive)

    // The history is for the app, not for display: whatever the global view
    // mode, the TUI keeps the pane and no feed-only command appears.
    for (const globalMode of ['agent', 'hybrid', 'terminal'] as const) {
      expect(getEffectiveAgentSurfaceForSession({ kind: 'opencode', providerRuntime: 'terminal', globalMode, override: undefined, runtime: reloaded })).toBe('terminal')
    }
    const feedPolicies: RenderedViewPolicy[] = [
      { kind: 'requires-rendered-feed' },
      { kind: 'opens-rendered-feed' },
      { kind: 'leases-rendered-feed', feature: 'copy-assistant-message' },
    ]
    for (const policy of feedPolicies) {
      expect(commandAllowedByRenderedViewPolicy({ policy, kind: 'opencode', providerRuntime: 'terminal', mode: 'agent', runtime: reloaded })).toBe(false)
    }
  })

  it('adds nothing when history lands on a pane the live stream already filled', async () => {
    // The spawn race (history resolving after the first live entries) and
    // the MCP read's hydrate of a live pane both take this path.
    const recording = loadLiveFixture('plain.json')
    const live = await runPane(recording)
    await playReplay(live.script, live.writer, live.server)
    await waitUntil(() => live.pane.view().sessionStatus === 'idle' && live.timeline.some(view => view.sessionStatus === 'running'), 5000, 'turn end')
    await settle(60)
    const before = seen(live.pane.runtime().entries)

    serveHistoryFrom(live.dbPath)
    await act(async () => {
      await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: live.pane.meta, refs: live.pane.refs(), setRuntimes: live.pane.setRuntimes })
    })

    expect(seen(live.pane.runtime().entries)).toEqual(before)
    expect(live.pane.runtime().transcriptStatus).toBe('ready')
  })
})
