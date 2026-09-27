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

// #1369 verification a/b: the renderer's copy of the lineage. Own ids per
// case: the map is per-window module state.
it('resolves a parent through its successors, stops at a revived pane, and keeps at most 500', async () => {
  const { currentOrchestrationParent } = await import('./successorCarry')
  window.api = { ...originalApi, carryOrchestrationParent: vi.fn(async () => undefined) } as never
  carryOrchestrationParents(new Map([['lin-a', 'lin-b']]))
  carryOrchestrationParents(new Map([['lin-b', 'lin-c']]))
  expect(currentOrchestrationParent('lin-a')).toBe('lin-c')
  // lin-a comes back as a live pane: its old edge must go (no loop, and a
  // child created under it now stays with it).
  carryOrchestrationParents(new Map([['lin-c', 'lin-a']]))
  expect(currentOrchestrationParent('lin-a')).toBe('lin-a')
  expect(currentOrchestrationParent('lin-b')).toBe('lin-a')

  for (let i = 0; i < 510; i++) carryOrchestrationParents(new Map([[`cap-${i}`, `cap-${i}-next`]]))
  expect(currentOrchestrationParent('cap-509')).toBe('cap-509-next')
  expect(currentOrchestrationParent('cap-0')).toBe('cap-0')
})
