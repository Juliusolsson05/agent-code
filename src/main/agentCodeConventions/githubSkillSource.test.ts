import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GitHubSkillSource,
  GitHubSkillSourceError,
  parseGitHubSkillUrl,
  parseSkillFrontmatter,
} from './githubSkillSource.js'

const COMMIT = 'a'.repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
})

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
---`)).toThrow(/must be YAML strings/)
    expect(() => parseSkillFrontmatter(`---
name: con
description: Not portable to every supported filesystem.
---`)).toThrow(/invalid portable skill name/)
    expect(() => parseSkillFrontmatter(`---
name: review-code
description: Review code.
metadata:
  author: [unterminated
---`)).toThrow(/invalid YAML frontmatter/)
    expect(() => parseSkillFrontmatter(`---
name: review-code
description: true
---`)).toThrow(/must be YAML strings/)
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
    expect(result.requestedRefType).toBe('branch')
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

  it('does not inherit credential, TLS, proxy, or Git-control environment state', async () => {
    vi.stubEnv('GIT_ASKPASS', '/tmp/credential-program')
    vi.stubEnv('SSH_ASKPASS', '/tmp/ssh-credential-program')
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('GIT_DIR', '/tmp/redirected-repository')
    vi.stubEnv('HTTPS_PROXY', 'https://credential@proxy.invalid')
    const skill = Buffer.from(`---
name: review-code
description: Review code.
---
# Review
`)
    const environments: NodeJS.ProcessEnv[] = []
    const runGit = vi.fn(async (
      args: string[],
      options: { binary?: boolean; environment: NodeJS.ProcessEnv },
    ) => {
      environments.push(options.environment)
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD\n${COMMIT}\trefs/heads/main\n`
      }
      if (args.includes('clone')) return ''
      if (args.includes('rev-parse')) return `${COMMIT}\n`
      if (args.includes('ls-tree')) return `100644 blob ${'1'.repeat(40)}\tSKILL.md\0`
      if (args.includes('cat-file')) return options.binary ? skill : skill.toString('utf8')
      throw new Error('unexpected git call')
    })

    await new GitHubSkillSource({ runGit }).discover('https://github.com/example/review-code')

    expect(environments.length).toBeGreaterThan(0)
    for (const environment of environments) {
      expect(environment).not.toHaveProperty('GIT_ASKPASS')
      expect(environment).not.toHaveProperty('SSH_ASKPASS')
      expect(environment).not.toHaveProperty('GIT_SSL_NO_VERIFY')
      expect(environment).not.toHaveProperty('GIT_DIR')
      expect(environment).not.toHaveProperty('HTTPS_PROXY')
      expect(environment.GIT_TERMINAL_PROMPT).toBe('0')
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
    }
  })

  it('rejects a tree URL whose short ref names both a branch and a tag', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD
${COMMIT}\trefs/heads/main
${'b'.repeat(40)}\trefs/heads/release/v1
${'c'.repeat(40)}\trefs/tags/release/v1
`
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    await expect(new GitHubSkillSource({ runGit }).discover(
      'https://github.com/example/skills/tree/release/v1/review-code',
    )).rejects.toThrow(/both a branch and tag/)
    expect(runGit.mock.calls.some(([args]) => args.includes('clone'))).toBe(false)
  })

  it('retains tag identity, including the peeled commit of an annotated tag', async () => {
    const tagObject = 'b'.repeat(40)
    const skill = Buffer.from(`---
name: review-code
description: Review code.
---
# Review
`)
    const runGit = vi.fn(async (args: string[], options: { binary?: boolean }) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD
${'c'.repeat(40)}\trefs/heads/main
${tagObject}\trefs/tags/release/v1
${COMMIT}\trefs/tags/release/v1^{}
`
      }
      if (args.includes('clone')) return ''
      if (args.includes('rev-parse')) return `${COMMIT}\n`
      if (args.includes('ls-tree')) return `100644 blob ${'1'.repeat(40)}\treview-code/SKILL.md\0`
      if (args.includes('cat-file')) return options.binary ? skill : skill.toString('utf8')
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    const result = await new GitHubSkillSource({ runGit }).discover(
      'https://github.com/example/skills/tree/release/v1/review-code',
    )

    expect(result).toMatchObject({
      requestedRef: 'release/v1',
      requestedRefType: 'tag',
      resolvedCommit: COMMIT,
    })
    expect(result.candidates[0]!.candidate.source.requestedRefType).toBe('tag')
  })

  it.each([
    ['Unicode-normalized', 'assets/é.txt', 'assets/é.txt'],
    ['case-folded', 'assets/Rule.txt', 'assets/rule.txt'],
  ])('rejects %s package paths before reading blobs', async (_label, left, right) => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD\n${COMMIT}\trefs/heads/main\n`
      }
      if (args.includes('clone')) return ''
      if (args.includes('rev-parse')) return `${COMMIT}\n`
      if (args.includes('ls-tree')) {
        return [
          `100644 blob ${'1'.repeat(40)}\treview-code/SKILL.md`,
          `100644 blob ${'2'.repeat(40)}\treview-code/${left}`,
          `100644 blob ${'3'.repeat(40)}\treview-code/${right}`,
          '',
        ].join('\0')
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    await expect(new GitHubSkillSource({ runGit }).discover(
      'https://github.com/example/skills',
    )).rejects.toThrow(/collide on a supported filesystem/)
    expect(runGit.mock.calls.some(([args]) => args.includes('cat-file'))).toBe(false)
  })

  it('cancels acquisition while Git-controlled temporary storage crosses its budget', async () => {
    let cloneObservedAbort = false
    const runGit = vi.fn(async (args: string[], options: { signal?: AbortSignal }) => {
      if (args.includes('ls-remote')) {
        return `ref: refs/heads/main\tHEAD\n${COMMIT}\trefs/heads/main\n`
      }
      if (args.includes('clone')) {
        const repository = args.at(-1)!
        await mkdir(repository, { recursive: true })
        for (let index = 0; index < 100; index += 1) {
          if (options.signal?.aborted) {
            cloneObservedAbort = true
            throw options.signal.reason
          }
          await writeFile(join(repository, `pack-${index}`), Buffer.alloc(512))
          await new Promise(resolve => setTimeout(resolve, 2))
        }
        throw new Error('acquisition was not cancelled')
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    await expect(new GitHubSkillSource({
      runGit,
      maxAcquisitionBytes: 1_024,
      acquisitionPollIntervalMs: 1,
    }).discover('https://github.com/example/review-code'))
      .rejects.toThrow(/temporary storage limit/)
    expect(cloneObservedAbort).toBe(true)
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
