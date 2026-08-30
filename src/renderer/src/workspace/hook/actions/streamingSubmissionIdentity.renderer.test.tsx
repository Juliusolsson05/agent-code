import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import { useCodexTranscriptObservationOutbox } from '@renderer/lifecycle/codexTranscriptObservationOutbox'

import {
  optimisticEntrySubmissionId,
  queuedMessageSubmissionId,
  useStreamingActions,
} from './streaming'

const originalWindowApi = window.api

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWindowApi === undefined) {
    Reflect.deleteProperty(window, 'api')
  } else {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalWindowApi,
    })
  }
})

function harness(
  initial: Record<SessionId, SessionRuntime>,
  isCodexSession: (sessionId: SessionId) => boolean = () => true,
) {
  const view = renderHook(() => {
    const [runtimes, setRuntimes] = useState(initial)
    const actions = useStreamingActions(setRuntimes, isCodexSession)
    useCodexTranscriptObservationOutbox(runtimes)
    return { actions, runtimes }
  })
  return {
    view,
    get: (id: SessionId) => view.result.current.runtimes[id],
  }
}

function lifecycleBridge() {
  const reportSessionLifecycle = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { reportSessionLifecycle },
  })
  return reportSessionLifecycle
}

describe('optimistic submission observation identity', () => {
  it('does not join distinct candidates created in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_788_120_000_000)
    const reportSessionLifecycle = lifecycleBridge()
    const sessionId = 'same-millisecond' as SessionId
    const firstSubmissionId = '00000000-0000-4000-8000-000000000001'
    const secondSubmissionId = '00000000-0000-4000-8000-000000000002'
    const h = harness({ [sessionId]: emptyRuntime() })

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'first prompt',
        firstSubmissionId,
      )
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'second prompt',
        secondSubmissionId,
      )
    })

    // Product UUIDs remain byte-for-byte unchanged in Stage 0 and therefore
    // collide under the frozen clock. The observation graph must not reuse
    // that known-nonunique key as evidence identity.
    expect(h.get(sessionId).entries.map(entry => entry.uuid)).toEqual([
      'optimistic-codex-user:1788120000000',
      'optimistic-codex-user:1788120000000',
    ])
    const candidateIds = reportSessionLifecycle.mock.calls
      .map(([report]) => report.correlationIds?.renderCandidateId)
      .filter(Boolean)
    expect(candidateIds).toEqual([
      `optimistic-submission:${firstSubmissionId}`,
      `optimistic-submission:${secondSubmissionId}`,
    ])
  })

  it('keeps repeated identical submits distinct without changing the existing row-dedupe rule', () => {
    const reportSessionLifecycle = lifecycleBridge()
    const sessionId = 'same-text' as SessionId
    const firstSubmissionId = '10000000-0000-4000-8000-000000000001'
    const secondSubmissionId = '10000000-0000-4000-8000-000000000002'
    const h = harness({ [sessionId]: emptyRuntime() })

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'repeat me',
        firstSubmissionId,
      )
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'repeat me',
        secondSubmissionId,
      )
    })

    // Stage 0 is deliberately not a product-behaviour change: the adjacent
    // duplicate still shares the one optimistic row it did before. The two
    // distinct Enter identities nevertheless both cross the lifecycle sink.
    expect(h.get(sessionId).entries).toHaveLength(1)
    expect(optimisticEntrySubmissionId(h.get(sessionId).entries[0]!)).toBe(firstSubmissionId)
    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.surface',
      correlationIds: expect.objectContaining({ submissionId: firstSubmissionId }),
      data: expect.objectContaining({ surface: 'optimistic-entry', changed: true }),
    }))
    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.surface',
      correlationIds: expect.objectContaining({ submissionId: secondSubmissionId }),
      data: expect.objectContaining({ surface: 'duplicate-suppressed', changed: false }),
    }))
  })

  it('carries a submission id through the app-owned queue without changing its text contract', () => {
    const reportSessionLifecycle = lifecycleBridge()
    const sessionId = 'queued' as SessionId
    const submissionId = '20000000-0000-4000-8000-000000000001'
    const runtime = {
      ...emptyRuntime(),
      semantic: {
        ...emptyRuntime().semantic,
        currentTurn: {
          turnId: 'live-turn',
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
    } as SessionRuntime
    const h = harness({ [sessionId]: runtime })

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'queued follow-up',
        submissionId,
      )
    })

    expect(h.get(sessionId).queuedMessages).toEqual([
      expect.objectContaining({ content: 'queued follow-up' }),
    ])
    expect(h.get(sessionId).queuedMessages[0]).not.toHaveProperty('submissionId')
    expect(queuedMessageSubmissionId(h.get(sessionId).queuedMessages[0]!)).toBe(submissionId)
    expect(h.get(sessionId).entries).toEqual([])
    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.surface',
      correlationIds: {
        submissionId,
        renderCandidateId: `queued:${submissionId}`,
      },
      data: expect.objectContaining({
        surface: 'queued-strip',
        queueReason: 'live-current-turn',
      }),
    }))
  })

  it('records release only when the matching app-owned row is actually removed', () => {
    const reportSessionLifecycle = lifecycleBridge()
    const sessionId = 'failed-write' as SessionId
    const submissionId = '30000000-0000-4000-8000-000000000001'
    const h = harness({ [sessionId]: emptyRuntime() })

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'never reached Codex',
        submissionId,
      )
      h.view.result.current.actions.removeOptimisticCodexUserEntry(
        sessionId,
        'never reached Codex',
        submissionId,
        undefined,
        'before-write-failure',
      )
    })

    expect(h.get(sessionId).entries).toEqual([])
    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.release',
      data: { cause: 'before-write-failure' },
      correlationIds: expect.objectContaining({ submissionId }),
    }))
  })

  it('does not claim a before-write failure after a potentially partial send', () => {
    const reportSessionLifecycle = lifecycleBridge()
    const sessionId = 'partial-write' as SessionId
    const submissionId = '35000000-0000-4000-8000-000000000001'
    const h = harness({ [sessionId]: emptyRuntime() })

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'body may have reached Codex',
        submissionId,
      )
      h.view.result.current.actions.removeOptimisticCodexUserEntry(
        sessionId,
        'body may have reached Codex',
        submissionId,
        undefined,
        'write-status-uncertain',
      )
    })

    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.release',
      data: { cause: 'write-status-uncertain' },
      correlationIds: expect.objectContaining({ submissionId }),
    }))
    expect(reportSessionLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({
      name: 'submit.release',
      data: { cause: 'before-write-failure' },
    }))
  })

  it('does not change OpenCode product row shapes when the composer passes an id', () => {
    lifecycleBridge()
    const sessionId = 'opencode-pane' as SessionId
    const h = harness({ [sessionId]: emptyRuntime() }, () => false)

    act(() => {
      h.view.result.current.actions.addOptimisticCodexUserEntry(
        sessionId,
        'shared optimistic path',
        '40000000-0000-4000-8000-000000000001',
      )
    })

    const entry = h.get(sessionId).entries[0]!
    expect(entry).not.toHaveProperty('agentCodeSubmissionId')
    expect(optimisticEntrySubmissionId(entry)).toBeNull()
    expect(h.get(sessionId).feedDebugLog.at(-1)?.data).not.toHaveProperty('submissionId')
  })
})
