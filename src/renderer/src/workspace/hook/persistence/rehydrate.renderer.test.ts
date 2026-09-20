import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type {
  SessionRecoverOptions,
  SessionRecoverResult,
  SessionRecoveryCancellationOptions,
} from '@shared/types/session'

import { rehydrateWorkspace } from './rehydrate'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import { resolveTabSessions } from '@renderer/workspace/queries'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makePersisted(): PersistedWorkspace {
  return {
    tabs: [{
      id: 'tab-1',
      title: 'Project',
      focusedSessionId: 'stable-session',
      root: { type: 'leaf', sessionId: 'stable-session' },
    }],
    activeTabId: 'tab-1',
    sessions: {
      'stable-session': {
        cwd: '/tmp/project',
        kind: 'claude',
        builtInMcpDomains: ['workflows'],
      },
    },
    drafts: { 'stable-session': 'unfinished prompt' },
    pinnedSessionIds: ['stable-session'],
  }
}

/**
 * What "the pane survived" means now that there is no tile tree (#992).
 *
 * These cases used to assert `tabs[0].root` — the leaf was still in the tree,
 * the split still had both children. A session's place is two independent facts
 * now, and a boot bug can break either one without the other: whether its
 * PROJECT still lists it (ownership; lose this and autosave drops the row), and
 * whether a LANE still shows it (a pointer; lose this and the user's screen
 * rearranged itself). Asserting both in one value keeps each case's intent —
 * "recovery did not take this away" — readable at the call site.
 */
function placement(state: WorkspaceState, tabId = 'tab-1') {
  return {
    listed: resolveTabSessions(state, tabId),
    lanes: state.stage.lanes.map(lane => lane.selectedSessionId ?? null),
  }
}

