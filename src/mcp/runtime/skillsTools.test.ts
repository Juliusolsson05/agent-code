import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentCodeManagedSkillsService } from '@main/agentCodeConventions/AgentCodeManagedSkillsService.js'
import type {
  GitHubSkillDiscoveryPayload,
  ReviewedInstalledSkillCandidate,
  StagedInstalledSkillCandidate,
} from '@main/agentCodeConventions/githubSkillSource.js'
import { installedSkillManifestDigest } from '@main/agentCodeConventions/installedSkillPackageStore.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

// The skills domain drives the REAL managed-skills service over a temp state
// dir, with only GitHub replaced: the property under test is that an agent
// can propose exactly what Settings would install, and nothing more.

const COMMIT = 'a'.repeat(40)

function staged(name: string): StagedInstalledSkillCandidate {
  const content = Buffer.from(`---\nname: ${name}\ndescription: The ${name} skill.\n---\n`)
  const files = [{
    path: 'SKILL.md',
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    executable: false,
  }]
  const snapshotDigest = installedSkillManifestDigest(files)
  return {
    snapshotDigest,
    contents: new Map([['SKILL.md', content]]),
    candidate: {
      candidateId: `id-${name}`,
      name,
      description: `The ${name} skill.`,
      source: {
        owner: 'anthropics',
        repository: 'skills',
        repositoryUrl: 'https://github.com/anthropics/skills',
        requestedRef: 'main',
        requestedRefType: 'branch',
        path: `skills/${name}`,
        skillUrl: `https://github.com/anthropics/skills/tree/main/skills/${name}`,
        resolvedCommit: COMMIT,
      },
      files,
      totalBytes: content.byteLength,
      warnings: [],
    },
  }
}

type TestReviewed = ReviewedInstalledSkillCandidate & { acquired: StagedInstalledSkillCandidate }

function payload(...names: string[]): GitHubSkillDiscoveryPayload {
  return {
    repositoryUrl: 'https://github.com/anthropics/skills',
    requestedRef: 'main',
    requestedRefType: 'branch',
    resolvedCommit: COMMIT,
    candidates: names.map(name => {
      const acquired = staged(name)
      return {
        candidate: acquired.candidate,
        owner: 'anthropics',
        repository: 'skills',
        commit: COMMIT,
        entries: [],
        skillMarkdown: Buffer.alloc(0),
        acquired,
      } satisfies TestReviewed
    }),
    notices: [],
    missingSkills: [],
  }
}

let root: string
let service: AgentCodeManagedSkillsService
let source: { discover: ReturnType<typeof vi.fn>; acquire: ReturnType<typeof vi.fn> }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-tools-'))
  source = {
    discover: vi.fn(async () => payload('pdf', 'docx')),
    acquire: vi.fn(async (reviewed: ReviewedInstalledSkillCandidate) => (reviewed as TestReviewed).acquired),
  }
  const skillsDirectory = join(root, '.agents', 'skills')
  service = new AgentCodeManagedSkillsService({
    stateFilePath: join(root, 'state', 'conventions.json'),
    installedSkillSnapshotRoot: join(root, 'state', 'snapshots'),
    homeDirectory: root,
    resolveTargets: async () => ({
      targets: [{
        id: 'agents-standard-personal-skills',
        providers: ['codex'],
        providerNames: ['Codex'],
        skillsDirectory,
        skillDirectory: join(skillsDirectory, 'agent-code-conventions'),
        skillFile: join(skillsDirectory, 'agent-code-conventions', 'SKILL.md'),
      }],
      unsupportedProviders: [],
    }),
    githubSkillSource: source,
  })
  await service.initialize()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function connect(domains: BuiltInMcpDomain[], onSkillsChangedByAgent = vi.fn()) {
  const server = createBuiltInMcpServer(
    { sessionId: 'agent-1', cwd: '/tmp/project', domains },
    { managedSkills: service, onSkillsChangedByAgent },
  )
  const client = new Client({ name: 'skills-domain-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { text: string }[])[0]!.text
    let value: Record<string, unknown>
    try { value = JSON.parse(text) as Record<string, unknown> } catch { value = { message: text } }
    return { isError: result.isError === true, value }
  }
  return { client, call, close: async () => { await client.close(); await server.close() } }
}

describe('skills built-in domain (#1161)', () => {
  it('is only exposed when the domain is granted, and has no enable tool', async () => {
    const without = await connect(['tldr'])
    expect((await without.client.listTools()).tools.map(tool => tool.name)).not.toContain('skills_add')
    await without.close()
    const withDomain = await connect(['skills'])
    expect((await withDomain.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'skills_add', 'skills_find', 'skills_list', 'skills_remove',
    ])
    expect(withDomain.client.getInstructions()).toContain('You cannot turn a skill on')
    await withDomain.close()
  })

  it('proposes a named skill switched off, writes nothing to provider roots, and tells the user', async () => {
    const changed = vi.fn()
    const { call, close } = await connect(['skills'], changed)
    const result = await call('skills_add', { source: 'npx skills add anthropics/skills', skills: ['pdf'] })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ ok: true, proposed: [{ name: 'pdf', enabled: false, waitingForUserReview: true }] })
    const snapshot = await service.getInstalledSkillsSnapshot()
    expect(snapshot.skills.map(skill => [skill.name, skill.enabled, skill.pendingReview?.sessionId]))
      .toEqual([['pdf', false, 'agent-1']])
    await expect(stat(join(root, '.agents', 'skills', 'pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(changed).toHaveBeenCalledWith({ sessionId: 'agent-1', message: 'An agent proposed skill pdf for your review' })
    await close()
  })

  it('refuses to guess which skills to add from a multi-skill source', async () => {
    const { call, close } = await connect(['skills'])
    const result = await call('skills_add', { source: 'anthropics/skills' })
    expect(result).toMatchObject({ isError: true, value: { message: expect.stringContaining('Name the ones to propose') } })
    expect((await service.getInstalledSkillsSnapshot()).skills).toEqual([])
    await close()
  })

  it('withdraws its own proposal but never a skill the user reviewed', async () => {
    const { call, close } = await connect(['skills'])
    await call('skills_add', { source: 'anthropics/skills', skills: ['pdf', 'docx'] })
    const before = await service.getInstalledSkillsSnapshot()
    const docx = before.skills.find(skill => skill.name === 'docx')!
    const approved = await service.setInstalledSkillEnabled({ expectedRevision: before.revision, skillId: docx.id, enabled: true })
    expect(approved).toMatchObject({ ok: true })

    expect(await call('skills_remove', { name: 'docx' })).toMatchObject({
      isError: true,
      value: { message: expect.stringContaining('reviewed by the user') },
    })
    expect(await call('skills_remove', { name: 'pdf' })).toMatchObject({ isError: false, value: { removed: 'pdf' } })
    expect((await service.getInstalledSkillsSnapshot()).skills.map(skill => skill.name)).toEqual(['docx'])
    await close()
  })

  it('does not let an orchestration parent without the domain hand it to a child', async () => {
    // The clamp lives in orchestration_create_agent; this pins the policy
    // list it reads so skills cannot be dropped from it silently.
    const { PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS } = await import('@mcp/shared/types.js')
    expect(PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS.has('skills')).toBe(true)
  })
})
