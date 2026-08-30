import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'

import {
  appendCodexTranscriptObservation,
  useCodexTranscriptObservationOutbox,
} from './codexTranscriptObservationOutbox'

const originalWindowApi = window.api

afterEach(() => {
  if (originalWindowApi === undefined) {
    Reflect.deleteProperty(window, 'api')
  } else {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalWindowApi,
    })
  }
})

describe('Codex transcript observation outbox', () => {
  it('emits only after commit and retains the run that owned the transition', () => {
    const reportSessionLifecycle = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { reportSessionLifecycle },
    })
    const sessionId = 'pane-1' as SessionId
    const retiredRunId = '11111111-1111-4111-8111-111111111111'
    const successorRunId = '22222222-2222-4222-8222-222222222222'
    const submissionId = '33333333-3333-4333-8333-333333333333'
    const initial = {
      ...emptyRuntime(),
      sessionRunId: retiredRunId,
    }

    let abandonedUpdater: ((runtime: SessionRuntime) => SessionRuntime) | null = runtime =>
      appendCodexTranscriptObservation(
        runtime,
        'submit.release',
        { cause: 'session-exit' },
        { submissionId, renderCandidateId: `queued:${submissionId}` },
      )

    const view = renderHook(() => {
      const [runtimes, setRuntimes] = useState<Record<SessionId, SessionRuntime>>({
        [sessionId]: initial,
      })
      useCodexTranscriptObservationOutbox(runtimes)
      return { runtimes, setRuntimes }
    })

    // Merely evaluating the same transition React could later abandon does
    // not cross IPC. Only state accepted by the mounted outbox is observable.
    abandonedUpdater(initial)
    expect(reportSessionLifecycle).not.toHaveBeenCalled()

    act(() => {
      view.result.current.setRuntimes(previous => {
        const observed = abandonedUpdater!(previous[sessionId]!)
        // Model the replacement race: the same React commit installs the new
        // backend run after recording the old run's exit-owned release.
        return {
          ...previous,
          [sessionId]: { ...observed, sessionRunId: successorRunId },
        }
      })
    })
    abandonedUpdater = null

    expect(view.result.current.runtimes[sessionId]?.sessionRunId).toBe(successorRunId)
    expect(reportSessionLifecycle).toHaveBeenCalledTimes(1)
    expect(reportSessionLifecycle).toHaveBeenCalledWith({
      name: 'submit.release',
      sessionId,
      data: { cause: 'session-exit' },
      correlationIds: {
        sessionRunId: retiredRunId,
        submissionId,
        renderCandidateId: `queued:${submissionId}`,
      },
    })
  })

  it('marks a ring discontinuity when one commit evicts pending observations', () => {
    const reportSessionLifecycle = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { reportSessionLifecycle },
    })
    const sessionId = '72727272-7272-4272-8272-727272727272' as SessionId
    const sessionRunId = '73737373-7373-4373-8373-737373737373'
    const view = renderHook(() => {
      const [runtimes, setRuntimes] = useState<Record<SessionId, SessionRuntime>>({
        [sessionId]: { ...emptyRuntime(), sessionRunId },
      })
      useCodexTranscriptObservationOutbox(runtimes)
      return { setRuntimes }
    })

    act(() => {
      view.result.current.setRuntimes(previous => {
        let next = previous[sessionId]!
        // The shared ring keeps 500 rows. Committing 501 transitions at once
        // reproduces the renderer starvation shape without relying on timing.
        for (let index = 0; index < 501; index += 1) {
          next = appendCodexTranscriptObservation(next, 'transcript.snapshot', {
            entryCount: index,
          })
        }
        return { ...previous, [sessionId]: next }
      })
    })

    expect(reportSessionLifecycle).toHaveBeenCalledTimes(501)
    expect(reportSessionLifecycle.mock.calls[0]?.[0]).toEqual({
      name: 'transcript.outbox-gap',
      sessionId,
      data: { missedFeedRows: 1 },
    })
  })
})
