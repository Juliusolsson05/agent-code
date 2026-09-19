import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivityRange, AgentActivitySummary } from '@shared/agentActivity/summaryTypes'

import { AgentAnalyticsModal } from './AgentAnalyticsModal'

// The Agent Analytics window (#964) paints main's summary; it never re-derives
// it. These tests pin what the founder must be able to read off it: both hour
// figures, the agents behind each project, and that a range change asks main for
// that range rather than reusing the previous answer.

const HOUR = 3_600_000
const MINUTE = 60_000

function summary(range: AgentActivityRange, overrides: Partial<AgentActivitySummary> = {}): AgentActivitySummary {
  return {
    range,
    from: Date.parse('2026-09-05T00:00:00Z'),
    to: Date.parse('2026-09-12T00:00:00Z'),
    recordingSince: Date.parse('2026-09-01T09:00:00Z'),
    totals: { agentMs: 9 * HOUR + 30 * MINUTE, wallMs: 5 * HOUR + 15 * MINUTE, agents: { user: 3, orchestration: 2 } },
    projects: [
      {
        projectKey: 'agent-code',
        title: 'agent-code',
        open: true,
        agentMs: 7 * HOUR,
        wallMs: 4 * HOUR,
        agents: { user: 2, orchestration: 2 },
        repositories: [
          {
            repoRoot: '/Users/me/dev/agent-code',
            label: 'agent-code',
            agentMs: 6 * HOUR,
            wallMs: 4 * HOUR,
            agents: { user: 2, orchestration: 1 },
            worktrees: [
              { cwd: '/Users/me/dev/agent-code', label: 'agent-code', agentMs: 4 * HOUR, agents: { user: 1, orchestration: 0 } },
              { cwd: '/Users/me/dev/agent-code/.worktrees/analytics', label: 'analytics', agentMs: 2 * HOUR, agents: { user: 1, orchestration: 1 } },
            ],
          },
          {
            repoRoot: '/Users/me/dev/claude-code-headless',
            label: 'claude-code-headless',
            agentMs: HOUR,
            wallMs: HOUR,
            agents: { user: 0, orchestration: 1 },
            worktrees: [
              { cwd: '/Users/me/dev/claude-code-headless', label: 'claude-code-headless', agentMs: HOUR, agents: { user: 0, orchestration: 1 } },
            ],
          },
        ],
        topAgents: [
          { agentKey: 'name-1', label: 'Sleep counter fix', role: 'user', provider: 'claude', agentMs: 3 * HOUR + 45 * MINUTE },
          { agentKey: 'name-2', label: 'Reviewer', role: 'orchestration', provider: 'codex', agentMs: 2 * HOUR },
        ],
      },
      {
        projectKey: 'bringdown',
        title: 'bringdown',
        open: false,
        agentMs: 2 * HOUR + 30 * MINUTE,
        wallMs: HOUR + 15 * MINUTE,
        agents: { user: 1, orchestration: 0 },
        repositories: [
          {
            repoRoot: '/Users/me/dev/bringdown',
            label: 'bringdown',
            agentMs: 2 * HOUR + 30 * MINUTE,
            wallMs: HOUR + 15 * MINUTE,
            agents: { user: 1, orchestration: 0 },
            worktrees: [
              { cwd: '/Users/me/dev/bringdown', label: 'bringdown', agentMs: 2 * HOUR + 30 * MINUTE, agents: { user: 1, orchestration: 0 } },
            ],
          },
        ],
        topAgents: [
          { agentKey: 'name-3', label: 'Landing page copy', role: 'user', provider: 'opencode', agentMs: 2 * HOUR + 30 * MINUTE },
        ],
      },
    ],
    days: [
      { date: '2026-09-09', agentMs: 2 * HOUR, wallMs: HOUR },
      { date: '2026-09-10', agentMs: 4 * HOUR, wallMs: 2 * HOUR },
      { date: '2026-09-11', agentMs: 3 * HOUR + 30 * MINUTE, wallMs: 2 * HOUR + 15 * MINUTE },
    ],
    ...overrides,
  }
}

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function installApi(impl: (range: AgentActivityRange) => Promise<AgentActivitySummary>) {
  const getAgentActivitySummary = vi.fn(impl)
  Object.defineProperty(window, 'api', { configurable: true, value: { getAgentActivitySummary } })
  return getAgentActivitySummary
}

afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentAnalyticsModal', () => {
  it('shows agent-hours, wall-clock hours and agent counts in total and per project, with the agents behind each project', async () => {
    const api = installApi(async range => summary(range))
    render(<AgentAnalyticsModal open onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('9h 30m')).toBeTruthy())
    expect(api).toHaveBeenCalledWith('7d')
    // Totals: both hour figures and the user/orchestration split.
    expect(screen.getByText('5h 15m')).toBeTruthy()
    expect(screen.getByText('3 yours · 2 orchestration')).toBeTruthy()
    expect(screen.getByText(/Recording since/)).toBeTruthy()

    // Each project lists what its time went to.
    const agentCode = screen.getByRole('region', { name: 'Project agent-code' })
    expect(within(agentCode).getByText('7h')).toBeTruthy()
    expect(within(agentCode).getByText('4h')).toBeTruthy()
    const agents = within(agentCode).getByRole('list', { name: 'Agents in agent-code' })
    expect(within(agents).getByText('Sleep counter fix')).toBeTruthy()
    expect(within(agents).getByText('Reviewer')).toBeTruthy()
    expect(within(agents).getByText('codex · orchestration')).toBeTruthy()

    const bringdown = screen.getByRole('region', { name: 'Project bringdown' })
    expect(within(bringdown).getByText('closed')).toBeTruthy()
    expect(within(bringdown).getByText('Landing page copy')).toBeTruthy()
  })

  it('expands a project into its repositories and worktrees', async () => {
    installApi(async range => summary(range))
    render(<AgentAnalyticsModal open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('region', { name: 'Project agent-code' })).toBeTruthy())

    const agentCode = screen.getByRole('region', { name: 'Project agent-code' })
    expect(within(agentCode).queryByText('analytics')).toBeNull()
    fireEvent.click(within(agentCode).getByRole('button', { expanded: false }))

    // The second repository appears as a repository row AND as its own sole
    // worktree (same path), and the extra worktree inside the first repository
    // appears too.
    expect(within(agentCode).getAllByTitle('/Users/me/dev/claude-code-headless')).toHaveLength(2)
    expect(within(agentCode).getByTitle('/Users/me/dev/agent-code/.worktrees/analytics')).toBeTruthy()
    expect(within(agentCode).getByText('analytics')).toBeTruthy()
  })

  it('asks main for the chosen range instead of reusing the previous answer', async () => {
    const api = installApi(async range => summary(range, range === '30d'
      ? { totals: { agentMs: 40 * HOUR, wallMs: 20 * HOUR, agents: { user: 6, orchestration: 4 } } }
      : {}))
    render(<AgentAnalyticsModal open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('9h 30m')).toBeTruthy())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '30 days' }))
    })

    await waitFor(() => expect(screen.getByText('40h')).toBeTruthy())
    expect(api).toHaveBeenLastCalledWith('30d')
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('says nothing was recorded instead of showing empty totals when the range has no working time', async () => {
    installApi(async range => summary(range, {
      totals: { agentMs: 0, wallMs: 0, agents: { user: 0, orchestration: 0 } },
      projects: [],
      days: [],
    }))
    render(<AgentAnalyticsModal open onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('No agent working time recorded in this range.')).toBeTruthy())
    expect(screen.queryByText('Agent-hours')).toBeNull()
  })
})
