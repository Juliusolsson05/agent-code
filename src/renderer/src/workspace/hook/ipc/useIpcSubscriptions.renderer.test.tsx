import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import { useRef } from 'react'
import type { MutableRefObject } from 'react'
import recordedQueueHandoffBundle from '../../../../../../testing/fixtures/rendering-bundles/2026-06-14T14-25-07-012-a8ad1ebb.json'
import recordedTaskNotificationBundle from '../../../../../../testing/fixtures/rendering-bundles/2026-06-21T20-14-23-131-62432945.json'
import recordedCodexWorktreeWindow from '../../../../../../testing/fixtures/worktree-live-attribution/codex-0151-worktree-window.json'
import recordedGitWorktrees from '../../../../../../testing/fixtures/worktree-live-attribution/git-worktree-identities.json'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  MAX_LIVE_ENTRIES,
  TRIM_TO_LIVE_ENTRIES,
} from '@renderer/session-runtime/liveEntryWindow'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { useStreamingActions } from '@renderer/workspace/hook/actions/streaming'
import { isOptimisticCodexUserEntry } from '@providers/codex/renderer/transcript/entries'
import { entryTextContent } from '@renderer/session-runtime/entries'

import { useIpcSubscriptions } from './useIpcSubscriptions'

const originalWindowApi = window.api

afterEach(() => {
  // The semantic burst test installs the smallest Electron bridge needed by
  // the ghost path and uses fake time for the 100 ms cadence. Restore both even
  // when an assertion fails so one backpressure regression cannot cascade into
  // misleading failures in the otherwise bridge-free subscription tests.
  vi.useRealTimers()
  if (originalWindowApi === undefined) {
    Reflect.deleteProperty(window, 'api')
  } else {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalWindowApi,
    })
  }
})

// Proof test for the phase-0 decoupling: the subscription hub must consume
// session events from an injected SessionFeed — NOT from window.api — so the
// same hook can be driven by IPC (desktop), WebSocket (remote client), or
// this fake (no Electron anywhere in this test). If someone reintroduces a
// direct `window.api.onSession*` call for a feed-covered event, this test
// crashes on the undefined bridge, which is exactly the regression signal
// we want.
//
// The harness builds the minimal honest WorkspaceRefs/state the handlers
// actually touch; it is NOT a full workspace. Desktop-only side channels
// (ghostAppend, gitWorktrees) are deliberately outside the feed and only
// fire on paths this test does not drive (ghost changes, session-started
// worktree refresh).

function makeRefs(state: WorkspaceState): WorkspaceRefs {
  // Plain object refs are fine outside React's render cycle — the hook only
  // ever reads/writes `.current`.
  const ref = <T,>(v: T): MutableRefObject<T> => ({ current: v })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    latestTileTabsRef: ref(null),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref(new UndoCloseStack()),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    pendingAdoptionWindowIdsRef: ref<string[]>([]),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}

