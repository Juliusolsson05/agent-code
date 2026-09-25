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

describe('GoalLoopPane control focus (ledger G-41)', () => {
  // Pause becomes Resume only once MAIN reports the new phase, and that swap
  // unmounted the focused button, so focus fell to <body>. The phase change
  // is driven here the way production drives it: the change ping, then a
  // re-read.
  // Restore the default read even when a test fails midway, so one failure
  // cannot leave the next test starting on a paused loop.
  afterEach(() => {
    api.readGoalLoops.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, loop()])))
  })
  const pingThenRead = async (next: GoalLoopState) => {
    api.readGoalLoops.mockResolvedValue({ s1: next })
    const listener = api.onGoalLoopChanged.mock.calls.at(-1)![0]
    listener()
  }

  it('hands focus from the overlay\'s Pause to its Resume when main reports paused', async () => {
    toggleGoalLoop()
    render(<GoalLoopPane sessionId="s1" />)
    // The overlay first shows "No goal loop" until the read resolves, and the
    // loop's overlay is a different node, so query afresh each time.
    const inOverlay = (name: string) => screen.queryAllByRole('button', { name }).find(el => el.closest('[data-goal-loop-overlay]'))
    await waitFor(() => expect(inOverlay('Pause')).toBeTruthy())
    const pause = inOverlay('Pause')!
    pause.focus()
    // Main answers a Pause with the paused state (GoalLoopService.control).
    api.controlGoalLoop.mockResolvedValueOnce(loop({ phase: 'paused', pauseReason: 'user' }))
    pause.click()
    await pingThenRead(loop({ phase: 'paused', pauseReason: 'user' }))
    await waitFor(() => expect(inOverlay('Resume')).toBeTruthy())
    expect(document.activeElement).toBe(inOverlay('Resume'))
    // One press carries once. Focus later falls to <body>, and the next
    // unrelated phase change must not carry it again.
    ;(document.activeElement as HTMLElement).blur()
    await pingThenRead(loop({ phase: 'active' }))
    await waitFor(() => expect(inOverlay('Pause')).toBeTruthy())
    expect(document.activeElement).toBe(document.body)
  })

  it('disarms the carry when main rejects, so a much later pause cannot take focus (round-2 review A-P2)', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    const pause = await screen.findByRole('button', { name: 'Pause' })
    pause.focus()
    api.controlGoalLoop.mockRejectedValueOnce(new Error('main refused'))
    pause.click()
    await waitFor(() => expect(api.controlGoalLoop).toHaveBeenCalled())
    await Promise.resolve()
    // The user moves on, and focus later falls to <body> (their pane closed).
    const elsewhere = document.createElement('textarea')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    elsewhere.remove()
    expect(document.activeElement).toBe(document.body)
    // Much later the loop pauses itself at its cap: an unrelated phase change.
    await pingThenRead(loop({ phase: 'paused', pauseReason: 'cap' }))
    await screen.findByRole('button', { name: 'Resume' })
    expect(document.activeElement).toBe(document.body)
  })

  it('disarms the carry when main answers without a phase change (Raise Cap)', async () => {
    api.readGoalLoops.mockResolvedValue({ s1: loop({ phase: 'paused', pauseReason: 'cap', maxContinuations: 25, continuationsDelivered: 25 }) })
    render(<GoalLoopPane sessionId="s1" />)
    const raise = await screen.findByRole('button', { name: 'Raise Cap' })
    raise.focus()
    api.controlGoalLoop.mockResolvedValueOnce(loop({ phase: 'paused', pauseReason: 'cap', maxContinuations: 50, continuationsDelivered: 25 }))
    raise.click()
    await waitFor(() => expect(api.controlGoalLoop).toHaveBeenCalled())
    await Promise.resolve()
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    // Later, the user's resume from another surface flips the phase.
    await pingThenRead(loop({ phase: 'active' }))
    await screen.findByRole('button', { name: 'Pause' })
    expect(document.activeElement).toBe(document.body)
  })

  it('does not take focus back if the user moved on before main answered', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    const pause = await screen.findByRole('button', { name: 'Pause' })
    pause.focus()
    api.controlGoalLoop.mockResolvedValueOnce(loop({ phase: 'paused', pauseReason: 'user' }))
    pause.click()
    const elsewhere = document.createElement('textarea')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    await pingThenRead(loop({ phase: 'paused', pauseReason: 'user' }))
    await screen.findByRole('button', { name: 'Resume' })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
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
