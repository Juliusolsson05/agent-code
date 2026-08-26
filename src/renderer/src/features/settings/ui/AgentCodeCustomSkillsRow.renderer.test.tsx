import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeCustomSkillsSnapshot } from '@shared/types/agentCodeCustomSkills.js'
import { AgentCodeCustomSkillsRow } from './AgentCodeCustomSkillsRow'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function emptySnapshot(): AgentCodeCustomSkillsSnapshot {
  return { revision: 0, skills: [], unsupportedProviders: [] }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentCodeCustomSkillsRow', () => {
  it('keeps external and project skills outside the main-owned manager', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(emptySnapshot()) },
    })
    render(<AgentCodeCustomSkillsRow />)

    expect(await screen.findByText('No Agent Code-authored skills')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    expect(await screen.findByRole('dialog', { name: 'Custom Skills' })).toBeTruthy()
    expect(screen.getByText(/External and project-local skills remain outside/)).toBeTruthy()
    expect(screen.getByText(/Installed and project-local skills are intentionally not imported/)).toBeTruthy()
  })

  it('creates a structured disabled draft through typed IPC', async () => {
    const saved: AgentCodeCustomSkillsSnapshot = {
      revision: 1,
      unsupportedProviders: [],
      skills: [{
        id: 'skill-1',
        name: 'review-code',
        description: 'Review code when asked',
        markdown: '# Review\n\nExplain why findings matter.',
        enabled: false,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        health: 'disabled',
        targets: [],
      }],
    }
    const create = vi.fn().mockResolvedValue({ ok: true, snapshot: saved })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(emptySnapshot()),
        createAgentCodeCustomSkill: create,
      },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('No Agent Code-authored skills')
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New skill…' }))
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'review-code' } })
    fireEvent.change(screen.getByLabelText('Skill description'), { target: { value: 'Review code when asked' } })
    fireEvent.change(screen.getByLabelText('Skill instructions'), { target: { value: '# Review\n\nExplain why findings matter.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      expectedRevision: 0,
      name: 'review-code',
      description: 'Review code when asked',
      markdown: '# Review\n\nExplain why findings matter.',
      enabled: false,
    }))
    expect(await screen.findByRole('dialog', { name: 'Edit review-code' })).toBeTruthy()
  })
})