describe('useIpcSubscriptions with an injected SessionFeed', () => {
  it('does not restamp startup submissions as a successor run during reconciliation', () => {
    const fake = createFakeSessionFeed()
    const sessionId = 'startup-submit-run-fence' as SessionId
    const successorRunId = '89898989-8989-4989-8989-898989898989'
    const optimisticSubmissionId = '81818181-8181-4181-8181-818181818181'
    const queuedReconcileSubmissionId = '82828282-8282-4282-8282-828282828282'
    const queuedReleaseSubmissionId = '83838383-8383-4383-8383-838383838383'
    const state = {
      sessions: { [sessionId]: { cwd: '/repo', kind: 'codex' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [sessionId]: emptyRuntime(),
    }
    let actions!: ReturnType<typeof useStreamingActions>
    let refsForTest!: WorkspaceRefs
    const commitRuntimes = (
      updater:
        | Record<SessionId, SessionRuntime>
        | ((current: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ): void => {
      runtimes = typeof updater === 'function' ? updater(runtimes) : updater
      refsForTest.latestRuntimesRef.current = runtimes
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) {
        refs.current = makeRefs(state)
        refs.current.latestRuntimesRef.current = runtimes
        refsForTest = refs.current
      }
      actions = useStreamingActions(commitRuntimes, () => true)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        commitRuntimes,
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      actions.addOptimisticCodexUserEntry(
        sessionId,
        'startup optimistic prompt',
        optimisticSubmissionId,
        null,
      )
    })
    const preQueue = runtimes[sessionId]!
    runtimes = {
      ...runtimes,
      [sessionId]: {
        ...preQueue,
        semantic: {
          ...preQueue.semantic,
          currentTurn: {
            turnId: 'startup-live-turn',
            source: 'proxy',
            text: '',
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
            endedAt: null,
            lookups: {
              toolCallsById: {},
              toolUseIdsInOrder: [],
              resolvedToolUseIds: [],
              erroredToolUseIds: [],
            },
          },
        },
      },
    }
    refsForTest.latestRuntimesRef.current = runtimes
    act(() => {
      actions.addOptimisticCodexUserEntry(
        sessionId,
        'startup queued reconcile',
        queuedReconcileSubmissionId,
        null,
      )
      actions.addOptimisticCodexUserEntry(
        sessionId,
        'startup queued release',
        queuedReleaseSubmissionId,
        null,
      )
    })

    // The backend begins only after all three ownership riders captured the
    // explicit no-run startup window. Reconciliation and release happen later,
    // while the runtime points at a real successor, which is the race that the
    // old truthy conditional spread accidentally re-stamped.
    runtimes = {
      ...runtimes,
      [sessionId]: { ...runtimes[sessionId]!, sessionRunId: successorRunId },
    }
    refsForTest.latestRuntimesRef.current = runtimes
    const committed = (text: string, offset: number) => ({
      file: 'rollout.jsonl',
      entry: {
        timestamp: `2026-08-30T14:00:0${offset}.000Z`,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      },
      observation: { fileGenerationId: 'dev:inode', rolloutByteOffset: offset },
    })
    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [
          committed('startup optimistic prompt', 1),
          committed('startup queued reconcile', 2),
        ],
      })
      fake.emitExit({ sessionId, exitCode: 0 })
    })

    const transitionObservations = runtimes[sessionId]!
      .codexTranscriptObservationOutbox
      .map(row => row.observation as {
        name?: string
        correlationIds?: Record<string, unknown>
      })
      .filter(row => row.name === 'submit.reconcile' || row.name === 'submit.release')
    expect(transitionObservations.map(row => row.correlationIds?.submissionId)).toEqual([
      optimisticSubmissionId,
      optimisticSubmissionId,
      queuedReconcileSubmissionId,
      queuedReconcileSubmissionId,
      queuedReleaseSubmissionId,
    ])
    for (const observation of transitionObservations) {
      expect(observation.correlationIds).not.toHaveProperty('sessionRunId')
      expect(Object.values(observation.correlationIds ?? {})).not.toContain(successorRunId)
    }
    // Both durable user rows arrived in one coalesced callback. Reconciliation
    // must remove every optimistic owner matched in that burst, not only the
    // text from the final mapped row; otherwise the evidence says prompt A was
    // released while its optimistic product row remains visibly duplicated.
    expect(runtimes[sessionId]!.entries.filter(isOptimisticCodexUserEntry)).toEqual([])
    expect(
      runtimes[sessionId]!.entries
        .filter(entry => entry.type === 'user')
        .map(entryTextContent),
    ).toEqual([
      'startup optimistic prompt',
      'startup queued reconcile',
    ])
  })

  it('replays recorded Codex activity when the asynchronous Git catalog arrives', async () => {
    const fake = createFakeSessionFeed()
    const sessionId = 'recorded-codex-worktree-cache-race'
    const fixture = recordedCodexWorktreeWindow as {
      git: {
        main: { path: string; branch: string }
        ui: { path: string; branch: string }
      }
      records: Array<Record<string, unknown>>
    }
    const gitFixture = recordedGitWorktrees as {
      worktrees: Array<{
        path: string
        branch: string
        detached: boolean
      }>
    }
    const state = {
      sessions: {
        [sessionId]: { cwd: fixture.git.main.path, kind: 'codex' },
      },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    let resolveGit!: (value: {
      ok: true
      worktrees: Array<{
        path: string
        branch: string
        detached: boolean
        head: null
      }>
    }) => void
    const gitResult = new Promise<{
      ok: true
      worktrees: Array<{
        path: string
        branch: string
        detached: boolean
        head: null
      }>
    }>(resolve => { resolveGit = resolve })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(() => gitResult) },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        (id, patch) => {
          const current = runtimes[id] ?? emptyRuntime()
          runtimes = { ...runtimes, [id]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      // The complaint-time order is important: session startup begins an IPC
      // Git lookup, then rollout bursts can arrive before that promise settles.
      // A test with a pre-populated cache would skip the actual live boundary
      // and prove only the direct tracker replay that already passed in #663.
      fake.emitStarted({
        sessionId,
        kind: 'codex',
        projectDir: fixture.git.main.path,
      })
      fake.emitJsonlEntries({
        sessionId,
        entries: fixture.records.map((entry, index) => ({
          file: `recorded-${index}.jsonl`,
          entry,
        })),
      })
    })

    expect(runtimes[sessionId]?.workContext?.worktreePath ?? null)
      .not.toBe(fixture.git.ui.path)

    await act(async () => {
      resolveGit({
        ok: true,
        worktrees: gitFixture.worktrees.map(worktree => ({
          ...worktree,
          head: null,
        })),
      })
      await gitResult
      await Promise.resolve()
    })

    expect(runtimes[sessionId]?.workActivity?.active).toMatchObject({
      worktreePath: fixture.git.ui.path,
      branch: fixture.git.ui.branch,
      source: 'codex:item_completed:CommandExecution.cwd',
    })
    expect(runtimes[sessionId]?.workContext).toMatchObject({
      worktreePath: fixture.git.ui.path,
      branch: fixture.git.ui.branch,
    })
  })

  it('hands a legacy queued prompt from the queue strip to its durable feed row across bursts', () => {
    const fake = createFakeSessionFeed()
    const sessionId = 'recorded-queue-handoff'
    const state = {
      sessions: { [sessionId]: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })
    const bundle = recordedQueueHandoffBundle as {
      input: { entries: Array<Record<string, unknown>> }
    }
    const enqueue = bundle.input.entries[7]!
    const remove = bundle.input.entries[8]!
    const durable = bundle.input.entries[13]!

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [{ file: 'recorded.jsonl', entry: enqueue }],
      })
    })

    expect(runtimes[sessionId]?.queuedMessages.map(item => item.content)).toEqual([
      enqueue.content,
    ])
    expect(runtimes[sessionId]?.awaitingAssistant).toBe(true)
    const runtimeAfterEnqueue = runtimes

    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [{ file: 'recorded.jsonl', entry: remove }],
      })
    })

    // The old content-free remove is deliberately not guessed away at the IPC
    // boundary. This record changes only hidden reconciliation debt: the queue
    // still owns the prompt and awaitingAssistant was already true. Returning
    // the existing runtime is therefore correct, but that invisible debt must
    // still survive outside React until the recorded durable identity arrives.
    expect(runtimes).toBe(runtimeAfterEnqueue)
    expect(runtimes[sessionId]?.queuedMessages.map(item => item.content)).toEqual([
      enqueue.content,
    ])

    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [{ file: 'recorded.jsonl', entry: durable }],
      })
    })

    // One transition, two planes: the queue item retires and the very same raw
    // durable attachment enters the shared feed window. No optimistic copy or
    // prompt clone is manufactured by the handoff.
    expect(runtimes[sessionId]?.queuedMessages).toEqual([])
    expect(runtimes[sessionId]?.entries).toContain(durable)
  })

  it('keeps runtime identity for a recorded queued notification with no remove debt', () => {
    const fake = createFakeSessionFeed()
    const sessionId = 'recorded-queue-notification-noop'
    const state = {
      sessions: { [sessionId]: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    const runtimesBefore = runtimes
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })
    const bundle = recordedTaskNotificationBundle as {
      input: { entries: Array<Record<string, unknown>> }
    }
    const notification = bundle.input.entries[43]!
    const attachment = notification.attachment as Record<string, unknown>
    if (
      notification.type !== 'attachment' ||
      attachment.type !== 'queued_command' ||
      attachment.commandMode !== 'task-notification'
    ) {
      throw new Error('recorded queued-notification fixture index drifted')
    }

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      fake.emitJsonlEntries({
        sessionId,
        entries: [{ file: 'recorded.jsonl', entry: notification }],
      })
    })

    // This durable carrier is queue evidence, not a human feed row. With no
    // legacy remove debt it changes neither pure queue state nor mapped feed
    // entries. Replacing emptyRuntime()'s [] with claudeQueue's distinct []
    // would manufacture a visible runtime update from a pure no-op and defeat
    // the same reference-stability contract that protects queue-only bursts.
    expect(runtimes).toBe(runtimesBefore)
    expect(runtimes[sessionId]).toBeUndefined()
  })

  it('folds a cumulative semantic burst at preview cadence instead of once per transport event', () => {
    vi.useFakeTimers()
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    const ghostAppend = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ghostAppend },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        () => {},
        () => {},
      )
      return <div />
    }

    const mounted = render(<Harness />)
    act(() => {
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: { type: 'turn_started', turnId: 'turn-1', source: 'proxy', ts: 1 },
      })
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'block_started',
          turnId: 'turn-1',
          blockIndex: 0,
          kind: 'tool_use',
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          source: 'proxy',
          ts: 2,
        },
      })
      for (let index = 1; index <= 1_000; index += 1) {
        fake.emitSemantic({
          sessionId: 'burst-1',
          event: {
            type: 'tool_input_delta',
            turnId: 'turn-1',
            blockIndex: 0,
            toolName: 'apply_patch',
            toolUseId: 'tool-1',
            partialJson: 'x',
            inputJsonSoFar: 'x'.repeat(index),
            source: 'proxy',
            ts: index + 2,
          },
        })
      }
    })

    // turn_started + block_started are ordering boundaries and are visible
    // immediately. The 1,000 obsolete input prefixes wait as ONE snapshot.
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe('')
    expect(ghostAppend).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe(
      'x'.repeat(1_000),
    )
    // One initial ghost plus one latest cumulative snapshot. The pre-fix hook
    // invoked IPC 1,001 times here and journaled every growing copy.
    expect(ghostAppend).toHaveBeenCalledTimes(2)

    act(() => {
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'tool_input_delta',
          turnId: 'turn-1',
          blockIndex: 0,
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          partialJson: 'y',
          inputJsonSoFar: `${'x'.repeat(1_000)}y`,
          source: 'proxy',
          ts: 1_003,
        },
      })
      fake.emitSemantic({
        sessionId: 'burst-1',
        event: {
          type: 'tool_input_finalized',
          turnId: 'turn-1',
          blockIndex: 0,
          toolName: 'apply_patch',
          toolUseId: 'tool-1',
          inputJson: `${'x'.repeat(1_000)}y`,
          parsed: { patch: 'final' },
          source: 'proxy',
          ts: 1_004,
        },
      })
    })

    // A structural event bypasses the timer but first drains the pending
    // latest delta, so completion can never overtake or later be resurrected
    // by a stale timer callback.
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.inputJson).toBe(
      `${'x'.repeat(1_000)}y`,
    )
    expect(runtimes['burst-1']?.semantic.currentTurn?.blocks[0]?.parsedInput).toEqual({
      patch: 'final',
    })

    mounted.unmount()
  })

  it('folds a screen event from the fake feed into session runtimes', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        updater => {
          // setState is unused by the screen path; apply for completeness.
          void updater
        },
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        (sessionId, patch) => {
          runtimes = {
            ...runtimes,
            [sessionId]: { ...(runtimes[sessionId] as SessionRuntime), ...patch },
          }
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitScreen({
        sessionId: 's1',
        plain: 'hello world',
        markdown: 'hello world',
        recent: 'hello world',
        recentMarkdown: 'hello world',
        picker: { visible: false, items: [] },
      })
    })

    expect(runtimes.s1?.screen).toBe('hello world')
    expect(runtimes.s1?.recentScreen).toBe('hello world')
  })

  it('treats provider readiness as versioned state, never as process activity', () => {
    const fake = createFakeSessionFeed()
    const state = {
      sessions: { s1: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { gitWorktrees: vi.fn(async () => ({ ok: false })) },
    })

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        (sessionId, patch) => {
          const current = runtimes[sessionId] ?? emptyRuntime()
          runtimes = { ...runtimes, [sessionId]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitStarted({ sessionId: 's1', kind: 'claude', projectDir: '/repo' })
      fake.emitProcessState({ sessionId: 's1', active: false })
    })
    expect(runtimes.s1).toMatchObject({
      processStatus: 'started',
      inputReady: false,
      inputReadinessRevision: -1,
    })

    act(() => {
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: true, revision: 2, reason: 'ready' },
      })
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: false, revision: 1, reason: 'replaying-history' },
      })
      fake.emitProcessState({ sessionId: 's1', active: true, status: 'Working' })
    })
    expect(runtimes.s1).toMatchObject({
      inputReady: true,
      inputReadinessRevision: 2,
      processActive: true,
    })

    act(() => {
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: false, revision: 3, reason: 'provider-not-ready' },
      })
    })
    expect(runtimes.s1).toMatchObject({
      inputReady: false,
      inputReadinessRevision: 3,
    })
  })

  it('quarantines every content and lifecycle channel after an ownership conflict', () => {
    const fake = createFakeSessionFeed()
    const state = {
      sessions: { s1: { cwd: '/repo', kind: 'claude' } },
    } as unknown as WorkspaceState
    const conflictedRuntime: SessionRuntime = {
      ...emptyRuntime(),
      processStatus: 'failed',
      processError: 'Session id is owned by another workspace',
      recoveryFailureCode: 'ownership-conflict',
      draftInput: 'renderer-local draft survives',
    }
    let runtimes: Record<SessionId, SessionRuntime> = { s1: conflictedRuntime }
    let refsForAssertion: WorkspaceRefs | null = null

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) {
        refs.current = makeRefs(state)
        refs.current.latestRuntimesRef.current = runtimes
        refsForAssertion = refs.current
      }
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
          refs.current!.latestRuntimesRef.current = runtimes
        },
        (sessionId, patch) => {
          const current = runtimes[sessionId] ?? emptyRuntime()
          runtimes = { ...runtimes, [sessionId]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)
    act(() => {
      fake.emitStarted({ sessionId: 's1', kind: 'claude', projectDir: '/wrong-repo' })
      fake.emitInputReadiness({
        sessionId: 's1',
        input: { ready: true, revision: 99, reason: 'ready' },
      })
      fake.emitScreen({
        sessionId: 's1',
        plain: 'wrong backend content',
        markdown: 'wrong backend content',
        recent: 'wrong backend content',
        recentMarkdown: 'wrong backend content',
        picker: { visible: false, items: [] },
      })
      fake.emitProcessState({ sessionId: 's1', active: true, status: 'Working' })
      fake.emitSemantic({
        sessionId: 's1',
        event: { type: 'turn_started', turnId: 'wrong-turn', source: 'proxy', ts: 1 },
      })
      fake.emitExit({ sessionId: 's1', exitCode: 17 })
    })

    // WHY reference equality matters here: merely restoring the visible error
    // after folding a wrong event would still transiently ingest another
    // workspace's text and mutate hidden semantic/debug state. Quarantine must
    // return before every state/ref write until matching ownership is proven.
    expect(runtimes.s1).toBe(conflictedRuntime)
    expect(refsForAssertion!.latestScreenRef.current.s1).toBeUndefined()
  })

  it('retains the retired run across exit and replaces it only on the next started event', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        (sessionId, patch) => {
          const current = runtimes[sessionId] ?? emptyRuntime()
          runtimes = { ...runtimes, [sessionId]: { ...current, ...patch } }
          refs.current!.latestRuntimesRef.current = runtimes
        },
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    act(() => {
      fake.emitStarted({
        sessionId: 's1',
        sessionRunId: '66666666-6666-4666-8666-666666666666',
        kind: 'codex',
      })
    })
    expect(runtimes.s1?.sessionRunId).toBe('66666666-6666-4666-8666-666666666666')

    act(() => {
      fake.emitExit({ sessionId: 's1', exitCode: 0 })
    })

    expect(runtimes.s1?.exited).toBe(0)
    expect(runtimes.s1?.processActive).toBe(false)
    expect(runtimes.s1?.sessionRunId).toBe('66666666-6666-4666-8666-666666666666')

    act(() => {
      fake.emitStarted({
        sessionId: 's1',
        sessionRunId: '77777777-7777-4777-8777-777777777777',
        kind: 'codex',
      })
    })
    expect(runtimes.s1?.sessionRunId).toBe('77777777-7777-4777-8777-777777777777')
  })

  // Live entries window (#375 part B) — the burst handler applying a trim
  // plan. The pure planner's constraint matrix is covered in
  // session-runtime/entries.test.ts; this exercises the wiring: window
  // bound applied, totalEntries NEVER decremented, pagination re-anchored,
  // and the asymmetric dedupe keeping a replay of trimmed rows off the tail.
  it('trims the live window past MAX_LIVE_ENTRIES without touching totalEntries, and blocks tail replay of trimmed rows', () => {
    const fake = createFakeSessionFeed()
    const state = { sessions: {} } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}

    function Harness(): React.JSX.Element {
      const refs = useRef<WorkspaceRefs | null>(null)
      if (refs.current === null) refs.current = makeRefs(state)
      useIpcSubscriptions(
        fake,
        refs.current,
        () => {},
        updater => {
          runtimes = typeof updater === 'function' ? updater(runtimes) : updater
        },
        () => {},
        () => {},
      )
      return <div />
    }

    render(<Harness />)

    // A distinct sessionId per test: the trimmed-uuid bookkeeping is
    // module-level (mirroring seenUuids semantics), so sessions must not be
    // shared across test cases.
    const sessionId = 'win-1'
    const total = MAX_LIVE_ENTRIES + 100
    const baseTs = Date.parse('2026-07-09T10:00:00.000Z')
    // Claude-shaped user lines: no session meta exists for this pane, so the
    // handler's shape-sniff fallback routes them through the claude mapper,
    // whose pagination marker IS the entry uuid.
    const burst = Array.from({ length: total }, (_, i) => ({
      file: 'transcript.jsonl',
      entry: {
        type: 'user',
        uuid: `win-u-${i}`,
        parentUuid: null,
        timestamp: new Date(baseTs + i * 1000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `row ${i}` }] },
      },
    }))

    act(() => {
      fake.emitJsonlEntries({ sessionId, entries: burst })
    })

    const cut = total - TRIM_TO_LIVE_ENTRIES
    const runtime = runtimes[sessionId]
    expect(runtime?.entries.length).toBe(TRIM_TO_LIVE_ENTRIES)
    // The on-disk denominator is untouched by the window.
    expect(runtime?.totalEntries).toBe(total)
    // Pagination can reload the trimmed region: re-anchored strictly at the
    // oldest RETAINED entry, with older history re-enabled.
    expect(runtime?.hasOlderHistory).toBe(true)
    expect(runtime?.historyOldestMarker).toBe(`win-u-${cut}`)
    expect(runtime?.entries[0]?.uuid).toBe(`win-u-${cut}`)
    // Debug bundles stay explainable — the trim leaves a STATE record.
    expect(
      runtime?.feedDebugLog.some(entry => entry.kind === 'entries_trimmed'),
    ).toBe(true)

    // A replay of already-trimmed rows (resume bootstrapTail) must be
    // treated as seen — nothing re-appends at the tail.
    act(() => {
      fake.emitJsonlEntries({ sessionId, entries: burst.slice(0, 5) })
    })
    expect(runtimes[sessionId]?.entries.length).toBe(TRIM_TO_LIVE_ENTRIES)
    expect(runtimes[sessionId]?.totalEntries).toBe(total)
    expect(runtimes[sessionId]?.entries.at(-1)?.uuid).toBe(`win-u-${total - 1}`)
  })
})
