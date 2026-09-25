import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { uniformBuiltInMcpDefaults } from '@mcp/shared/types'
import { useAppStore } from '@renderer/app-state/store'
import { useUserMcpStore } from '@renderer/features/mcp/store'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { UserMcpServerView, UserMcpSnapshot } from '@shared/userMcp/types'

import { AgentMcpServersModal } from './AgentMcpServersModal'

// These pin the provider policy the retired per-capability commands used to
// carry (#1143): the picker is now the only per-agent surface, so it is where
// "Workflows is not offered to Claude" and "one change is one pinned reload"
// must hold.

const originalApp = useAppStore.getState()
const originalMcp = useUserMcpStore.getState()

const beeper: UserMcpServerView = {
  id: 'srv-beeper',
  name: 'beeper',
  enabled: true,
  providers: { claude: false, codex: true },
  entry: { type: 'http', url: 'http://localhost:23373/v0/mcp' },
  inputs: [],
  transport: 'http',
  summary: 'localhost:23373/v0/mcp',
  secrets: {},
  problems: [],
  support: { claude: { ok: true }, codex: { ok: true } },
}

function snapshot(servers: UserMcpServerView[]): UserMcpSnapshot {
  return { servers, native: [], claudeManagedPolicy: false }
}

function mount(kind: 'claude' | 'codex' | 'opencode', meta: Record<string, unknown> = {}) {
  const replaceSession = vi.fn().mockResolvedValue('agent-2')
  const workspace = {
    state: {
      activeTabId: 'tab',
      stage: oneLaneStage('agent'),
      pinnedSessionIds: [],
      tabs: [{ id: 'tab' }],
      sessions: {
        agent: {
          cwd: '/projects/mcp',
          kind,
          providerSessionId: 'provider-session',
          projectId: 'tab',
          joinedAt: 0,
          builtInMcpDomains: ['tldr'],
          builtInMcpOverrides: {},
          ...meta,
        },
      },
    },
    replaceSession,
    showPaneToast: vi.fn(),
  } as unknown as Workspace
  render(
    <WorkspaceProvider workspace={workspace}>
      <AgentMcpServersModal />
    </WorkspaceProvider>,
  )
  return { replaceSession }
}

beforeEach(() => {
  useAppStore.setState({
    agentMcpServersSessionId: 'agent',
    settings: { ...originalApp.settings, defaultBuiltInMcpDomains: uniformBuiltInMcpDefaults(['tldr']) },
  })
  useUserMcpStore.setState({ snapshot: snapshot([beeper]) })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalApp, true)
  useUserMcpStore.setState(originalMcp, true)
})

