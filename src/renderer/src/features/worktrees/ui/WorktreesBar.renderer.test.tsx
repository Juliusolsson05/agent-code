import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorktreeDump } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// ---------------------------------------------------------------------------
// Regression coverage for #150 — "runaway loop/crash when opening worktree
// panel". The defect itself was fixed by ccc95b01 (PR #355, 2026-06-24); these
// tests exist because that fix shipped with NO test, and it is one lint-fix
// away from being reverted.
//
// WHY these two contracts and not a render snapshot: #150 was never about what
// the panel draws. It was about how OFTEN it asks for data. The loop had two
// independent sources, and each is pinned by one test below:
//
//   1. `workspace` is a context value whose reference changes on every agent
//      runtime tick. In `refresh`'s dependency array it rebuilds the callback
//      every tick, which re-runs the mount effect, which clears and restarts
//      the 10s poll — so the interval is perpetually reset and the panel
//      re-scans git in a tight loop. It is held in `workspaceRef` instead.
//   2. Overlapping refreshes were not coalesced, so a poll landing on top of a
//      user refresh (or a second panel open) fanned out duplicate git work.
//      `refreshInFlightRef` collapses them.
//
// WHY the seam is `loadWorktreeDump` and not the IPC layer: the contract under
// test belongs to this component — "how many times does the panel ask?" —
// while what the loader returns, and how main bounds the git subprocesses it
// spawns, are separately owned (loadWorktreeDump.test.ts, and the process-wide
// limiter in ipc/git.ts). Mocking here keeps the assertion on the one
// behaviour that regressed, and keeps the test off the real git/IPC path.
//
// The mount effect deliberately carries an `eslint-disable
// react-hooks/exhaustive-deps`. If a future cleanup "fixes" that lint error by
// adding `workspace` or `dump` back to a dependency array, contract 1 fails.
// That is the entire point of this file.
// ---------------------------------------------------------------------------

const loadWorktreeDump = vi.hoisted(() => vi.fn())

vi.mock('@renderer/features/worktrees/lib/loadWorktreeDump', () => ({
  loadWorktreeDump,
}))

// Imported after the mock is registered so the component binds the stub.
const { WorktreesBar } = await import('@renderer/features/worktrees/ui/WorktreesBar')

const POLL_MS = 10_000

function dumpFor(cwd: string): WorktreeDump {
  return {
    cwd,
    generatedAt: Date.now(),
    rows: [],
    indexStatus: null,
    gitUnavailable: false,
    gitMissing: false,
    activityUnavailable: false,
  }
}

/**
 * A fresh object every call. This is the point of the fixture, not an
 * incidental detail: the real `Workspace` handed to this panel is a context
 * value that gets a NEW identity on every agent runtime tick, and reference
 * churn is precisely what used to restart the poll. A shared constant would
 * make contract 1 pass even with the bug reintroduced.
 */
function workspaceTick(): Workspace {
  return { state: { tabs: [], sessions: {} }, runtimes: {} } as unknown as Workspace
}

beforeEach(() => {
  vi.useFakeTimers()
  loadWorktreeDump.mockReset()
  loadWorktreeDump.mockImplementation(async () => dumpFor('/repo'))
})

afterEach(() => {
  // Fake timers must be released on failure as well as success, or a thrown
  // assertion leaves every later renderer file running on a frozen clock.
  vi.useRealTimers()
})

describe('WorktreesBar refresh guards (#150)', () => {
  it('keeps polling on its original schedule while workspace identity churns', async () => {
    const { rerender } = render(
      <WorktreesBar cwd="/repo" workspace={workspaceTick()} onClose={() => {}} />,
    )

    // The mount load. Everything after this measures the POLL, not the mount.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(loadWorktreeDump).toHaveBeenCalledTimes(1)

    // Sit just short of the poll boundary, then simulate a burst of agent
    // runtime ticks. None of these should touch the timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS - 1_000) })
    for (let tick = 0; tick < 5; tick += 1) {
      rerender(<WorktreesBar cwd="/repo" workspace={workspaceTick()} onClose={() => {}} />)
    }

    // THIS is the assertion that catches the regression, and it was confirmed
    // by reverting the guard: with `workspace` back in `refresh`'s deps, each
    // re-render mints a new `refresh`, which re-runs the mount effect. By now
    // the mount dump is older than MOUNT_REUSE_WINDOW_MS, so the effect's
    // freshness check declines to reuse it and issues an immediate load — one
    // extra git scan per agent runtime tick. That is #150's runaway loop
    // exactly, and the count here goes to 2 instead of staying at 1.
    expect(loadWorktreeDump).toHaveBeenCalledTimes(1)

    // Cross the original 10s boundary. The interval was set at mount and must
    // still be the one running: the re-renders above must not have torn it
    // down and restarted it, or the next fire would land 10s after the LAST
    // re-render rather than here. A poll reset faster than its own period
    // never completes a scheduled refresh — the starvation half of the same
    // bug, and the reason this second assertion is not redundant with the one
    // above.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(loadWorktreeDump).toHaveBeenCalledTimes(2)
  })

  it('coalesces a refresh requested while a load is still in flight', async () => {
    let releaseFirstLoad: (() => void) | undefined
    loadWorktreeDump.mockImplementationOnce(
      () => new Promise<WorktreeDump>(resolve => {
        releaseFirstLoad = () => resolve(dumpFor('/repo'))
      }),
    )

    render(<WorktreesBar cwd="/repo" workspace={workspaceTick()} onClose={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(loadWorktreeDump).toHaveBeenCalledTimes(1)

    // The mount load is deliberately still unresolved here. A user hitting
    // refresh now must join the in-flight load, not start a second git scan.
    fireEvent.click(screen.getByTitle('Refresh worktree activity index'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(loadWorktreeDump).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirstLoad?.()
      await vi.advanceTimersByTimeAsync(0)
    })

    // The other half of the contract, and the reason this is not just an
    // "expect 1" test: a coalescer that never clears its in-flight slot would
    // also pass the assertion above, while silently killing every refresh for
    // the rest of the session. The guard must RELEASE once the load settles.
    fireEvent.click(screen.getByTitle('Refresh worktree activity index'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(loadWorktreeDump).toHaveBeenCalledTimes(2)
  })
})
