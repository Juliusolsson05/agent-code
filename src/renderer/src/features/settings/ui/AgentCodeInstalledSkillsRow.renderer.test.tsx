import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentCodeInstalledSkillCandidate,
  AgentCodeInstalledSkillDiscovery,
  AgentCodeInstalledSkillsSnapshot,
} from '@shared/types/agentCodeInstalledSkills.js'
import { AgentCodeInstalledSkillsRow } from './AgentCodeInstalledSkillsRow'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

function candidate(commit = 'a'.repeat(40)): AgentCodeInstalledSkillCandidate {
  return {
    candidateId: 'candidate-1',
    name: 'review-code',
    description: 'Review code and explain consequential findings.',
    source: {
      owner: 'example',
      repository: 'skills',
      repositoryUrl: 'https://github.com/example/skills',
      requestedRef: 'main',
      requestedRefType: 'branch',
      path: 'skills/review-code',
      skillUrl: 'https://github.com/example/skills/tree/main/skills/review-code',
      resolvedCommit: commit,
    },
    files: [
      { path: 'SKILL.md', bytes: 120, sha256: 'b'.repeat(64), executable: false },
      { path: 'scripts/check.sh', bytes: 24, sha256: 'c'.repeat(64), executable: true },
    ],
    totalBytes: 144,
    warnings: ['Contains 1 executable file: scripts/check.sh.'],
  }
}

function discovery(value = candidate()): AgentCodeInstalledSkillDiscovery {
  return {
    discoveryId: 'discovery-1',
    repositoryUrl: value.source.repositoryUrl,
    requestedRef: value.source.requestedRef,
    requestedRefType: value.source.requestedRefType,
    resolvedCommit: value.source.resolvedCommit,
    expiresAt: '2026-08-27T00:15:00.000Z',
    candidates: [value],
    notices: [],
  }
}

function emptySnapshot(): AgentCodeInstalledSkillsSnapshot {
  return { revision: 0, skills: [], unsupportedProviders: [] }
}

function installedSnapshot(revision = 1, commit = 'a'.repeat(40)): AgentCodeInstalledSkillsSnapshot {
  const value = candidate(commit)
  return {
    revision,
    unsupportedProviders: [],
    skills: [{
      id: 'skill-1',
      name: value.name,
      description: value.description,
      enabled: true,
      source: value.source,
      snapshotDigest: 'd'.repeat(64),
      files: value.files,
      totalBytes: value.totalBytes,
      warnings: value.warnings,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      health: 'active',
      targets: [{
        id: 'agents-standard-personal-skills',
        providers: ['codex'],
        displayPath: '~/.agents/skills/review-code',
        state: 'installed',
      }],
    }],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

describe('AgentCodeInstalledSkillsRow', () => {
  it('keeps GitHub installation separate from authoring and external skill discovery', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { auditAgentCodeInstalledSkills: vi.fn().mockResolvedValue(emptySnapshot()) },
    })
    render(<AgentCodeInstalledSkillsRow />)

    expect(await screen.findByText('No GitHub-installed skills')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage installed skills…' }))
    expect(await screen.findByRole('dialog', { name: 'Installed Skills' })).toBeTruthy()
    expect(screen.getByText(/source-managed and separate from skills authored in Agent Code/)).toBeTruthy()
    expect(screen.getByText(/Custom and project-local skills stay outside this list/)).toBeTruthy()
  })

  it('requires discovery and package review before sending installation authority', async () => {
    const reviewed = discovery()
    const install = vi.fn().mockResolvedValue({ ok: true, snapshot: installedSnapshot() })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeInstalledSkills: vi.fn().mockResolvedValue(emptySnapshot()),
        discoverAgentCodeGitHubSkills: vi.fn().mockResolvedValue({ ok: true, discovery: reviewed }),
        installAgentCodeGitHubSkills: install,
      },
    })
    render(<AgentCodeInstalledSkillsRow />)
    await screen.findByText('No GitHub-installed skills')
    fireEvent.click(screen.getByRole('button', { name: 'Manage installed skills…' }))
    fireEvent.change(await screen.findByLabelText('GitHub skill URL'), {
      target: { value: reviewed.repositoryUrl },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Discover skills' }))

    expect(await screen.findByRole('dialog', { name: 'Review GitHub skills' })).toBeTruthy()
    expect(screen.getByText(/scripts\/check\.sh · 24 B/)).toBeTruthy()
    expect(screen.getByText(/Contains 1 executable file/)).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Install 1 selected skill' }))

    await waitFor(() => expect(install).toHaveBeenCalledWith({
      expectedRevision: 0,
      discoveryId: 'discovery-1',
      candidateIds: ['candidate-1'],
    }))
    expect(await screen.findByText('1 skill · 1 active')).toBeTruthy()
  })

  it('shows deterministic file changes and waits for explicit update confirmation', async () => {
    const nextCandidate = candidate('e'.repeat(40))
    const nextDiscovery = discovery(nextCandidate)
    const check = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'update-available',
      discovery: nextDiscovery,
      candidate: nextCandidate,
      changes: {
        added: ['references/new.md'],
        changed: ['SKILL.md'],
        removed: ['references/old.md'],
      },
    })
    const apply = vi.fn().mockResolvedValue({
      ok: true,
      snapshot: installedSnapshot(2, 'e'.repeat(40)),
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        auditAgentCodeInstalledSkills: vi.fn().mockResolvedValue(installedSnapshot()),
        checkAgentCodeInstalledSkillForUpdates: check,
        applyAgentCodeInstalledSkillUpdate: apply,
      },
    })
    render(<AgentCodeInstalledSkillsRow />)
    await screen.findByText('1 skill · 1 active')
    fireEvent.click(screen.getByRole('button', { name: 'Manage installed skills…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check review-code for updates' }))

    expect(await screen.findByRole('dialog', { name: 'Review update for review-code' })).toBeTruthy()
    expect(screen.getByText('references/new.md')).toBeTruthy()
    expect(screen.getByText('references/old.md')).toBeTruthy()
    expect(apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed update' }))

    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      expectedRevision: 1,
      skillId: 'skill-1',
      discoveryId: 'discovery-1',
      candidateId: 'candidate-1',
    }))
    expect(await screen.findByText(/was updated to the reviewed snapshot/)).toBeTruthy()
  })
})
