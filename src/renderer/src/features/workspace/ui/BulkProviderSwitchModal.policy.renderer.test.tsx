import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'
import type { UsageLimitScope, UsageProviderKind, UsageSnapshot } from '@shared/types/usage'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'
import { useProviderEnablementStore } from '@renderer/features/providers/store'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'

// The bulk modal derives its directions from the shared enablement store;
// without a reset, an earlier test file in this worker could leave a
// restricted snapshot and empty every direction (fail-open = all kinds).
beforeEach(() => {
  useProviderEnablementStore.setState({ snapshot: null, enabledKinds: new Set(AGENT_PROVIDER_KINDS) })
})

// The modal's policy surface, driven by a real-shaped usage snapshot.
//
// WHY the usage hook is mocked rather than the IPC under it: the hook polls
// `window.api.getUsageSnapshot` on an interval and re-polls on visibility
// change. Faking the transport would make every assertion here wait on that
// machinery for no gain — what is under test is the DERIVATION from a snapshot
// to modal defaults, and the snapshot shape is owned (and tested) by
// `src/shared/usage`.
//
// The payloads below are the normalized `UsageSnapshot` shape, not provider
// wire bodies: normalization is what classifies a window as `all-models` vs
// `model-family`, and re-deriving that here would be testing the wrong seam.
const usage = vi.hoisted(() => ({ snapshot: null as UsageSnapshot | null }))

vi.mock('@renderer/features/usage/hooks/useUsageHeaderSnapshot', () => ({
  useUsageHeaderSnapshot: () => ({ stale: false, snapshot: usage.snapshot }),
}))

// The stop summaries are the only report a stopped run gives, so the tests
// read the toast itself.
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('@renderer/ui/GlobalToastContext', () => ({ useGlobalToast: () => ({ showToast }) }))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

function exhaustedSnapshot(
  provider: UsageProviderKind,
  scope: UsageLimitScope = 'all-models',
  labelOverride?: string,
): UsageSnapshot {
  const others: UsageProviderKind[] = provider === 'codex' ? ['claude'] : ['codex']
  return {
    fetchedAt: new Date().toISOString(),
    cache: { hit: false, ttlMs: 30_000 },
    providers: [
      {
        provider,
        status: 'ok',
        sourceLabel: 'keychain',
        plan: 'max',
        spend: null,
        extraUsage: null,
        credits: null,
        rows: [{
          id: `${provider}-primary-window`,
          label: labelOverride ?? (provider === 'codex' ? 'Codex 5h' : 'Current week (Opus)'),
          percent: 100,
          severity: 'critical',
          // Two hours out, computed from now: the banner renders a countdown,
          // so a frozen literal would read "resets soon" forever and stop
          // proving that the reset time reaches the banner at all.
          resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          active: true,
          detail: null,
          scope,
        }],
      },
      ...others.map(other => ({
        provider: other,
        status: 'ok' as const,
        sourceLabel: 'keychain',
        plan: 'pro',
        spend: null,
        extraUsage: null,
        credits: null,
        rows: [],
      })),
    ],
  }
}

/** Both providers readable and neither full — the state in which the modal's
 *  own defaults, not the exhaustion signal, decide everything. */
function healthySnapshot(): UsageSnapshot {
  const snapshot = exhaustedSnapshot('codex')
  return {
    ...snapshot,
    providers: snapshot.providers.map(provider => (
      provider.status === 'ok'
        ? { ...provider, rows: provider.rows.map(row => ({ ...row, percent: 40, severity: 'normal' as const })) }
        : provider
    )),
  }
}

function workspaceFixture(entries: Entry[] = []): Workspace {
  return {
    state: {
      activeTabId: 'project-tab',
      tabs: [{
        id: 'project-tab',
        title: 'Project tab',
      }],
      sessions: { agent: { cwd: '/projects/agent-code', kind: 'codex', projectId: 'project-tab', joinedAt: 0 } },
      pinnedSessionIds: [],
      stage: { lanes: [{ selectedSessionId: 'agent' }], rows: [{ length: 1 }], focusedLane: 0 },
      lastProviderSwitchBatch: null,
    },
    runtimes: { agent: { ...emptyRuntime(), entries } },
    focusSessionInTab: vi.fn(),
    closeSession: vi.fn(),
    switchAgentsToProvider: vi.fn().mockResolvedValue(undefined),
    returnLastProviderSwitchBatch: vi.fn(),
  } as unknown as Workspace
}

function claudeWorkspaceFixture(): Workspace {
  const base = workspaceFixture()
  return {
    ...base,
    state: {
      ...base.state,
      // Spread the row, change only its kind: membership is ON the row (#992),
      // so a bare literal here un-files the agent and the modal lists nobody.
      sessions: { agent: { ...base.state.sessions.agent!, kind: 'claude' } },
    },
  } as unknown as Workspace
}

