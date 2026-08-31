import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { act, render, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CodexHeadless,
  CodexResponsesAdapter,
} from 'codex-headless'
import type { ResponsesProxy } from 'codex-headless'
import recordedCodexWorktreeWindow from '../../../../../../testing/fixtures/worktree-live-attribution/codex-0151-worktree-window.json'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { useStreamingActions } from '@renderer/workspace/hook/actions/streaming'
import { useIpcSubscriptions } from '@renderer/workspace/hook/ipc/useIpcSubscriptions'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { forwardCodexRolloutEntries } from '@providers/codex/runtime/codexHeadlessForwarding'

import { useAutoSave } from './useAutoSave'

const { createSession, loadInitialHistoryForSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
  loadInitialHistoryForSession: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession }),
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => '/usr/bin/true',
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() },
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

vi.mock('@renderer/performance/client', () => ({
  mark: vi.fn(),
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
}))

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession,
}))

type RecordedFixture = {
  records: Array<Record<string, unknown>>
}

const fixture = recordedCodexWorktreeWindow as RecordedFixture
const temporaryDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

beforeEach(() => {
  createSession.mockReset()
  loadInitialHistoryForSession.mockReset()
  loadInitialHistoryForSession.mockResolvedValue(undefined)
})

function inertPty(): IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty
}

function writeRecordedRollout(codexHome: string, providerSessionId: string): string {
  const day = join(codexHome, 'sessions', '2026', '08', '30')
  mkdirSync(day, { recursive: true })
  const path = join(day, `rollout-recorded-${providerSessionId}.jsonl`)
  const text = fixture.records
    .map(record => JSON.stringify(record).split('fixture-id-1').join(providerSessionId))
    .join('\n') + '\n'
  writeFileSync(path, text)
  return path
}

function appendCommittedPrompt(path: string, prompt: string, ordinal: number): void {
  appendFileSync(path, JSON.stringify({
    timestamp: `2026-08-30T18:45:${String(ordinal).padStart(2, '0')}.000Z`,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    },
  }) + '\n')
}

class RecordedForwardingSession extends EventEmitter {
  readonly write = vi.fn()
  readonly resize = vi.fn()
  private readonly headless = new CodexHeadless({
    pty: inertPty(),
    cwd: '/fixture/project-1',
  })
  private readonly proxy = new EventEmitter() as ResponsesProxy
  private readonly adapter = new CodexResponsesAdapter(this.proxy, this.headless)
  private readonly stopForwarding = forwardCodexRolloutEntries(this.headless, this)

  constructor(private readonly providerSessionId: string) {
    super()
  }

  async start(): Promise<void> {
    this.adapter.attach()
    const { sessionsDir } = await this.headless.start()
    this.emit('started', { projectDir: sessionsDir })
    // Sanitized from the captured Codex 0.151 Responses request. The pinned
    // adapter must extract this exact per-window identity; cwd scanning or
    // prompt attestation is intentionally absent from this proof.
    this.proxy.emit('event', {
      kind: 'request',
      requestId: 'recorded-0.151-request',
      endpoint: 'responses',
      method: 'POST',
      path: '/v1/responses',
      upstream: 'https://fixture.invalid/v1/responses',
      headers: { 'x-codex-window-id': `${this.providerSessionId}:0` },
      request_shape: {
        provider_session_id: this.providerSessionId,
        client_metadata: {
          thread_id: this.providerSessionId,
          session_id: this.providerSessionId,
          root_turn_id: 'recorded-root-turn',
        },
      },
    })
  }

  async stop(): Promise<void> {
    this.stopForwarding()
    this.adapter.detach()
    await this.headless.stop()
  }
}

class ReloadSession extends EventEmitter {
  readonly write = vi.fn()
  readonly resize = vi.fn()
  readonly stop = vi.fn(async () => undefined)
  async start(): Promise<void> {
    this.emit('started', { projectDir: '/fixture/project-1' })
    this.emit('input-readiness', { ready: true, reason: 'ready' })
  }
}

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function makeRefs(state: WorkspaceState, runtimes: Record<SessionId, SessionRuntime>): WorkspaceRefs {
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref({}),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    pendingAdoptionWindowIdsRef: ref([]),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  } as unknown as WorkspaceRefs
}

