import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportLifecycle } from '@renderer/lifecycle/report'
import type { SessionId } from '@renderer/workspace/types'

import {
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
})