describe('Agent MCP Servers picker', () => {
  it('offers Workflows to Codex and OpenCode but not Claude, which has workflows natively', () => {
    mount('claude')
    expect(screen.queryByRole('checkbox', { name: 'Workflows for this agent' })).toBeNull()
    cleanup()
    mount('codex')
    expect(screen.getByRole('checkbox', { name: 'Workflows for this agent' })).toBeTruthy()
    cleanup()
    mount('opencode')
    expect(screen.getByRole('checkbox', { name: 'Workflows for this agent' })).toBeTruthy()
  })

  it('offers Agent Management to every provider launcher', () => {
    for (const kind of ['claude', 'codex', 'opencode'] as const) {
      mount(kind)
      expect(screen.getByRole('checkbox', { name: 'Agent Management for this agent' })).toBeTruthy()
      cleanup()
    }
  })

  it('applies several staged changes as ONE reload pinned to the captured agent', () => {
    const { replaceSession } = mount('codex')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agent Management for this agent' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'TLDR for this agent' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'beeper for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))

    expect(replaceSession).toHaveBeenCalledTimes(1)
    expect(replaceSession).toHaveBeenCalledWith('/projects/mcp', {
      kind: 'codex',
      resumeSessionId: 'provider-session',
      targetSessionId: 'agent',
      builtInMcpOverrides: {
        agent_management: true,
        tldr: false,
        // The user server rides the same override map under its namespaced key.
        'user:srv-beeper': false,
      },
    })
    expect(useAppStore.getState().agentMcpServersSessionId).toBeNull()
  })

  it('never reloads the agent from a dialog-level Enter, and shows no Enter chip on the reload (plan S30)', () => {
    // The confirm restarts the agent's process; a reflexive Enter after
    // ticking a box must not cut a running turn off.
    const { replaceSession } = mount('codex')
    fireEvent.click(screen.getByRole('checkbox', { name: 'TLDR for this agent' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(replaceSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Apply & Reload Agent' }).querySelector('[data-slot="kbd"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })

  it('drops a choice that matches Settings so the agent keeps following Settings', () => {
    const { replaceSession } = mount('codex', { builtInMcpOverrides: { tldr: false } })
    // TLDR is on in Settings; turning it back on removes the explicit "off".
    fireEvent.click(screen.getByRole('checkbox', { name: 'TLDR for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))
    expect(replaceSession.mock.calls[0]![1].builtInMcpOverrides).toEqual({})
  })

  it('routes a Root Management grant through its confirmation, carrying the other staged choices', () => {
    const { replaceSession } = mount('claude')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agent Management for this agent' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Root Management for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))

    expect(replaceSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().rootManagementPromptSessionId).toBe('agent')
    expect(useAppStore.getState().rootManagementPromptOverrides).toEqual({ agent_management: true })
  })

  it('ends a running goal loop before a reload that removes its tools (#1045 review)', async () => {
    const controlGoalLoop = vi.fn(async () => null)
    Object.assign(window, { api: { ...window.api, controlGoalLoop } })
    const { replaceSession } = mount('codex', { builtInMcpDomains: ['goal_loop'], builtInMcpOverrides: { goal_loop: true } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Goal Loop for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))
    await waitFor(() => expect(replaceSession).toHaveBeenCalledTimes(1))
    // Named by the session the loop is filed under, and before the reload.
    expect(controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'agent', action: 'stop' })
    expect(controlGoalLoop.mock.invocationCallOrder[0]).toBeLessThan(replaceSession.mock.invocationCallOrder[0]!)
  })

  it('does not stop a goal loop before a Root grant is confirmed (review round 1)', () => {
    // Cancelling the confirmation reloads nothing, so a loop stopped up front
    // would be dead while the agent still has its tools. The stop is handed
    // to the confirmation, which runs it only on the reload it performs.
    const controlGoalLoop = vi.fn(async () => null)
    Object.assign(window, { api: { ...window.api, controlGoalLoop } })
    mount('codex', { builtInMcpDomains: ['goal_loop'], builtInMcpOverrides: { goal_loop: true } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Goal Loop for this agent' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Root Management for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))
    expect(controlGoalLoop).not.toHaveBeenCalled()
    expect(useAppStore.getState().rootManagementPromptStopGoalLoop).toBe(true)
  })

  it('leaves a running goal loop alone when its tools stay on', () => {
    const controlGoalLoop = vi.fn(async () => null)
    Object.assign(window, { api: { ...window.api, controlGoalLoop } })
    mount('codex', { builtInMcpDomains: ['goal_loop', 'tldr'], builtInMcpOverrides: { goal_loop: true } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'TLDR for this agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply & Reload Agent' }))
    expect(controlGoalLoop).not.toHaveBeenCalled()
  })

  it('shows user servers as unavailable on providers that cannot receive them yet', () => {
    mount('opencode')
    const box = screen.getByRole('checkbox', { name: 'beeper for this agent' })
    expect(box).toHaveProperty('disabled', true)
    expect(screen.getByText('not supported yet')).toBeTruthy()
  })

  it('keeps a master-switched-off server off for this agent too', () => {
    useUserMcpStore.setState({ snapshot: snapshot([{ ...beeper, enabled: false }]) })
    mount('codex')
    expect(screen.getByRole('checkbox', { name: 'beeper for this agent' })).toHaveProperty('disabled', true)
    expect(screen.getByText('off in Settings → MCP')).toBeTruthy()
  })
})
