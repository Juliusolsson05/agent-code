import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSkillsSnapshot, InstalledAgentSkill } from '@shared/types/agentSkills'
import { announceAgentCodeManagedSkillsChange } from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import { AgentSkillsSection } from './AgentSkillsSection'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function installApi(listAgentSkills = vi.fn()) {
  Object.defineProperty(window, 'api', { configurable: true, value: { listAgentSkills } })
  return listAgentSkills
}
function snapshot(name = 'skill-creator', source: InstalledAgentSkill['source'] = 'system'): AgentSkillsSnapshot {
  return {
    skills: [{ name, description: 'Create useful skills.', path: `/skills/${name}/SKILL.md`, source }],
    notices: [],
  }
}
function deferred() {
  let resolve!: (value: AgentSkillsSnapshot) => void
  const promise = new Promise<AgentSkillsSnapshot>(done => { resolve = done })
  return { promise, resolve }
}

describe('Agent Status installed skills', () => {
  it('shows managed and provider-default metadata, count, and expandable locations', async () => {
    const api = installApi(vi.fn().mockResolvedValue({
      skills: [...snapshot().skills, ...snapshot('agent-code-conventions', 'agent-code').skills],
      notices: [],
    }))
    render(<AgentSkillsSection sessionId="agent-1" kind="codex" cwd="/project" />)
    expect(await screen.findByText('skill-creator')).toBeTruthy()
    expect(screen.getByText('agent-code-conventions')).toBeTruthy()
    expect(screen.getByText('System')).toBeTruthy()
    expect(screen.getByText('Agent Code')).toBeTruthy()
    expect(screen.getByText('Installed Skills · 2')).toBeTruthy()
    expect(api).toHaveBeenCalledWith({ provider: 'codex', cwd: '/project' })
    const item = screen.getByText('skill-creator').closest('li')!
    fireEvent.click(within(item).getByText('Location'))
    expect(within(item).getByText('/skills/skill-creator/SKILL.md')).toBeTruthy()
  })

  it('does not carry an old agent response into the next focused session', async () => {
    const old = deferred()
    const next = deferred()
    installApi(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise))
    const view = render(<AgentSkillsSection sessionId="old" kind="codex" cwd="/old" />)
    view.rerender(<AgentSkillsSection sessionId="next" kind="claude" cwd="/next" />)
    await act(async () => old.resolve(snapshot('old-skill')))
    expect(screen.queryByText('old-skill')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Loading')
    await act(async () => next.resolve(snapshot('next-skill')))
    expect(await screen.findByText('next-skill')).toBeTruthy()
  })

  it('refreshes after installs and keeps an older refresh from overwriting the latest result', async () => {
    const slow = deferred()
    const api = installApi(vi.fn()
      .mockResolvedValueOnce(snapshot('initial'))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(snapshot('latest')))
    render(<AgentSkillsSection sessionId="agent-1" kind="codex" cwd="/project" />)
    await screen.findByText('initial')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installed skills' }))
    act(() => announceAgentCodeManagedSkillsChange({ source: 'custom-skills', revision: 2 }))
    expect(await screen.findByText('latest')).toBeTruthy()
    await act(async () => slow.resolve(snapshot('stale')))
    expect(screen.queryByText('stale')).toBeNull()
    expect(api).toHaveBeenCalledTimes(3)
  })

  it('shows incomplete discovery alongside results and allows retry after a failed scan', async () => {
    const api = installApi(vi.fn().mockRejectedValueOnce(new Error('internal path or content'))
      .mockResolvedValueOnce({ ...snapshot(), notices: ['Some skill locations could not be read.'] }))
    render(<AgentSkillsSection sessionId="agent-1" kind="codex" cwd="/project" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load')
    expect(screen.queryByText('internal path or content')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installed skills' }))
    expect(await screen.findByText('skill-creator')).toBeTruthy()
    expect(screen.getByText('Some skill locations could not be read.')).toBeTruthy()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('distinguishes an empty skill inventory from a plain shell without requesting shell skills', async () => {
    const api = installApi(vi.fn().mockResolvedValue({ skills: [], notices: [] }))
    const view = render(<AgentSkillsSection sessionId="agent-1" kind="codex" cwd="/project" />)
    expect(await screen.findByText('No installed skills found in the checked locations.')).toBeTruthy()
    view.rerender(<AgentSkillsSection sessionId="shell" kind="terminal" cwd="/project" />)
    expect(screen.getByText('Shell terminals do not have agent skills.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh installed skills' })).toBeNull()
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
  })
})
