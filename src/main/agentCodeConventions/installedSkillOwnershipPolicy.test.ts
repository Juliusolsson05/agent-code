import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createEmptyAgentCodeConventionsDocument,
  type AgentCodeInstalledSkillRecord,
} from '@shared/types/agentCodeConventions.js'
import {
  AgentCodeInstalledSkillOwnershipPolicy,
  installedArtifactKey,
} from './installedSkillOwnershipPolicy.js'

const digest = 'a'.repeat(64)
const skill: AgentCodeInstalledSkillRecord = {
  id: 'skill-1',
  name: 'review-code',
  description: 'Review code.',
  enabled: true,
  source: {
    owner: 'example',
    repository: 'skills',
    repositoryUrl: 'https://github.com/example/skills',
    requestedRef: 'main',
    requestedRefType: 'branch',
    path: 'skills/review-code',
    skillUrl: 'https://github.com/example/skills/tree/main/skills/review-code',
    resolvedCommit: 'b'.repeat(40),
  },
  snapshotDigest: digest,
  files: [{ path: 'SKILL.md', bytes: 10, sha256: 'c'.repeat(64), executable: false }],
  warnings: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

describe('installed skill ownership policy', () => {
  it('keeps moved provider packages as valid retired evidence until the exact target returns', () => {
    const policy = new AgentCodeInstalledSkillOwnershipPolicy()
    const document = createEmptyAgentCodeConventionsDocument()
    document.installedSkills[skill.id] = skill
    const skillsDirectory = resolve('ownership-test', 'old-provider', 'skills')
    const path = join(skillsDirectory, skill.name)
    const currentKey = installedArtifactKey(skill.id, 'provider-target')
    document.installedMaterializations[currentKey] = {
      skillId: skill.id,
      targetId: 'provider-target',
      path,
      snapshotDigest: digest,
      files: skill.files,
    }

    policy.rehomeMovedMaterializations(document, skill, {
      targets: [],
      unsupportedProviders: [],
    })
    const [retiredKey] = Object.keys(document.installedMaterializations)
    expect(retiredKey).toMatch(/^retired-installed:/)
    expect(policy.persistedOwnershipProblem(
      document,
      document.installedSkills,
      () => ({ targets: [], unsupportedProviders: [] }),
    )).toBeNull()

    policy.rehomeMovedMaterializations(document, skill, {
      targets: [{
        id: 'provider-target',
        providers: ['codex'],
        providerNames: ['Codex'],
        skillsDirectory,
        skillDirectory: path,
        skillFile: join(path, 'SKILL.md'),
      }],
      unsupportedProviders: [],
    })
    expect(document.installedMaterializations[currentKey]?.path).toBe(path)
    expect(Object.keys(document.installedMaterializations)).toEqual([currentKey])
  })
})
