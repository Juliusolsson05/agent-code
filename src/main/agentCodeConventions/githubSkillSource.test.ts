import { describe, expect, it, vi } from 'vitest'

import {
  GitHubSkillSource,
  GitHubSkillSourceError,
  parseGitHubSkillUrl,
  parseSkillFrontmatter,
} from './githubSkillSource.js'

const COMMIT = 'a'.repeat(40)

describe('GitHub skill source parsing', () => {
  it('accepts only bounded public GitHub repository and tree URLs', () => {
    expect(parseGitHubSkillUrl('https://github.com/openai/openai-docs')).toEqual({
      owner: 'openai',
      repository: 'openai-docs',
      repositoryUrl: 'https://github.com/openai/openai-docs',
      treeSegments: [],
    })
    expect(parseGitHubSkillUrl(
      'https://github.com/openai/skills/tree/feature/skills/skills/review-code',
    ).treeSegments).toEqual(['feature', 'skills', 'skills', 'review-code'])

    for (const unsafe of [
      'http://github.com/openai/skills',
      'https://token@github.com/openai/skills',
      'https://gitlab.com/openai/skills',
      'https://github.com/openai/skills/blob/main/SKILL.md',
      'https://github.com/openai/skills?ref=main',
      'https://github.com/openai/skills/tree/main%2Fhidden/skill',
    ]) {
      expect(() => parseGitHubSkillUrl(unsafe)).toThrow(GitHubSkillSourceError)
    }
  })

  it('reads portable identity fields while leaving nested standard metadata inert', () => {
    expect(parseSkillFrontmatter(`---
name: review-code
description: >-
  Review code carefully
  when asked.
metadata:
  author: Example
  version: 1
allowed-tools:
  - Bash
---
# Workflow
`)).toEqual({
      name: 'review-code',
      description: 'Review code carefully when asked.',
      fields: ['allowed-tools', 'description', 'metadata', 'name'],
    })
    expect(() => parseSkillFrontmatter(`---
name: [review-code]
description: Review
---`)).toThrow(/plain or quoted string/)
    expect(() => parseSkillFrontmatter(`---
name: con
description: Not portable to every supported filesystem.
---`)).toThrow(/invalid portable skill name/)
  })
})

describe('GitHub skill discovery', () => {
  it('resolves the longest slash-containing ref and discovers multiple inert packages', async () => {
    const review = Buffer.from(`---
name: review-code
description: Review pull requests when asked.
---
# Review
`)
    const run = Buffer.from(`---
name: run-checks
description: Run meaningful repository checks.
allowed-tools: Bash
---
# Checks
`)
    const script = Buffer.from('#!/bin/sh\nnpm test\n')
    const blobs = new Map([
      ['1'.repeat(40), review],
      ['2'.repeat(40), run],
      ['3'.repeat(40), script],
    ])
    const runGit = vi.fn(async (args: string[], options: { binary?: boolean }) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD
${COMMIT}\tHEAD
${COMMIT}\trefs/heads/main
${COMMIT}\trefs/heads/feature/skills
`
      }
      if (args.includes('clone')) return ''
      if (args.includes('rev-parse')) return `${COMMIT}\n`
      if (args.includes('ls-tree')) {
        return [
          `100644 blob ${'1'.repeat(40)}\tskills/review-code/SKILL.md`,
          `100644 blob ${'2'.repeat(40)}\tskills/run-checks/SKILL.md`,
          `100755 blob ${'3'.repeat(40)}\tskills/run-checks/scripts/check.sh`,
          '',
        ].join('\0')
      }
      if (args.includes('cat-file')) {
        const value = blobs.get(args.at(-1)!)!
        return options.binary ? value : value.toString('utf8')
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })
    const source = new GitHubSkillSource({ runGit })

    const result = await source.discover(
      'https://github.com/example/skills/tree/feature/skills/skills',
    )

    expect(result.requestedRef).toBe('feature/skills')
    expect(result.candidates.map(value => value.candidate.name)).toEqual([
      'review-code',
      'run-checks',
    ])
    expect(result.candidates[1]!.candidate.warnings).toEqual([
      'Contains 1 executable file: scripts/check.sh.',
    ])
    expect(runGit.mock.calls.some(([args]) => args.includes('checkout'))).toBe(false)
    const clone = runGit.mock.calls.find(([args]) => args.includes('clone'))?.[0]
    expect(clone).toContain('--bare')
    expect(clone).toContain('--filter=blob:none')
    expect(clone).not.toContain('--no-tags')
  })

  it('rejects links inside the selected package before reading their blobs', async () => {
    const skill = Buffer.from(`---
name: review-code
description: Review code.
---
# Review
`)
    const runGit = vi.fn(async (args: string[], options: { binary?: boolean }) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD\n${COMMIT}\trefs/heads/main\n`
      }
      if (args.includes('clone')) return ''
      if (args.includes('rev-parse')) return `${COMMIT}\n`
      if (args.includes('ls-tree')) {
        return [
          `100644 blob ${'1'.repeat(40)}\tSKILL.md`,
          `120000 blob ${'2'.repeat(40)}\tsecret-link`,
          '',
        ].join('\0')
      }
      if (args.includes('cat-file')) return options.binary ? skill : skill.toString('utf8')
      throw new Error('unexpected git call')
    })

    await expect(new GitHubSkillSource({ runGit }).discover(
      'https://github.com/example/review-code',
    )).rejects.toThrow(/Links and submodules/)
    expect(runGit.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(0)
  })
})
