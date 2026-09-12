import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { UsageSnapshot } from '@shared/types/usage'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'

// The selected-scope path is where #908 lived: the checkbox list was built
// from working directories, so a worktree agent had its own checkbox and the
// tab's checkbox did not exist. This drives the real modal from the project
// checkbox to the preview; see the policy test for why the usage hook is
// mocked instead of the IPC beneath it.
const usage = vi.hoisted(() => ({ snapshot: null as UsageSnapshot | null }))

vi.mock('@renderer/features/usage/hooks/useUsageHeaderSnapshot', () => ({
  useUsageHeaderSnapshot: () => ({ stale: false, snapshot: usage.snapshot }),
}))

function healthySnapshot(): UsageSnapshot {
  const provider = (name: 'codex' | 'claude') => ({
    provider: name,
    status: 'ok' as const,
    sourceLabel: 'keychain',
    plan: 'pro',
    spend: null,
    extraUsage: null,
    credits: null,
    rows: [],
  })
  return {
    fetchedAt: new Date().toISOString(),
    cache: { hit: false, ttlMs: 30_000 },
    providers: [provider('codex'), provider('claude')],
  }
}

/** One agent-code tab whose agents span the main checkout and a worktree (one
 *  of them detached to Dispatch), plus an unrelated startup tab. */
function workspaceFixture(): Workspace {
  return {
    state: {
      activeTabId: 'tab-agent-code',
      dispatchMode: null,
      gridRelatedSelections: {},
      tabs: [
        { id: 'tab-agent-code', title: 'agent-code', focusedSessionId: 'audit', root: { type: 'leaf', sessionId: 'audit' } },
        { id: 'tab-startup', title: 'startup', focusedSessionId: 'pitch', root: { type: 'leaf', sessionId: 'pitch' } },
      ],
      sessions: {
        audit: { cwd: '/dev/agent-code', kind: 'codex' },
        grok: { cwd: '/dev/agent-code/.worktrees/grok-package-wiring', kind: 'codex' },
        pitch: { cwd: '/dev/startup', kind: 'codex' },
      },
      detachedSessions: {
        grok: { sessionId: 'grok', surface: 'dispatch', projectTabId: 'tab-agent-code', projectTabTitle: 'agent-code', projectTabIndex: 0, detachedAt: 1 },
      },
      buried: [],
      pinnedSessionIds: [],
      lastProviderSwitchBatch: null,
    },
    runtimes: { audit: emptyRuntime(), grok: emptyRuntime(), pitch: emptyRuntime() },
    focusSessionInTab: vi.fn(),
    closeSession: vi.fn(),
    switchAgentsToProvider: vi.fn().mockResolvedValue(undefined),
    returnLastProviderSwitchBatch: vi.fn(),
  } as unknown as Workspace
}

afterEach(() => {
  usage.snapshot = null
})

describe('BulkProviderSwitchModal project scope', () => {
  it('lists tabs the way Dispatch does and selects a worktree agent through its tab', () => {
    usage.snapshot = healthySnapshot()
    render(<BulkProviderSwitchModal open workspace={workspaceFixture()} onClose={() => {}} />)

    expect(screen.getByText('Will switch · 3 agents')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Selected projects' }))
    expect(screen.getByText(/No Codex agents match the current scope/i)).toBeInTheDocument()

    // Two project entries, named like the Dispatch index. The old behaviour
    // produced three, one of them "grok-package-wiring".
    expect(screen.getAllByText(/^[A-Z] · /).map(node => node.textContent)).toEqual(['A · agent-code', 'B · startup'])
    expect(screen.getByText('agent-code · grok-package-wiring')).toBeInTheDocument()

    const agentCodeProject = screen.getByText('A · agent-code').closest('label')
    if (!agentCodeProject) throw new Error('project entry is not a label')
    fireEvent.click(within(agentCodeProject).getByRole('checkbox'))

    // Ticking the tab brings both of its agents, including the detached
    // worktree one, into the preview; the startup agent stays out.
    expect(screen.getByText('Will switch · 2 agents')).toBeInTheDocument()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByText('A · agent-code · /dev/agent-code/.worktrees/grok-package-wiring')).toBeInTheDocument()
    expect(screen.queryByText('B · startup · /dev/startup')).not.toBeInTheDocument()
  })
})
