import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCodeCustomSkillsSnapshot } from '@shared/types/agentCodeCustomSkills.js'
import { announceAgentCodeManagedSkillsChange } from '@renderer/features/settings/lib/agentCodeManagedSkillsEvents'
import { AgentCodeCustomSkillsRow } from './AgentCodeCustomSkillsRow'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function emptySnapshot(): AgentCodeCustomSkillsSnapshot {
  return { revision: 0, skills: [], unsupportedProviders: [] }
}

function savedSnapshot(revision = 1): AgentCodeCustomSkillsSnapshot {
  return {
    revision,
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
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
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
    const saved = savedSnapshot()
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

  it('locks the submitted draft until an asynchronous save settles', async () => {
    const pending = deferred<{ ok: true; snapshot: AgentCodeCustomSkillsSnapshot }>()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(savedSnapshot()),
        updateAgentCodeCustomSkill: vi.fn().mockReturnValue(pending.promise),
      },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('1 skill · 0 active')
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit review-code' }))
    fireEvent.change(screen.getByLabelText('Skill instructions'), {
      target: { value: '# Submitted draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(screen.getByLabelText('Skill instructions')).toBeDisabled()
    expect(screen.getByLabelText('Skill description')).toBeDisabled()
    await act(async () => pending.resolve({
      ok: true,
      snapshot: {
        ...savedSnapshot(2),
        skills: [{ ...savedSnapshot(2).skills[0]!, markdown: '# Submitted draft' }],
      },
    }))
    expect(screen.getByLabelText('Skill instructions')).not.toBeDisabled()
    expect(screen.getByLabelText('Skill instructions')).toHaveValue('# Submitted draft')
  })

  it('requires an explicit choice before rebasing a conflicted draft', async () => {
    const newer = {
      ...savedSnapshot(2),
      skills: [{ ...savedSnapshot(2).skills[0]!, markdown: '# Newer saved edit' }],
    }
    const update = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'revision-conflict', snapshot: newer })
      .mockResolvedValueOnce({ ok: true, snapshot: {
        ...savedSnapshot(3),
        skills: [{ ...savedSnapshot(3).skills[0]!, markdown: '# My stale draft' }],
      } })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(savedSnapshot()),
        updateAgentCodeCustomSkill: update,
      },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('1 skill · 0 active')
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit review-code' }))
    fireEvent.change(screen.getByLabelText('Skill instructions'), {
      target: { value: '# My stale draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText(/Choose how to continue/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
    expect(update).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Keep my draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      expectedRevision: 2,
      markdown: '# My stale draft',
    })))
  })

  it('refreshes its shared revision after a Conventions mutation', async () => {
    const audit = vi.fn()
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce({ ...emptySnapshot(), revision: 1 })
    const create = vi.fn().mockResolvedValue({ ok: true, snapshot: savedSnapshot(2) })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeCustomSkills: audit, createAgentCodeCustomSkill: create },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('No Agent Code-authored skills')
    act(() => announceAgentCodeManagedSkillsChange({ source: 'conventions', revision: 1 }))
    await waitFor(() => expect(audit).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New skill…' }))
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'review-code' } })
    fireEvent.change(screen.getByLabelText('Skill instructions'), { target: { value: '# Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
    })))
  })

  it('offers reveal only for materialized targets and reports typed failures', async () => {
    const snapshot = savedSnapshot()
    snapshot.skills[0] = {
      ...snapshot.skills[0]!,
      targets: [
        { id: 'draft', providers: ['codex'], displayPath: '~/.agents/skills/review-code', state: 'not-installed' },
        { id: 'installed', providers: ['claude'], displayPath: '~/.claude/skills/review-code', state: 'installed' },
      ],
    }
    const reveal = vi.fn().mockResolvedValue({ ok: false, message: 'Target no longer exists.' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(snapshot),
        revealAgentCodeCustomSkillTarget: reveal,
      },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('1 skill · 0 active')
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    const reveals = await screen.findAllByRole('button', { name: /Reveal review-code/ })
    expect(reveals).toHaveLength(1)
    fireEvent.click(reveals[0]!)
    expect(await screen.findByRole('alert')).toHaveTextContent('Target no longer exists.')
  })

  it('gives repeated skill actions target-specific accessible names', async () => {
    const first = savedSnapshot().skills[0]!
    const snapshot: AgentCodeCustomSkillsSnapshot = {
      ...savedSnapshot(),
      skills: [first, { ...first, id: 'skill-2', name: 'write-release-notes' }],
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeCustomSkills: vi.fn().mockResolvedValue(snapshot) },
    })
    render(<AgentCodeCustomSkillsRow />)
    await screen.findByText('2 skills · 0 active')
    fireEvent.click(screen.getByRole('button', { name: 'Manage custom skills…' }))
    expect(await screen.findByRole('button', { name: 'Edit review-code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete write-release-notes' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Custom skill review-code' })).toBeTruthy()
  })
})