function liveTurn(ended = false) {
  return {
    turnId: 'recorded-proxy-turn',
    source: 'proxy' as const,
    text: ended ? 'previous semantic assistant output' : '',
    blocks: {},
    blockOrder: [],
    stopReason: null,
    usage: null,
    task: {
      todos: [],
      doneCount: 0,
      totalCount: 0,
      inProgressToolUseIds: [],
      activeToolNames: [],
    },
    startedAt: 1,
    endedAt: ended ? 2 : null,
    lookups: {
      toolCallsById: {},
      toolUseIdsInOrder: [],
      resolvedToolUseIds: [],
      erroredToolUseIds: [],
    },
  }
}

function makeReloadHarness() {
  let state = {
    tabs: [],
    activeTabId: 'tab-1',
    sessions: {},
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = {}
  const refs = makeRefs(state, runtimes)
  return {
    refs,
    state: () => state,
    setState: (next: WorkspaceState | ((previous: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    },
    setRuntimes: (
      next: Record<SessionId, SessionRuntime> |
        ((previous: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
    setTileTabs: vi.fn(),
  }
}

describe('recorded Codex 0.151 live continuity across app layers', () => {
  it('forwards exact identity, retires both queue reasons, autosaves, and resumes it', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'agent-code-live-continuity-'))
    temporaryDirectories.push(codexHome)
    process.env.CODEX_HOME = codexHome
    const providerSessionId = '00000000-0000-4000-8000-000000000151'
    const localSessionId = '51515151-5151-4151-8151-515151515151' as SessionId
    const rolloutPath = writeRecordedRollout(codexHome, providerSessionId)
    const provider = new RecordedForwardingSession(providerSessionId)
    createSession.mockReturnValueOnce(provider)

    const { SessionManager } = await import('@main/sessionManager')
    const { rehydrateWorkspace } = await import('./rehydrate')
    const manager = new SessionManager()
    const feed = createFakeSessionFeed()
    manager.on('jsonl-entry', payload => {
      act(() => feed.emitJsonlEntries({
        sessionId: payload.sessionId,
        entries: [{
          entry: payload.entry,
          file: payload.file,
          observation: payload.observation,
        }],
      }))
    })

    const initialState = {
      tabs: [{
        id: 'tab-1',
        title: 'Recorded Codex',
        focusedSessionId: localSessionId,
        root: { type: 'leaf', sessionId: localSessionId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [localSessionId]: { cwd: '/fixture/project-1', kind: 'codex' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    const initialRuntimes = {
      [localSessionId]: {
        ...emptyRuntime(),
        semantic: { ...emptyRuntime().semantic, currentTurn: liveTurn(false) },
      },
    }
    let currentState = initialState
    let currentRuntimes = initialRuntimes as Record<SessionId, SessionRuntime>
    let actions!: ReturnType<typeof useStreamingActions>
    let replaceRuntimes!: (
      next: (previous: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>,
    ) => void
    const savedWorkspaceJson: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gitWorktrees: vi.fn(async () => ({ ok: false as const })),
        saveWorkspace: vi.fn(async (json: string) => { savedWorkspaceJson.push(json) }),
        confirmWorkspaceAdoption: vi.fn(async () => undefined),
      },
    })

    function Harness(): React.JSX.Element {
      const [state, setState] = useState(initialState)
      const [runtimes, setRuntimes] = useState<Record<SessionId, SessionRuntime>>(
        initialRuntimes,
      )
      const refs = useRef<WorkspaceRefs | null>(null)
      if (!refs.current) refs.current = makeRefs(state, runtimes)
      currentState = state
      currentRuntimes = runtimes
      refs.current.stateRef.current = state
      refs.current.latestStateRef.current = state
      refs.current.latestRuntimesRef.current = runtimes
      actions = useStreamingActions(setRuntimes, () => true)
      replaceRuntimes = setRuntimes
      useIpcSubscriptions(feed, refs.current, setState, setRuntimes, vi.fn(), vi.fn())
      useAutoSave(state, 0, refs.current, true)
      return <div />
    }

    const mounted = render(<Harness />)
    const livePrompt = 'queued while the proxy turn is live'
    act(() => actions.addOptimisticCodexUserEntry(
      localSessionId,
      livePrompt,
      '71717171-7171-4171-8171-717171717171',
    ))
    expect(currentRuntimes[localSessionId]?.queuedMessages.map(row => row.content))
      .toEqual([livePrompt])

    await manager.recover({
      sessionId: localSessionId,
      kind: 'codex',
      cwd: '/fixture/project-1',
    })
    await waitFor(() => expect(currentState.sessions[localSessionId]).toMatchObject({
      providerSessionId,
      providerSessionIdSource: 'jsonl-entry',
    }), { timeout: 5_000 })

    appendCommittedPrompt(rolloutPath, livePrompt, 21)
    await waitFor(() => expect(currentRuntimes[localSessionId]?.queuedMessages).toEqual([]), {
      timeout: 5_000,
    })

    const historyPrompt = 'queued behind unowned semantic history'
    act(() => replaceRuntimes(previous => ({
      ...previous,
      [localSessionId]: {
        ...previous[localSessionId]!,
        semantic: {
          ...previous[localSessionId]!.semantic,
          currentTurn: null,
          history: [liveTurn(true)],
        },
      },
    })))
    act(() => actions.addOptimisticCodexUserEntry(
      localSessionId,
      historyPrompt,
      '72727272-7272-4272-8272-727272727272',
    ))
    expect(currentRuntimes[localSessionId]?.queuedMessages.map(row => row.content))
      .toEqual([historyPrompt])

    appendCommittedPrompt(rolloutPath, historyPrompt, 22)
    await waitFor(() => {
      expect(currentRuntimes[localSessionId]?.queuedMessages).toEqual([])
      expect(currentRuntimes[localSessionId]?.entries
        .filter(entry => entry.type === 'user')
        .map(entryTextContent)).toEqual([livePrompt, historyPrompt])
    }, { timeout: 5_000 })

    await waitFor(() => expect(savedWorkspaceJson.some(json =>
      json.includes(providerSessionId),
    )).toBe(true), { timeout: 5_000 })
    const durableJson = [...savedWorkspaceJson].reverse().find(json =>
      json.includes(providerSessionId),
    )!
    const persisted = (JSON.parse(durableJson) as { workspace: PersistedWorkspace }).workspace
    expect(persisted.sessions[localSessionId]).toMatchObject({
      providerSessionId,
      providerSessionIdSource: 'jsonl-entry',
    })

    mounted.unmount()
    await manager.killAll()
    let recoveredOptions: Record<string, unknown> | undefined
    createSession.mockImplementationOnce((options: Record<string, unknown>) => {
      recoveredOptions = options
      return new ReloadSession()
    })
    const restartedManager = new SessionManager()
    const reload = makeReloadHarness()
    await rehydrateWorkspace(
      persisted,
      reload.refs,
      reload.setState,
      reload.setRuntimes,
      reload.setTileTabs,
      vi.fn(),
      {
        recoverSession: restartedManager.recover.bind(restartedManager),
        cancelSessionRecovery: restartedManager.cancelRecovery.bind(restartedManager),
        defaultCwd: vi.fn(async () => '/fixture/project-1'),
      },
    )

    // This final assertion is the restart contract: the UUID extracted by the
    // pinned adapter, forwarded by the production Codex bridge, reduced by the
    // renderer, and serialized by autosave is the exact resume identity main
    // passes back to the replacement provider after app hydration.
    expect(recoveredOptions).toMatchObject({
      cwd: '/fixture/project-1',
      resumeSessionId: providerSessionId,
      shellSessionId: localSessionId,
    })
    expect(readFileSync(rolloutPath, 'utf8')).toContain(historyPrompt)
    await restartedManager.killAll()
  }, 20_000)
})
