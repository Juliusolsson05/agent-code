import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import { useAppStore } from '@renderer/app-state/store'
import { useProviderEnablementStore } from '@renderer/features/providers/store'
import { useSkillsStore } from '@renderer/features/skills/store'
import type { AgentCodeCustomSkillsSnapshot } from '@shared/types/agentCodeCustomSkills'
import type {
  AgentCodeInstalledSkill,
  AgentCodeInstalledSkillDiscovery,
  AgentCodeInstalledSkillsSnapshot,
} from '@shared/types/agentCodeInstalledSkills'
import type { ExternalAgentSkillsSnapshot } from '@shared/types/agentSkills'
import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'

import { AddSkillDialog } from './AddSkillDialog'
import { SkillsGrid } from './SkillsGrid'

const originalApp = useAppStore.getState()
const originalProviders = useProviderEnablementStore.getState()
const originalSkills = useSkillsStore.getState()

const COMMIT = 'a'.repeat(40)

function installedSkill(overrides: Partial<AgentCodeInstalledSkill> = {}): AgentCodeInstalledSkill {
  return {
    id: 'skill-pdf',
    name: 'pdf',
    description: 'Work with PDF files.',
    enabled: true,
    source: {
      owner: 'anthropics',
      repository: 'skills',
      repositoryUrl: 'https://github.com/anthropics/skills',
      requestedRef: 'main',
      requestedRefType: 'branch',
      path: 'skills/pdf',
      skillUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      resolvedCommit: COMMIT,
    },
    snapshotDigest: 'b'.repeat(64),
    files: [{ path: 'SKILL.md', bytes: 10, sha256: 'c'.repeat(64), executable: false }],
    totalBytes: 10,
    warnings: [],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    health: 'active',
    targets: [
      { id: 'agents-standard-personal-skills', providers: ['codex', 'opencode', 'pi'], displayPath: '~/.agents/skills/pdf', state: 'installed' },
      { id: 'claude-personal-skills', providers: ['claude', 'opencode'], displayPath: '~/.claude/skills/pdf', state: 'installed' },
    ],
    ...overrides,
  }
}

const installed: AgentCodeInstalledSkillsSnapshot = {
  revision: 7,
  skills: [installedSkill()],
  unsupportedProviders: ['grok'],
}
const custom: AgentCodeCustomSkillsSnapshot = { revision: 7, skills: [], unsupportedProviders: ['grok'] }
const external: ExternalAgentSkillsSnapshot = {
  skills: [{
    name: 'grill-me',
    description: 'Interview me about a plan.',
    locations: [{ targetId: 'claude-personal-skills', providers: ['claude', 'opencode'], folder: 'grill-me', displayPath: '~/.claude/skills/grill-me', linked: true }],
    provenance: { installer: 'npx skills', source: 'mattpocock/skills' },
  }],
  notices: [],
}

function discovery(): AgentCodeInstalledSkillDiscovery {
  const candidate = (name: string) => ({
    candidateId: `id-${name}`,
    name,
    description: `The ${name} skill.`,
    source: { ...installedSkill().source, path: `skills/${name}` },
    files: [{ path: 'SKILL.md', bytes: 10, executable: false }],
    totalBytes: 10,
    warnings: [],
  })
  return {
    discoveryId: 'discovery-1',
    repositoryUrl: 'https://github.com/anthropics/skills',
    requestedRef: 'main',
    requestedRefType: 'branch',
    resolvedCommit: COMMIT,
    expiresAt: '2026-09-23T01:00:00.000Z',
    candidates: [candidate('docx')],
    notices: [],
    missingSkills: [],
    selection: { display: 'anthropics/skills', skills: ['docx'], providers: ['codex'], fullDepth: false, listOnly: false },
  }
}

const api = {
  auditAgentCodeInstalledSkills: vi.fn(async () => installed),
  getAgentCodeInstalledSkills: vi.fn(async () => installed),
  auditAgentCodeCustomSkills: vi.fn(async () => custom),
  getAgentCodeCustomSkills: vi.fn(async () => custom),
  listExternalAgentSkills: vi.fn(async () => external),
  setAgentCodeInstalledSkillProviders: vi.fn(async () => ({ ok: true, snapshot: installed })),
  discoverAgentCodeGitHubSkills: vi.fn(async () => ({ ok: true, discovery: discovery() })),
  installAgentCodeGitHubSkills: vi.fn(async () => ({ ok: true, snapshot: installed })),
  onManagedSkillsAgentChange: vi.fn(() => () => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { ...window.api, ...api } })
  useProviderEnablementStore.getState().setSnapshot({
    entries: ['claude', 'codex', 'opencode', 'grok', 'pi'].map(kind => ({ kind, enabled: kind !== 'pi', installed: true, because: 'detected' })),
  } as unknown as ProviderEnablementSnapshot)
  useSkillsStore.setState({ installed, custom, external, updates: {}, loadError: null })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalApp, true)
  useProviderEnablementStore.setState(originalProviders, true)
  useSkillsStore.setState(originalSkills, true)
})

