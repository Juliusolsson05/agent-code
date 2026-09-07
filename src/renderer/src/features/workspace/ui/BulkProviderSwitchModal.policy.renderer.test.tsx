import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'
import type { UsageLimitScope, UsageProviderKind, UsageSnapshot } from '@shared/types/usage'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'

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

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

function exhaustedSnapshot(
  provider: UsageProviderKind,
  scope: UsageLimitScope = 'all-models',
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
          label: provider === 'codex' ? 'Codex 5h' : 'Current week (Opus)',
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
        focusedSessionId: 'agent',
        root: { type: 'leaf', sessionId: 'agent' },
      }],
      sessions: { agent: { cwd: '/projects/agent-code', kind: 'codex' } },
      detachedSessions: {},
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
      sessions: { agent: { cwd: '/projects/agent-code', kind: 'claude' } },
    },
  } as unknown as Workspace
}

afterEach(() => {
  usage.snapshot = null
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
})
