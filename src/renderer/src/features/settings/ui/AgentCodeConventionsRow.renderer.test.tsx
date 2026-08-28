import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeConventionsSnapshot } from '@shared/types/agentCodeConventions.js'
import { announceAgentCodeManagedSkillsChange } from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import { AgentCodeConventionsRow } from './AgentCodeConventionsRow'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function disabledSnapshot(): AgentCodeConventionsSnapshot {
  return {
    revision: 0,
    enabled: false,
    markdown: '',
    updatedAt: null,
    health: 'disabled',
    warnings: [],
    unsupportedProviders: [],
    targets: [
      {
        id: 'agents-standard-personal-skills',
        providers: ['codex', 'opencode'],
        displayPath: '~/.agents/skills/agent-code-conventions',
        state: 'not-installed',
      },
    ],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentCodeConventionsRow', () => {
  it('loads main-owned health and opens the editor instead of inventing renderer state', async () => {
    const audit = vi.fn().mockResolvedValue(disabledSnapshot())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeConventions: audit },
    })

    render(<AgentCodeConventionsRow />)
    expect(await screen.findByText('Status: Disabled')).toBeTruthy()
    expect(audit).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Edit conventions…' }))
    expect(await screen.findByRole('dialog', { name: 'Agent Code Conventions' })).toBeTruthy()
    expect(screen.getByText(/Global CLI skills may apply outside Agent Code/)).toBeTruthy()
  })

  it('enables a previously saved body directly through typed IPC', async () => {
    const current = { ...disabledSnapshot(), markdown: '# Rules' }
    const active: AgentCodeConventionsSnapshot = {
      ...current,
      revision: 1,
      enabled: true,
      health: 'active',
      targets: current.targets.map(target => ({ ...target, state: 'installed' })),
    }
    const save = vi.fn().mockResolvedValue({ ok: true, snapshot: active })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeConventions: vi.fn().mockResolvedValue(current),
        saveAgentCodeConventions: save,
      },
    })

    render(<AgentCodeConventionsRow />)
    await screen.findByText('Status: Disabled')
    fireEvent.click(screen.getByRole('button', { name: /Off/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      expectedRevision: 0,
      enabled: true,
      markdown: '# Rules',
    }))
    expect(await screen.findByText('Status: Active')).toBeTruthy()
  })

  it('refreshes its shared revision after a Custom Skills mutation', async () => {
    const initial = { ...disabledSnapshot(), markdown: '# Rules' }
    const refreshed = { ...initial, revision: 1 }
    const active = { ...refreshed, revision: 2, enabled: true, health: 'active' as const }
    const audit = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed)
    const save = vi.fn().mockResolvedValue({ ok: true, snapshot: active })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeConventions: audit, saveAgentCodeConventions: save },
    })
    render(<AgentCodeConventionsRow />)
    await screen.findByText('Status: Disabled')
    act(() => announceAgentCodeManagedSkillsChange({ source: 'custom-skills', revision: 1 }))
    await waitFor(() => expect(audit).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: /Off/ }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
    })))
  })
})
