import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop'
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
})
