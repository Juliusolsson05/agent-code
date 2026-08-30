import { act, render, renderHook } from '@testing-library/react'
import { StrictMode, useEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportLifecycle } from '@renderer/lifecycle/report'
import type { SessionId } from '@renderer/workspace/types'

import {
  commitVisibleSubmitSurfaceOwner,
  useVisibleSubmitSurfaceUnmountCleanup,
  type VisibleSubmitSurface,
} from './useVisibleSubmitSurfaceUnmountCleanup'

vi.mock('@renderer/lifecycle/report', () => ({ reportLifecycle: vi.fn() }))

afterEach(() => {
  vi.clearAllMocks()
})

describe('TileLeaf visible submit surface lifetime', () => {
  it('ignores StrictMode effect replay and closes only the real tile unmount', async () => {
    const sessionIdRef = {
      current: '91919191-9191-4191-8191-919191919191' as SessionId,
    }
    const surfacesRef = {
      current: new Map<string, VisibleSubmitSurface>([[
        'selected',
        {
          surface: 'render-selected',
          sessionRunId: '92929292-9292-4292-8292-929292929292',
          submissionId: '93939393-9393-4393-8393-939393939393',
          renderCandidateId: 'optimistic-submission:93939393-9393-4393-8393-939393939393',
          entryOrdinal: 7,
        },
      ]]),
    }
    const view = renderHook(
      () => useVisibleSubmitSurfaceUnmountCleanup(sessionIdRef, surfacesRef),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        ),
      },
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(reportLifecycle).not.toHaveBeenCalled()
    view.rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(reportLifecycle).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(reportLifecycle).toHaveBeenCalledTimes(1)
    expect(reportLifecycle).toHaveBeenCalledWith(
      'submit.surface',
      sessionIdRef.current,
      { surface: 'render-selected', visible: false, entryOrdinal: 7 },
      {
        sessionRunId: '92929292-9292-4292-8292-929292929292',
        submissionId: '93939393-9393-4393-8393-939393939393',
        renderCandidateId: 'optimistic-submission:93939393-9393-4393-8393-939393939393',
      },
    )
  })

  it('hands the same visible candidate across component instances without a false close', async () => {
    const sessionId = '94949494-9494-4494-8494-949494949494' as SessionId
    const surface: VisibleSubmitSurface = {
      surface: 'render-selected',
      sessionRunId: '95959595-9595-4595-8595-959595959595',
      submissionId: '96969696-9696-4696-8696-969696969696',
      renderCandidateId: 'optimistic-submission:96969696-9696-4696-8696-969696969696',
      entryOrdinal: 11,
    }

    function Owner(): null {
      const sessionIdRef = useRef(sessionId)
      const surfacesRef = useRef<ReadonlyMap<string, VisibleSubmitSurface>>(
        new Map([['selected', surface]]),
      )
      const owner = useVisibleSubmitSurfaceUnmountCleanup(sessionIdRef, surfacesRef)
      useEffect(() => {
        commitVisibleSubmitSurfaceOwner(owner, sessionId, surfacesRef.current)
      }, [owner])
      return null
    }

    const view = render(<Owner key="tile-tree" />)
    expect(reportLifecycle).toHaveBeenCalledTimes(1)
    expect(reportLifecycle).toHaveBeenLastCalledWith(
      'submit.surface',
      sessionId,
      { surface: 'render-selected', visible: true, entryOrdinal: 11 },
      expect.objectContaining({ submissionId: surface.submissionId }),
    )

    // Spotlight replaces TileTree with a fresh TileLeaf for the same session.
    // The replacement commits before the predecessor's deferred cleanup, so
    // aggregate ownership must keep the surface continuously open.
    view.rerender(<Owner key="spotlight" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(reportLifecycle).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(reportLifecycle).toHaveBeenCalledTimes(2)
    expect(reportLifecycle).toHaveBeenLastCalledWith(
      'submit.surface',
      sessionId,
      { surface: 'render-selected', visible: false, entryOrdinal: 11 },
      expect.objectContaining({ submissionId: surface.submissionId }),
    )
  })
})
