import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { GoalLoopPane } from './GoalLoopPane'
import { dismissGoalLoop, toggleGoalLoop } from './viewState'

const loop = (overrides: Partial<GoalLoopState> = {}): GoalLoopState => ({
  sessionId: 's1', goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null, maxContinuations: 25,
  continuationsDelivered: 3, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', ...overrides,
})
const api = {
  readGoalLoops: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, loop()]))),
  controlGoalLoop: vi.fn(async () => loop()),
  onGoalLoopChanged: vi.fn((_listener: () => void) => () => {}),
}
beforeEach(() => {
  vi.clearAllMocks()
  dismissGoalLoop()
  Object.assign(window, { api })
})
afterEach(() => { cleanup(); dismissGoalLoop() })

describe('GoalLoopPane', () => {
  it('renders the always-on strip with budget and controls for an active loop', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    expect(await screen.findAllByText(/iteration 3\/25/)).not.toHaveLength(0)
    screen.getByText('Pause')
    screen.getByText('Stop')
  })
  it('renders nothing without a loop', async () => {
    api.readGoalLoops.mockResolvedValueOnce({})
    const { container } = render(<GoalLoopPane sessionId="s1" />)
    await waitFor(() => expect(api.readGoalLoops).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
  it('pause calls controlGoalLoop and the latch reveals the overlay', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    // The strip appears after the async IPC read resolves.
    ;(await screen.findByText('Pause')).click()
    expect(api.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 's1', action: 'pause', value: undefined })
    toggleGoalLoop()
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
  it('offers Dismiss, and only Dismiss, on an ended loop', async () => {
    // An ended loop is persisted and its strip covers the pane's top line;
    // without Dismiss it had no controls at all and could never be cleared.
    api.readGoalLoops.mockResolvedValueOnce({ s1: loop({ phase: 'ended', endReason: 'done', completionSummary: 'All migrated.' }) })
    render(<GoalLoopPane sessionId="s1" />)
    ;(await screen.findByText('Dismiss')).click()
    expect(api.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 's1', action: 'dismiss', value: undefined })
    expect(screen.queryByText('Stop')).toBeNull()
    expect(screen.queryByText('Pause')).toBeNull()
  })
  it('clamps Raise cap to the ceiling main accepts and hides it once there', async () => {
    // 190 + 25 exceeded the IPC schema maximum, so main rejected the request
    // and the button did nothing.
    api.readGoalLoops.mockResolvedValueOnce({ s1: loop({ phase: 'paused', pauseReason: 'cap', maxContinuations: 190, continuationsDelivered: 190 }) })
    const first = render(<GoalLoopPane sessionId="s1" />)
    ;(await screen.findByText('Raise Cap')).click()
    expect(api.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 's1', action: 'raise-cap', value: 200 })
    first.unmount()
    api.readGoalLoops.mockResolvedValueOnce({ s1: loop({ phase: 'paused', pauseReason: 'cap', maxContinuations: 200, continuationsDelivered: 200 }) })
    render(<GoalLoopPane sessionId="s1" />)
    await screen.findByText('Resume')
    expect(screen.queryByText('Raise Cap')).toBeNull()
  })
  it('closes the latched overlay from inside it', async () => {
    toggleGoalLoop()
    render(<GoalLoopPane sessionId="s1" />)
    await screen.findByRole('dialog')
    screen.getByText('Close').click()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('GoalLoopPane interaction ownership (#1004)', () => {
  // The strip is passive status chrome, not a blocking surface. The keyboard
  // router bails on every chord while ANY element claims app interaction
  // ownership (hasAppInteractionOwner is a document-wide existence query), so
  // a strip carrying the marker kills reader mode, Spotlight, the palette,
  // type-to-focus and dictation for the whole app — and ended loops persist,
  // so it stayed dead across restarts. Only the latched overlay, a genuine
  // full-screen takeover like TldrOverlay, may claim ownership.
  it('a mounted strip does not claim app interaction ownership', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    expect(await screen.findAllByText(/iteration 3\/25/)).not.toHaveLength(0)
    expect(hasAppInteractionOwner()).toBe(false)
  })
  it('the latched overlay still claims ownership while visible', async () => {
    toggleGoalLoop()
    render(<GoalLoopPane sessionId="s1" />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(hasAppInteractionOwner()).toBe(true)
  })
})