afterEach(() => {
  usage.snapshot = null
  showToast.mockReset()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

describe('BulkProviderSwitchModal policy', () => {
  it('banners the exhausted provider and refuses to spend its quota', () => {
    usage.snapshot = exhaustedSnapshot('codex')
    render(<BulkProviderSwitchModal open workspace={workspaceFixture()} onClose={() => {}} />)

    expect(screen.getByText(/Codex.*100.*resets/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue(/Codex → Claude/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/Compact on source first/i) as HTMLInputElement).disabled)
      .toBe(true)
  })

  it('points the direction at the exhausted provider instead of the static default', () => {
    // Claude exhausted must flip the direction AWAY from the historical
    // codex->claude default. Without this the whole exhaustion read is
    // unobservable: codex->claude is what the modal shows anyway.
    usage.snapshot = exhaustedSnapshot('claude')
    render(<BulkProviderSwitchModal open workspace={claudeWorkspaceFixture()} onClose={() => {}} />)

    expect(screen.getByDisplayValue(/Claude → Codex/i)).toBeInTheDocument()
    // Claude is now the SOURCE and it is the exhausted one, so the box that
    // would spend its quota is refused.
    expect((screen.getByLabelText(/Compact on source first/i) as HTMLInputElement).disabled)
      .toBe(true)
    // Arrival compaction is a Claude-target affordance; this batch lands on Codex.
    expect(screen.queryByLabelText(/Compact on arrival/i)).not.toBeInTheDocument()

    // Overriding the direction must move both derived states with it —
    // otherwise the disable is a static property of the modal rather than of
    // whichever provider the user is currently spending.
    fireEvent.change(screen.getByDisplayValue(/Claude → Codex/i), { target: { value: 'codex:claude' } })
    expect((screen.getByLabelText(/Compact on source first/i) as HTMLInputElement).disabled)
      .toBe(false)
    expect(screen.getByLabelText(/Compact on arrival/i)).toBeInTheDocument()
  })

  it('offers a model switch instead of a provider switch for a family-scoped limit', async () => {
    usage.snapshot = exhaustedSnapshot('claude', 'model-family')
    const deliverPrompt = vi.fn().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'api', { configurable: true, value: { deliverPrompt } })

    render(<BulkProviderSwitchModal open workspace={claudeWorkspaceFixture()} onClose={() => {}} />)

    const button = screen.getByRole('button', { name: /Switch 1 agent to another Claude model/i })
    fireEvent.click(button)
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledWith('agent', '/model sonnet'))
  })

  it('withholds the model switch when the exhausted family is the one it would switch to', () => {
    // `/model sonnet` cannot rescue a full Sonnet week. Offering it anyway
    // would send a batch of agents at the wall they are already standing at,
    // and the row's whole claim is that it is the CHEAP remedy.
    usage.snapshot = exhaustedSnapshot('claude', 'model-family', 'Current week (Sonnet)')
    render(<BulkProviderSwitchModal open workspace={claudeWorkspaceFixture()} onClose={() => {}} />)

    expect(screen.queryByRole('button', { name: /to another Claude model/i })).not.toBeInTheDocument()
    expect(screen.getByText(/A model switch would not help/i)).toBeInTheDocument()
  })

  it('turns arrival compaction on for a large Claude-bound conversation', () => {
    usage.snapshot = exhaustedSnapshot('codex')
    // One oversized entry: the default is about the conversation the target has
    // to swallow, and 150,000 characters is the spec's line.
    const big = [{ type: 'assistant', uuid: 'big', text: 'x'.repeat(200_000) }] as unknown as Entry[]
    render(<BulkProviderSwitchModal open workspace={workspaceFixture(big)} onClose={() => {}} />)

    expect((screen.getByLabelText(/Compact on arrival/i) as HTMLInputElement).checked).toBe(true)
  })

  it('leaves arrival compaction off for a small conversation and asks once before spending the source', () => {
    // Nothing exhausted: the opt-in source path is only reachable when the
    // source CAN answer, which is exactly the case this covers.
    usage.snapshot = healthySnapshot()
    const workspace = workspaceFixture()
    render(<BulkProviderSwitchModal open workspace={workspace} onClose={() => {}} />)

    expect((screen.getByLabelText(/Compact on arrival/i) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByLabelText(/Compact on source first/i))
    fireEvent.click(screen.getByRole('button', { name: /Switch 1 agent to Claude/i }))

    // First click is the confirmation, not the operation: compacting a live
    // source rewrites real history on the user's quota.
    expect(screen.getByText(/rewrites their live history/i)).toBeInTheDocument()
    expect(workspace.switchAgentsToProvider).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Compact 1 agent on Codex and switch/i }))
    expect(workspace.switchAgentsToProvider).toHaveBeenCalledWith(
      ['agent'],
      'claude',
      { allowSourceTurns: true, compactOnArrival: false, sourceCompactionConfirmed: true },
      { shouldStop: expect.any(Function) },
    )
  })

  it('counts a limit-stopped agent as switchable rather than mid-turn', () => {
    usage.snapshot = exhaustedSnapshot('codex')
    const workspace = workspaceFixture()
    const parked = {
      ...emptyRuntime(),
      processActive: true,
      sessionStatus: 'running' as const,
      turnStartedAt: 1_000,
      limitHit: { at: 2_000, source: 'api_error' as const },
    }
    const withParkedAgent = {
      ...workspace,
      runtimes: { agent: parked },
    } as unknown as Workspace
    render(<BulkProviderSwitchModal open workspace={withParkedAgent} onClose={() => {}} />)

    expect(screen.queryByText(/are mid-turn and will be skipped/i)).not.toBeInTheDocument()
  })

  // #1271: a running batch locks every exit (single-flight), and with
  // compaction each agent can take five minutes. Cancel becomes the way out:
  // it stops the batch after the agent in flight.
  it('lets the user stop a running batch after the agent in flight', async () => {
    usage.snapshot = healthySnapshot()
    let seenStop: (() => boolean) | undefined
    let finish!: () => void
    const workspace = workspaceFixture()
    ;(workspace.switchAgentsToProvider as ReturnType<typeof vi.fn>).mockImplementation(
      (_ids: unknown, _target: unknown, _policy: unknown, control?: { shouldStop?: () => boolean }) => {
        seenStop = control?.shouldStop
        return new Promise<void>(resolve => { finish = resolve })
      },
    )
    render(<BulkProviderSwitchModal open workspace={workspace} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch 1 agent to Claude/i }))
    const stop = await screen.findByRole('button', { name: 'Stop after this agent' })
    expect(stop).not.toBeDisabled()
    expect(seenStop?.()).toBe(false)
    fireEvent.click(stop)
    expect(seenStop?.()).toBe(true)
    expect(screen.getByRole('button', { name: 'Stopping after this agent…' })).toBeDisabled()
    finish()
  })

  // #1271 / steering q32: the /model fan-out holds the same lock, so it needs
  // the same way out.
  it('lets the user stop a /model fan-out after the agent in flight', async () => {
    usage.snapshot = exhaustedSnapshot('claude', 'model-family')
    let finishFirst!: (value: { ok: true }) => void
    const deliverPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'api', { configurable: true, value: { deliverPrompt } })
    const base = claudeWorkspaceFixture()
    const agent = base.state.sessions.agent!
    const workspace = {
      ...base,
      state: {
        ...base.state,
        sessions: { agent, second: { ...agent, joinedAt: 1 } },
        stage: { lanes: [{ selectedSessionId: 'agent' }, { selectedSessionId: 'second' }], rows: [{ length: 2 }], focusedLane: 0 },
      },
      runtimes: { ...base.runtimes, second: base.runtimes.agent },
    } as unknown as Workspace
    render(<BulkProviderSwitchModal open workspace={workspace} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch 2 agents to another Claude model/i }))
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this agent' }))
    finishFirst({ ok: true })
    await screen.findByRole('button', { name: 'Cancel' })
    expect(deliverPrompt).toHaveBeenCalledTimes(1)
  })

  // #1312 review B: the stop's other entry points and the idle Cancel.
  function runningBatch() {
    usage.snapshot = healthySnapshot()
    let seenStop: (() => boolean) | undefined
    const workspace = workspaceFixture()
    ;(workspace.switchAgentsToProvider as ReturnType<typeof vi.fn>).mockImplementation(
      (_ids: unknown, _target: unknown, _policy: unknown, control?: { shouldStop?: () => boolean }) => {
        seenStop = control?.shouldStop
        return new Promise<void>(() => {})
      },
    )
    const onClose = vi.fn()
    render(<BulkProviderSwitchModal open workspace={workspace} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Switch 1 agent to Claude/i }))
    return { onClose, stopRequested: () => seenStop?.() }
  }

  it('Escape during a running batch asks to stop, and keeps the modal open', async () => {
    const run = runningBatch()
    await screen.findByRole('button', { name: 'Stop after this agent' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(run.stopRequested()).toBe(true)
    expect(run.onClose).not.toHaveBeenCalled()
  })

  it('the stop button does not close the modal while the agent in flight finishes', async () => {
    const run = runningBatch()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop after this agent' }))
    expect(run.stopRequested()).toBe(true)
    expect(run.onClose).not.toHaveBeenCalled()
  })

  it('Cancel closes the modal when nothing is running', () => {
    usage.snapshot = healthySnapshot()
    const onClose = vi.fn()
    render(<BulkProviderSwitchModal open workspace={workspaceFixture()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  // #1312 round 2: the /model fan-out and Return, driven through the modal.
  function claudeAgents(count: number): Workspace {
    const base = claudeWorkspaceFixture()
    const agent = base.state.sessions.agent!
    const ids = Array.from({ length: count }, (_, i) => (i === 0 ? 'agent' : `agent-${i}`))
    return {
      ...base,
      state: {
        ...base.state,
        sessions: Object.fromEntries(ids.map((id, i) => [id, { ...agent, joinedAt: i }])),
        stage: { lanes: ids.map(id => ({ selectedSessionId: id })), rows: [{ length: count }], focusedLane: 0 },
      },
      runtimes: Object.fromEntries(ids.map(id => [id, base.runtimes.agent])),
    } as unknown as Workspace
  }

  function startModelFanOut(count: number, deliverPrompt: ReturnType<typeof vi.fn>) {
    usage.snapshot = exhaustedSnapshot('claude', 'model-family')
    Object.defineProperty(window, 'api', { configurable: true, value: { deliverPrompt } })
    render(<BulkProviderSwitchModal open workspace={claudeAgents(count)} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Switch ${count} agents to another Claude model`, 'i') }))
  }

  // Review A: a delivery that REJECTS after Stop used to count every agent
  // the loop never reached as failed. Only the one that rejected failed; the
  // rest were stopped.
  it('reports agents after a stop as not attempted even when the delivery in flight rejects', async () => {
    let rejectFirst!: (error: Error) => void
    const deliverPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject }))
      .mockResolvedValue({ ok: true })
    startModelFanOut(2, deliverPrompt)
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this agent' }))
    rejectFirst(new Error('IPC rejected'))
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(showToast).toHaveBeenLastCalledWith('Stopped: 1 agent not attempted. Sent /model sonnet to 0 agents (1 failed: IPC rejected)')
  })

  // Review B: a stop pressed during a LATER agent, its count and wording.
  it('stops a /model fan-out before the third agent when stop is pressed during the second', async () => {
    let finishSecond!: (value: { ok: true }) => void
    const deliverPrompt = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
      .mockResolvedValue({ ok: true })
    startModelFanOut(3, deliverPrompt)
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this agent' }))
    finishSecond({ ok: true })
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(deliverPrompt).toHaveBeenCalledTimes(2)
    expect(showToast).toHaveBeenLastCalledWith('Stopped: 1 agent not attempted. Sent /model sonnet to 2 agents')
  })

  // Review B: the /model run sets `switchingModel`, not `busy`; Escape must
  // still reach the stop.
  it('Escape during a /model fan-out asks to stop', async () => {
    let finishFirst!: (value: { ok: true }) => void
    const deliverPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue({ ok: true })
    startModelFanOut(2, deliverPrompt)
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    finishFirst({ ok: true })
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(deliverPrompt).toHaveBeenCalledTimes(1)
  })

  // Review B: a stopped run must not leave the stop armed for the next one.
  it('starts a fresh /model fan-out after a stopped one', async () => {
    let finishFirst!: (value: { ok: true }) => void
    const deliverPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue({ ok: true })
    startModelFanOut(2, deliverPrompt)
    await vi.waitFor(() => expect(deliverPrompt).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Stop after this agent' }))
    finishFirst({ ok: true })
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: /Switch 2 agents to another Claude model/i }))
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(2))
    expect(deliverPrompt).toHaveBeenCalledTimes(3)
  })

  // Review A/B: Return is started from the modal, so the modal is what must
  // hand it the stop, and reset it for the next Return.
  it('hands Return the stop, and a later Return starts with it cleared', async () => {
    usage.snapshot = healthySnapshot()
    const base = workspaceFixture()
    const workspace = {
      ...base,
      state: {
        ...base.state,
        lastProviderSwitchBatch: {
          id: 'batch-1', switchedAt: 0, sourceKind: 'claude', targetKind: 'codex', compactOnArrival: false,
          agents: [{ sessionId: 'agent', cwd: '/projects/agent-code', originalKind: 'claude', switchedToKind: 'codex' }],
        },
      },
    } as unknown as Workspace
    const controls: Array<{ shouldStop?: () => boolean } | undefined> = []
    let finish!: () => void
    ;(workspace.returnLastProviderSwitchBatch as ReturnType<typeof vi.fn>).mockImplementation(
      (control?: { shouldStop?: () => boolean }) => {
        controls.push(control)
        return new Promise<void>(resolve => { finish = resolve })
      },
    )
    render(<BulkProviderSwitchModal open workspace={workspace} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Return 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop after this agent' }))
    expect(controls[0]?.shouldStop?.()).toBe(true)
    finish()
    fireEvent.click(await screen.findByRole('button', { name: 'Return 1' }))
    await vi.waitFor(() => expect(controls).toHaveLength(2))
    expect(controls[1]?.shouldStop?.()).toBe(false)
    finish()
  })
})