describe('Settings → Skills grid (#1161)', () => {
  it('shows columns for enabled providers that support skills, never Grok', async () => {
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    await waitFor(() => expect(api.auditAgentCodeInstalledSkills).toHaveBeenCalled())
    expect(screen.getByRole('checkbox', { name: 'pdf for Claude agents' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'pdf for Codex agents' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /for Grok agents/ })).toBeNull()
    // Pi supports skills but is disabled in Settings → Providers.
    expect(screen.queryByRole('checkbox', { name: /for Pi agents/ })).toBeNull()
  })

  it('unticking one provider sends the full supported set minus that provider', async () => {
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'pdf for Claude agents' }))
    await waitFor(() => expect(api.setAgentCodeInstalledSkillProviders).toHaveBeenCalledWith({
      expectedRevision: 7,
      skillId: 'skill-pdf',
      // Pi stays chosen even though its column is hidden: hiding a provider
      // must never silently drop it from a skill.
      providers: ['codex', 'opencode', 'pi'],
    }))
  })

  // Review round 1: installed and custom skills share ONE document revision.
  it('sends the newest revision the page has seen, whichever collection moved last', async () => {
    useSkillsStore.setState({ custom: { ...custom, revision: 9 } })
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'pdf for Claude agents' }))
    await waitFor(() => expect(api.setAgentCodeInstalledSkillProviders)
      .toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 9 })))
  })

  it('marks a provider that sees the skill through a shared folder', () => {
    useSkillsStore.setState({
      installed: { ...installed, skills: [installedSkill({ providers: ['claude'] })] },
    })
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'pdf for OpenCode agents' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByText('shared').length).toBeGreaterThan(0)
  })

  it('badges a skill an agent proposed', () => {
    useSkillsStore.setState({
      installed: {
        ...installed,
        skills: [installedSkill({ enabled: false, health: 'disabled', pendingReview: { by: 'agent', sessionId: 's', requestedAt: 'now' } })],
      },
    })
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.getByText('proposed by an agent · review')).toBeTruthy()
  })

  it('lists skills other tools installed, and hides one per viewer', async () => {
    const onChange = vi.fn()
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Also found on this machine/ }))
    expect(screen.getByText('grill-me')).toBeTruthy()
    expect(screen.getByText(/npx skills · mattpocock\/skills/)).toBeTruthy()
    // Opened and chosen from the KEYBOARD (plan M2): the old hand-rolled menu
    // had no key handling at all, so Enter on ⋯ did nothing a keyboard user
    // could follow and there was no way to reach an item.
    const trigger = screen.getByRole('button', { name: 'Actions for grill-me' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Hide' }), { key: 'Enter' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ hiddenExternalSkills: ['claude-personal-skills:grill-me'] }))
  })

  it('closes the ⋯ menu on Escape and puts focus back on ⋯', async () => {
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Also found on this machine/ }))
    const trigger = screen.getByRole('button', { name: 'Actions for grill-me' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const first = await screen.findAllByRole('menuitem')
    await waitFor(() => expect(document.activeElement).toBe(first[0]))
    fireEvent.keyDown(first[0], { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('shows the context budget instead of a count limit', () => {
    render(<SkillsGrid settings={DEFAULT_SETTINGS} onChange={vi.fn()} />)
    expect(screen.getByText(/There is no limit on how many skills you keep/)).toBeTruthy()
  })
})

describe('Add skills dialog (#1161)', () => {
  it('understands a pasted npx skills command and installs what it names for its agents', async () => {
    useAppStore.setState({ addSkillDialog: { initialInput: '' } })
    render(<AddSkillDialog />)
    const input = screen.getByRole('textbox', { name: 'Install command or source' })
    fireEvent.change(input, { target: { value: 'npx skills add anthropics/skills --skill docx -a codex' } })
    expect(screen.getByText(/Understood: source anthropics\/skills · skills: docx · agents: codex/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find Skills' }))
    })
    expect(api.discoverAgentCodeGitHubSkills).toHaveBeenCalledWith('npx skills add anthropics/skills --skill docx -a codex')
    // `--skill docx` preselects it; `-a codex` ticks only Codex.
    expect((screen.getByRole('checkbox', { name: 'Install docx' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Install for Codex' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Install for Claude' }) as HTMLInputElement).checked).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install 1 Skill' }))
    })
    expect(api.installAgentCodeGitHubSkills).toHaveBeenCalledWith({
      expectedRevision: 7,
      discoveryId: 'discovery-1',
      candidateIds: ['id-docx'],
      providers: ['codex'],
    })
    expect(useAppStore.getState().addSkillDialog).toBeNull()
  })

  it('explains an unsupported source before touching the network', () => {
    useAppStore.setState({ addSkillDialog: { initialInput: 'https://gitlab.com/o/r' } })
    render(<AddSkillDialog />)
    expect(screen.getByText(/GitHub only for now/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Find Skills' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.discoverAgentCodeGitHubSkills).not.toHaveBeenCalled()
  })

  // Plan S32: Enter in the source field finds (and Find says so), Install is a
  // deliberate press, and a running find/install cannot be hidden.
  it('labels Find Skills ↩, gives Install no key, and holds the dialog while finding', async () => {
    let settle!: () => void
    api.discoverAgentCodeGitHubSkills.mockImplementationOnce(() => new Promise(resolve => {
      settle = () => resolve({ ok: true, discovery: discovery() })
    }))
    useAppStore.setState({ addSkillDialog: { initialInput: 'anthropics/skills' } })
    render(<AddSkillDialog />)
    expect(screen.getByRole('button', { name: 'Find Skills' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('↩')
    expect(screen.getByRole('button', { name: /^Install/ }).querySelector('[data-slot="kbd"]')).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Install command or source' }), { key: 'Enter' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toBeDisabled())
    expect(cancel.querySelector('[data-slot="kbd"]')).toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(useAppStore.getState().addSkillDialog).not.toBeNull()
    await act(async () => { settle() })
  })
})

