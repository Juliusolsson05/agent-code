import { afterEach, expect, it, vi } from 'vitest'

import { carryOrchestrationParents } from './successorCarry'

// #1369 review c: the renderer half of the orchestration carry. It runs right
// after a swap commits, so it must never throw into that commit (a failed IPC
// is logged, not rejected), and an identity pair (a pane that kept its id)
// is not a replacement.
const originalApi = window.api
afterEach(() => { window.api = originalApi; vi.restoreAllMocks() })

it('carries each replaced id, skips a pane that kept its id, and contains a failed IPC', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  const carry = vi.fn(async (from: string, _to: string) => { if (from === 'broken') throw new Error('ipc gone') })
  window.api = { ...originalApi, carryOrchestrationParent: carry } as never
  try {
    expect(() => carryOrchestrationParents(new Map([['old', 'new'], ['same', 'same'], ['broken', 'next']]))).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[orchestration] carry to the replacement session failed:', expect.any(Error)))
    expect(carry.mock.calls).toEqual([['old', 'new'], ['broken', 'next']])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})