function makeHarness() {
  let state = {
    tabs: [],
    activeTabId: 'tab-1',
    sessions: {},
    pinnedSessionIds: [],
    stage: freshStage(),
  } satisfies WorkspaceState as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = {}
  const refs = {
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
    seenUuidsRef: ref({}),
  } as unknown as WorkspaceRefs

  return {
    refs,
    state: () => state,
    runtimes: () => runtimes,
    setState: (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    },
    setRuntimes: (
      next:
        | Record<SessionId, SessionRuntime>
        | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
  }
}

describe('rehydrateWorkspace backend reconciliation', () => {
  it('adopts the live backend’s TLDR identity when persisted renderer metadata is stale', async () => {
    const persisted = makePersisted()
    persisted.sessions['stable-session']!.tldrIdentity = 'stale-renderer-summary'
    persisted.sessions['stable-session']!.builtInMcpDomains = ['tldr']
    const harness = makeHarness()
    Object.defineProperty(window, 'api', { configurable: true, value: {
      defaultCwd: vi.fn(),
      recoverSession: vi.fn(async () => ({
        ok: true, disposition: 'adopted', snapshot: {
          sessionId: 'stable-session', kind: 'claude', cwd: '/tmp/project', lifecycle: 'live',
          input: { ready: true, revision: 1 }, builtInMcpDomains: ['tldr'], tldrIdentity: 'main-summary',
        },
      })),
    } })
    await rehydrateWorkspace(persisted, harness.refs, harness.setState, harness.setRuntimes, vi.fn())
    expect(harness.state().sessions['stable-session']?.tldrIdentity).toBe('main-summary')
  })

  it('seeds the pending conditions the recovered backend is already blocked on (#895)', async () => {
    // Providers publish conditions only when they CHANGE — the OpenCode
    // Terminal package and claude-code-headless both deduplicate — so an agent
    // that was already sitting on a permission prompt when the app quit emits
    // nothing to the restored renderer. `base` here is `emptyRuntime()`, whose
    // `conditions` is null, so Dispatch showed no ACTION and orchestration
    // summaries stopped naming the blocker while the raw TUI still showed it.
    const persisted = makePersisted()
    const harness = makeHarness()
    const blocked = {
      provider: 'claude' as const,
      ts: 1_000,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt',
          state: { visible: true, title: 'Allow Bash?' },
          actions: [],
        },
      },
    }
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
        conditions: blocked,
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        defaultCwd: vi.fn(),
        loadInitialHistory: vi.fn(async () => ({ entries: [], hasMore: false, totalEntries: 0 })),
        gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
      },
    })

    await rehydrateWorkspace(persisted, harness.refs, harness.setState, harness.setRuntimes, vi.fn())

    expect(harness.runtimes()['stable-session']?.conditions).toEqual(blocked)
  })

  it('does not resurrect a condition the live channel cleared while recovery was in flight (#895)', async () => {
    // Session events reach this window while `recoverSession` is still
    // awaiting, and `onSessionConditions` writes them straight into the
    // runtime map. A seed that simply overwrote that would put a dismissed
    // prompt back in the surface the user acts on; `ts` is the ordering signal.
    const persisted = makePersisted()
    const harness = makeHarness()
    const cleared = { provider: 'claude' as const, ts: 2_000, conditions: {} }
    const recoverSession = vi.fn(async () => {
      harness.setRuntimes(prev => ({
        ...prev,
        'stable-session': { ...(prev['stable-session'] ?? emptyRuntime()), conditions: cleared },
      }))
      return {
        ok: true as const,
        disposition: 'adopted' as const,
        snapshot: {
          sessionId: 'stable-session',
          kind: 'claude' as const,
          cwd: '/tmp/project',
          lifecycle: 'live' as const,
          input: { ready: true, revision: 1, reason: 'ready' as const },
          conditions: {
            provider: 'claude' as const,
            ts: 1_000,
            conditions: {
              'claude.permission-prompt': {
                kind: 'claude.permission-prompt',
                state: { visible: true, title: 'Allow Bash?' },
                actions: [],
              },
            },
          },
        },
      }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        defaultCwd: vi.fn(),
        loadInitialHistory: vi.fn(async () => ({ entries: [], hasMore: false, totalEntries: 0 })),
        gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
      },
    })

    await rehydrateWorkspace(persisted, harness.refs, harness.setState, harness.setRuntimes, vi.fn())

    expect(harness.runtimes()['stable-session']?.conditions).toEqual(cleared)
  })

  it('recovers OpenCode Terminal with its runtime selector and durable provider id intact', async () => {
    const persisted = makePersisted()
    persisted.sessions['stable-session'] = {
      cwd: '/tmp/project',
      kind: 'opencode',
      providerRuntime: 'terminal',
      providerSessionId: 'ses_durable_terminal',
      tldrIdentity: 'summary-stable',
      providerSessionIdSource: 'runtime-start',
      builtInMcpDomains: ['orchestration'],
    }
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'spawned' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'opencode' as const,
        providerRuntime: 'terminal' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
        builtInMcpDomains: ['orchestration' as const],
      },
    }))
    // One committed exchange in the `{ info, parts }` shape OpenCode's
    // database serves through main's history loader.
    const loadInitialHistory = vi.fn(async () => ({
      entries: [
        {
          info: { id: 'msg_user', sessionID: 'ses_durable_terminal', role: 'user', time: { created: 1_000 } },
          parts: [{ id: 'prt_1', type: 'text', text: 'what changed?' }],
        },
        {
          info: { id: 'msg_answer', sessionID: 'ses_durable_terminal', role: 'assistant', parentID: 'msg_user', time: { created: 2_000, completed: 3_000 } },
          parts: [{ id: 'prt_2', type: 'text', text: 'Nothing yet.' }],
        },
      ],
      hasMore: false,
      totalEntries: 2,
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        defaultCwd: vi.fn(),
        loadInitialHistory,
        gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
      },
    })

    await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'stable-session',
      kind: 'opencode',
      providerRuntime: 'terminal',
      resumeSessionId: 'ses_durable_terminal',
      tldrIdentity: 'summary-stable',
    }))
    expect(harness.state().sessions['stable-session']).toMatchObject({
      kind: 'opencode',
      providerRuntime: 'terminal',
      providerSessionId: 'ses_durable_terminal',
      tldrIdentity: 'summary-stable',
    })
    // The conversation reloads into the runtime like any agent's: Copy Last
    // Response, View Prompts, status rows and MCP reads all read `entries`.
    // The raw TUI still owns the pane (agentDisplayMode pins it).
    await vi.waitFor(() => {
      expect(harness.runtimes()['stable-session']).toMatchObject({
        processStatus: 'started',
        transcriptStatus: 'ready',
        hasOlderHistory: false,
        totalEntries: 2,
      })
    })
    expect(loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'opencode',
      providerSessionId: 'ses_durable_terminal',
    }))
    expect(harness.runtimes()['stable-session']!.entries.map(entry => (entry as { uuid?: string }).uuid))
      .toEqual(['msg_user', 'msg_answer'])
  })

  it('does not reapply enabled defaults over a persisted explicit disable', async () => {
    const persisted = makePersisted()
    persisted.sessions['stable-session']!.builtInMcpDomains = []
    persisted.sessions['stable-session']!.builtInMcpOverrides = { orchestration: false }
    const harness = makeHarness()
    harness.refs.defaultBuiltInMcpDomainsRef.current = ['orchestration']
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'spawned' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, defaultCwd: vi.fn() },
    })

    await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      builtInMcpDomains: [],
    }))
    expect(harness.state().sessions['stable-session']?.builtInMcpDomains).toEqual([])
  })

  it.each(['spawned', 'adopted'] as const)('migrates legacy off to inheritance while keeping a %s backend snapshot authoritative', async disposition => {
    const persisted = makePersisted()
    persisted.sessions['stable-session']!.builtInMcpDomains = []
    const harness = makeHarness()
    harness.refs.defaultBuiltInMcpDomainsRef.current = ['tldr']
    const domains = disposition === 'spawned' ? ['tldr'] : []
    const recoverSession = vi.fn(async () => ({
      ok: true, disposition, snapshot: {
        sessionId: 'stable-session', kind: 'claude', cwd: '/tmp/project', lifecycle: 'live',
        input: { ready: true, revision: 1 }, builtInMcpDomains: domains,
      },
    }))
    Object.defineProperty(window, 'api', { configurable: true, value: { recoverSession, defaultCwd: vi.fn() } })
    await rehydrateWorkspace(persisted, harness.refs, harness.setState, harness.setRuntimes, vi.fn())
    // Recovery may adopt an existing process. Settings describe the next
    // launch; they cannot change the tools that process already started with.
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({ builtInMcpDomains: ['tldr'] }))
    expect(harness.state().sessions['stable-session']).toMatchObject({ builtInMcpDomains: domains, builtInMcpOverrides: {} })
  })

  it('adopts under the persisted local id without calling the fresh-spawn API', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const adoptedSessionRunId = '11111111-1111-4111-8111-111111111111'
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId: 'stable-session',
        sessionRunId: adoptedSessionRunId,
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 4, reason: 'ready' as const },
        // The live backend predates the renderer reload and remains the
        // authority even though the persisted stale Workflow-only list was
        // narrowed to [] for the recovery request.
        builtInMcpDomains: ['orchestration' as const],
      },
    }))
    const spawnSession = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, spawnSession, defaultCwd: vi.fn() },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    expect(result).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'stable-session',
      cwd: '/tmp/project',
      kind: 'claude',
      builtInMcpDomains: [],
    }))
    expect(spawnSession).not.toHaveBeenCalled()
    // A v2 file with no lane grid boots onto the migration default: the pane
    // the user was commanding in lane 0, beside one empty lane (plan §6.4).
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session'],
      lanes: ['stable-session', null],
    })
    expect(harness.state().pinnedSessionIds).toEqual(['stable-session'])
    expect(harness.state().sessions['stable-session']?.builtInMcpDomains).toEqual([
      'orchestration',
    ])
    expect(harness.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      // WHY this is the reload regression: adoption emits no new started edge.
      // The backend snapshot must be sufficient to restore exact-run
      // attribution before any delayed renderer observation is reported.
      sessionRunId: adoptedSessionRunId,
      processStatus: 'started',
      processError: null,
      inputReady: true,
    })
  })

  it('does not let a delayed recovery snapshot overwrite a replacement run observed meanwhile', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const recovery = deferred<SessionRecoverResult>()
    const recoverSession = vi.fn(() => recovery.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, defaultCwd: vi.fn() },
    })

    const restoring = rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )
    await vi.waitFor(() => expect(recoverSession).toHaveBeenCalledTimes(1))

    const successorRunId = '22222222-2222-4222-8222-222222222222'
    harness.setRuntimes(prev => ({
      ...prev,
      'stable-session': {
        ...(prev['stable-session'] ?? emptyRuntime()),
        // Models the separate session:started channel winning the race while
        // the recovery invoke is still unresolved.
        sessionRunId: successorRunId,
      },
    }))
    recovery.resolve({
      ok: true,
      disposition: 'adopted',
      snapshot: {
        sessionId: 'stable-session',
        sessionRunId: '33333333-3333-4333-8333-333333333333',
        kind: 'claude',
        cwd: '/tmp/project',
        lifecycle: 'live',
        input: { ready: true, revision: 1, reason: 'ready' },
      },
    })

    await restoring
    expect(harness.runtimes()['stable-session']?.sessionRunId).toBe(successorRunId)
  })

  it('retains the pane, metadata, and draft when backend recovery fails', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: false as const,
      code: 'start-failed' as const,
      retryable: true,
      message: 'Claude CLI not found',
    }))
    const newTab = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        spawnSession: vi.fn(),
        defaultCwd: vi.fn(async () => '/tmp/fallback'),
      },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      newTab,
    )

    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(newTab).not.toHaveBeenCalled()
    expect(harness.state().sessions['stable-session']).toMatchObject({
      cwd: '/tmp/project',
      kind: 'claude',
    })
    // A v2 file with no lane grid boots onto the migration default: the pane
    // the user was commanding in lane 0, beside one empty lane (plan §6.4).
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session'],
      lanes: ['stable-session', null],
    })
    expect(harness.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      processStatus: 'failed',
      processError: 'Claude CLI not found',
      recoveryFailureCode: 'start-failed',
      inputReady: false,
    })
  })

  it('does not let an older recovery snapshot overwrite a newer readiness event', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    harness.setRuntimes({
      'stable-session': {
        ...emptyRuntime(),
        processStatus: 'started',
        inputReady: true,
        inputReadinessRevision: 5,
      },
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession: vi.fn(async () => ({
          ok: true as const,
          disposition: 'adopted' as const,
          snapshot: {
            sessionId: 'stable-session',
            kind: 'claude' as const,
            cwd: '/tmp/project',
            lifecycle: 'live' as const,
            input: { ready: false, revision: 4, reason: 'replaying-history' as const },
          },
        })),
        defaultCwd: vi.fn(),
      },
    })

    await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    expect(harness.runtimes()['stable-session']).toMatchObject({
      inputReady: true,
      inputReadinessRevision: 5,
    })
  })

  it('keeps a failed session and its parked sibling listed once every outcome is resolved', async () => {
    // Re-based with #992. This was "keeps failed siblings in a SPLIT": two tile
    // leaves, both spawned at boot, one succeeding and one refused, and the
    // assertion that the refused leaf stayed in the tree. Two things changed
    // under it. There is no tree to fall out of — the failure that matters now
    // is the ROW being dropped, which takes the project's listing with it. And
    // boot spawns only the focused lane's occupant (sessionOwnership.ts), so
    // the sibling is never asked to start at all. What is still worth pinning
    // is the pair: a refused recovery must not cost the refused session its
    // place, and must not disturb the sibling that was never part of it.
    const persisted = makePersisted()
    persisted.sessions['second-session'] = { cwd: '/tmp/project', kind: 'codex' }
    persisted.tabs![0]!.root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: { type: 'leaf', sessionId: 'stable-session' },
      b: { type: 'leaf', sessionId: 'second-session' },
    }
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: false as const,
      code: 'ownership-conflict' as const,
      retryable: false,
      message: 'Owned by another project',
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, spawnSession: vi.fn(), defaultCwd: vi.fn() },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    // `complete` with zero restored: a refusal is a RESOLVED outcome, which is
    // what lets autosave unlock instead of waiting forever on a backend that
    // will never come.
    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'stable-session' }))
    // Tree order became pool order: the split's depth-first leaves.
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session', 'second-session'],
      lanes: ['stable-session', null],
    })
    expect(harness.runtimes()['stable-session']).toMatchObject({
      processStatus: 'failed',
      processError: 'Owned by another project',
      recoveryFailureCode: 'ownership-conflict',
      inputReady: false,
    })
    // Parked, not failed: nothing tried to start it, so nothing about it can
    // have gone wrong. `idle` is also what makes the first selection wake it.
    expect(harness.runtimes()['second-session']).toMatchObject({
      processStatus: 'idle',
      processError: null,
      recoveryFailureCode: null,
    })
  })

  it('never replays persisted layout or runtime state after the initial shell is published', async () => {
    // Re-based with #992: the old case raced TWO boot recoveries against each
    // other and removed the first leaf while the second was pending. One
    // backend spawns at boot now, so the race is that recovery against the
    // USER — which was always the point. Everything the user can do to a
    // published shell while a provider is still starting is done below, and
    // the late outcome must own none of it.
    const persisted = makePersisted()
    persisted.sessions['second-session'] = {
      cwd: '/tmp/project',
      kind: 'codex',
      title: 'Persisted title',
    }
    persisted.tabs![0]!.root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: { type: 'leaf', sessionId: 'stable-session' },
      b: { type: 'leaf', sessionId: 'second-session' },
    }
    const pending = deferred<Awaited<ReturnType<Window['api']['recoverSession']>>>()
    const harness = makeHarness()
    const recoveryApi = {
      recoverSession: vi.fn(() => pending.promise),
      cancelSessionRecovery: vi.fn(async () => true),
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const bootstrap = rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
      recoveryApi,
    )

    // The whole durable workspace is on screen BEFORE any provider answers.
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session', 'second-session'],
      lanes: ['stable-session', null],
    })
    expect(harness.runtimes()['stable-session']!.processStatus).toBe('spawning')
    expect(harness.runtimes()['second-session']!.processStatus).toBe('idle')

    // Model user and live-feed mutations while the provider is still
    // unresolved: the parked sibling is closed, the recovering agent is moved
    // to the other lane and renamed, and its draft and feed move on. The
    // eventual outcome owns neither the removed row, nor the layout, nor this
    // newer draft/feed/title state.
    harness.setState(prev => ({
      ...prev,
      stage: {
        ...prev.stage,
        lanes: [{}, { selectedSessionId: 'stable-session' }],
        focusedLane: 1,
      },
      sessions: {
        'stable-session': {
          ...prev.sessions['stable-session']!,
          title: 'Edited while recovering',
        },
      },
    }))
    harness.setRuntimes(prev => ({
      'stable-session': {
        ...prev['stable-session']!,
        draftInput: 'newer draft',
        queuedMessages: [{ content: 'live feed state', timestamp: 'now' }],
      },
    }))

    pending.resolve({
      ok: true,
      disposition: 'spawned',
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude',
        cwd: '/tmp/project',
        lifecycle: 'live',
        input: { ready: true, revision: 3, reason: 'ready' },
      },
    })
    await expect(bootstrap).resolves.toEqual({
      restoredSessions: 1,
      expectedSessions: 1,
      complete: true,
    })

    // The user's arrangement, not the file's seed.
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session'],
      lanes: [null, 'stable-session'],
    })
    expect(harness.state().stage.focusedLane).toBe(1)
    expect(harness.state().sessions['second-session']).toBeUndefined()
    expect(harness.state().sessions['stable-session']!.title).toBe('Edited while recovering')
    expect(harness.runtimes()['second-session']).toBeUndefined()
    expect(harness.runtimes()['stable-session']).toMatchObject({
      processStatus: 'started',
      draftInput: 'newer draft',
      queuedMessages: [{ content: 'live feed state', timestamp: 'now' }],
    })
  })

  it('bounds a never-settling recovery, cancels main ownership, and completes bootstrap', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const cancelSessionRecovery = vi.fn(
      async (_options: SessionRecoveryCancellationOptions) => true,
    )
    const recoveryApi = {
      recoverSession: vi.fn(
        (_options: SessionRecoverOptions) => new Promise<never>(() => {}),
      ),
      cancelSessionRecovery,
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
      recoveryApi,
      5,
    )

    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(cancelSessionRecovery).toHaveBeenCalledWith({
      sessionId: 'stable-session',
      kind: 'claude',
      cwd: '/tmp/project',
      recoveryToken: expect.any(String),
    })
    const admittedRecovery = recoveryApi.recoverSession.mock.calls[0]?.[0]
    const cancelledRecovery = cancelSessionRecovery.mock.calls[0]?.[0]
    expect(admittedRecovery).toMatchObject({
      reclaimPendingReplacement: true,
      recoveryToken: expect.any(String),
    })
    expect(cancelledRecovery?.recoveryToken).toBe(admittedRecovery?.recoveryToken)
    // A v2 file with no lane grid boots onto the migration default: the pane
    // the user was commanding in lane 0, beside one empty lane (plan §6.4).
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session'],
      lanes: ['stable-session', null],
    })
    expect(harness.runtimes()['stable-session']).toMatchObject({
      processStatus: 'failed',
      recoveryFailureCode: 'cancelled',
      inputReady: false,
    })
  })

  it('seeds the parked agent the user was commanding into lane 0, spawns only it, and keeps every draft', async () => {
    const persisted = makePersisted()
    persisted.sessions['parked-session'] = {
      cwd: '/tmp/project',
      kind: 'codex',
      title: 'Parked review',
    }
    persisted.detachedSessions = {
      'parked-session': {
        sessionId: 'parked-session',
        surface: 'dispatch',
        projectTabId: 'tab-1',
        projectTabTitle: 'Project',
        projectTabIndex: 0,
        detachedAt: 42,
      },
    }
    // Deliberately the v2 ON-DISK shape: real users' files carry this envelope,
    // and rehydrate is where it becomes a stage (#992). A classic-Dispatch focus
    // on a parked agent is the #977 entry seed.
    persisted.dispatchMode = {
      scope: 'project',
      focusedSessionId: 'parked-session',
    }
    persisted.drafts = {
      ...persisted.drafts,
      'parked-session': 'finish this after restart',
    }
    const harness = makeHarness()
    // Echoes whichever session was asked for. The old mock hard-coded the grid
    // leaf's id, which was fine while "the tile leaf" was the only thing boot
    // could ever request — and would now answer a request for the parked agent
    // with someone else's snapshot.
    const recoverSession = vi.fn(async (options: SessionRecoverOptions) => ({
      ok: true as const,
      disposition: 'spawned' as const,
      snapshot: {
        sessionId: options.sessionId,
        kind: options.kind ?? ('claude' as const),
        cwd: options.cwd,
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        cancelSessionRecovery: vi.fn(async () => true),
        defaultCwd: vi.fn(),
      },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    // WHY this assertion is stricter than merely checking the metadata row:
    // a parked agent is a first-class workspace owner. Losing either its draft
    // or the fact that the user was commanding it makes a successful rehydrate
    // feel like data loss and sends the next command to a different agent.
    //
    // WHAT CHANGED with #992, because this case used to assert the opposite
    // spawn. In v2 the tile leaf (`stable-session`) spawned and the parked
    // agent stayed parked even though it was the one under the cursor — so the
    // user's first prompt after a restart paid a wake. The boot-spawn set is
    // the focused lane's occupant now, and the entry seed puts the agent the
    // user was commanding in that lane. So exactly the roles swap: the agent
    // they were talking to comes up live, the pane they had left behind waits.
    // Still ONE spawn, still nothing spawned because a file merely lists it —
    // the #258 fork-bomb guard is the count, and the count did not move.
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'parked-session',
      kind: 'codex',
    }))
    expect(result).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    // The detached record became the row's own membership: filed under the
    // project it was parked from, ordered by when it left the screen (42),
    // after the tile leaf (ordinal 0).
    expect(harness.state().sessions['parked-session']).toMatchObject({
      projectId: 'tab-1',
      joinedAt: 42,
    })
    // Lane 0 shows it, beside one empty lane (the imported-workspace default,
    // plan §6.4).
    expect(placement(harness.state())).toEqual({
      listed: ['stable-session', 'parked-session'],
      lanes: ['parked-session', null],
    })
    expect(harness.state().stage.focusedLane).toBe(0)
    expect(harness.runtimes()['parked-session']).toMatchObject({
      processStatus: 'started',
      draftInput: 'finish this after restart',
    })
    // The pane left behind: no backend, draft intact, ready to wake on use.
    expect(harness.runtimes()['stable-session']).toMatchObject({
      processStatus: 'idle',
      inputReady: false,
      draftInput: 'unfinished prompt',
    })
  })

  it('drops a session filed under a deleted project before publishing runtimes, and spawns nothing for it', async () => {
    const persisted = makePersisted()
    persisted.sessions['parked-session'] = {
      cwd: '/tmp/project',
      kind: 'codex',
    }
    persisted.sessions['ghost-session'] = {
      cwd: '/tmp/deleted-project',
      kind: 'claude',
    }
    persisted.detachedSessions = {
      'parked-session': {
        sessionId: 'parked-session',
        surface: 'dispatch',
        projectTabId: 'tab-1',
        projectTabTitle: 'Project',
        projectTabIndex: 0,
        detachedAt: 42,
      },
      'ghost-session': {
        sessionId: 'ghost-session',
        surface: 'dispatch',
        projectTabId: 'deleted-tab',
        projectTabTitle: 'Deleted project',
        projectTabIndex: 1,
        detachedAt: 21,
      },
    }
    // v2 on-disk shape on purpose (see the parked-draft case above).
    persisted.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'ghost-session',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'parked-session' },
          { selectedSessionId: 'ghost-session' },
        ],
      },
    }
    persisted.drafts = {
      ...persisted.drafts,
      'ghost-session': 'this draft belongs to an unreachable ghost',
    }
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        cancelSessionRecovery: vi.fn(async () => true),
        defaultCwd: vi.fn(),
      },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      vi.fn(),
    )

    // The FOCUSED lane named the ghost, so the boot-spawn set is empty: the
    // pointer under the cursor resolved to nothing, and a pointer is never
    // ownership. Nothing is spawned in its place — promoting lane 0's occupant
    // (or the old tile leaf) would be boot deciding what the user is working
    // on. An empty set is still a COMPLETE boot, which is what unlocks
    // autosave; `0 === 0` is the honest reading, not a special case.
    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 0, complete: true })
    expect(recoverSession).not.toHaveBeenCalled()
    expect(harness.state().sessions).toHaveProperty('stable-session')
    expect(harness.state().sessions).toHaveProperty('parked-session')
    expect(harness.state().sessions).not.toHaveProperty('ghost-session')
    // A ghost never falls back to the active project: that would hand a
    // stranger's agent to whichever project happened to be open.
    expect(placement(harness.state()).listed).toEqual(['stable-session', 'parked-session'])
    expect(harness.runtimes()).toHaveProperty('parked-session')
    expect(harness.runtimes()).not.toHaveProperty('ghost-session')
    // The ghost's lane is emptied, never refilled; focus stays on the lane
    // index the user left it on.
    expect(harness.state().stage.focusedLane).toBe(1)
    expect(harness.state().stage.lanes).toEqual([
      { selectedSessionId: 'parked-session' },
      { selectedSessionId: undefined },
    ])
  })
})
