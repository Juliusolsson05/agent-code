import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'

import { createEmptyAgentCodeConventionsDocument } from '@shared/types/agentCodeConventions.js'
import {
  AgentCodeConventionsOwnershipPolicy,
  RETIRED_CONVENTIONS_TARGET_PREFIX,
} from './ownershipPolicy.js'
import type { ResolvedAgentCodeConventionsTargets } from './targets.js'

const hash = 'a'.repeat(64)

function targetsAt(skillsDirectory: string): ResolvedAgentCodeConventionsTargets {
  const skillDirectory = join(skillsDirectory, 'agent-code-conventions')
  return {
    targets: [{
      id: 'claude-personal-skills',
      providers: ['claude'],
      providerNames: ['Claude Code'],
      skillsDirectory,
      skillDirectory,
      skillFile: join(skillDirectory, 'SKILL.md'),
    }],
    unsupportedProviders: [],
  }
}

describe('AgentCodeConventionsOwnershipPolicy', () => {
  it('retires a moved record without granting its historical path mutation authority', () => {
    const policy = new AgentCodeConventionsOwnershipPolicy()
    const current = targetsAt(resolve('fixture-current', 'skills'))
    const oldPath = resolve('fixture-old', 'skills', 'agent-code-conventions', 'SKILL.md')
    const document = createEmptyAgentCodeConventionsDocument()
    document.materializations['claude-personal-skills'] = {
      path: oldPath,
      sha256: hash,
      createdDirectory: false,
    }

    policy.rehomeMovedMaterializations(document, current)

    const [retiredKey] = Object.keys(document.materializations)
    expect(retiredKey).toMatch(new RegExp(`^${RETIRED_CONVENTIONS_TARGET_PREFIX}`))
    expect(policy.persistedOwnershipProblem(document, current)).toBeNull()
    expect(policy.isCurrentMutationPath(oldPath, current)).toBe(false)
    expect(policy.isCurrentMutationPath(current.targets[0]!.skillFile, current)).toBe(true)
  })

  it('turns a moved journal-only write into a retained retired tombstone', () => {
    const policy = new AgentCodeConventionsOwnershipPolicy()
    const current = targetsAt(resolve('fixture-current', 'skills'))
    const oldPath = resolve('fixture-old', 'skills', 'agent-code-conventions', 'SKILL.md')
    const document = createEmptyAgentCodeConventionsDocument()
    document.pendingOperations['claude-personal-skills'] = {
      operationId: 'crashed-write',
      targetId: 'claude-personal-skills',
      path: oldPath,
      kind: 'write',
      previousSha256: null,
      desiredSha256: hash,
    }

    policy.rehomeMovedMaterializations(document, current)

    const [retiredKey] = Object.keys(document.materializations)
    expect(document.materializations[retiredKey!]).toMatchObject({ path: oldPath, sha256: hash })
    expect(document.pendingOperations[retiredKey!]).toMatchObject({ targetId: retiredKey })
    expect(policy.persistedOwnershipProblem(document, current)).toBeNull()
  })

  it('rejects a historical path whose state key has no live registry relation', () => {
    const policy = new AgentCodeConventionsOwnershipPolicy()
    const current = targetsAt(resolve('fixture-current', 'skills'))
    const document = createEmptyAgentCodeConventionsDocument()
    document.materializations.arbitrary = {
      path: resolve('fixture-old', 'skills', 'agent-code-conventions', 'SKILL.md'),
      sha256: hash,
      createdDirectory: false,
    }

    policy.rehomeMovedMaterializations(document, current)

    expect(policy.persistedOwnershipProblem(document, current))
      .toMatch('points outside an allowed skill path')
  })
})
