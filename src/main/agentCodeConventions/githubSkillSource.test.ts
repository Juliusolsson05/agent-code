import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchBoundedGitHubBytes,
  GitHubSkillSource,
  GitHubSkillSourceError,
  parseGitHubSkillUrl,
  parseSkillFrontmatter,
} from './githubSkillSource.js'

const COMMIT = 'a'.repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function gitBlobId(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

function githubFixture(input: {
  owner?: string
  repository?: string
  commit?: string
  files: Array<{
    path: string
    content: string | Buffer
    mode?: '100644' | '100755' | '120000'
    sha?: string
  }>
  gitlinks?: Array<{ path: string; sha?: string }>
  truncated?: boolean
}) {
  const owner = input.owner ?? 'example'
  const repository = input.repository ?? 'skills'
  const commit = input.commit ?? COMMIT
  const raw = new Map<string, Buffer>()
  const tree: Array<{
    path: string
    mode: string
    type: string
    sha: string
    size?: number
  }> = input.files.map(file => {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content)
    raw.set(
      `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${file.path
        .split('/').map(encodeURIComponent).join('/')}`,
      content,
    )
    return {
      path: file.path,
      mode: file.mode ?? '100644',
      type: 'blob',
      sha: file.sha ?? gitBlobId(content),
      size: content.byteLength,
    }
  })
  for (const gitlink of input.gitlinks ?? []) {
    tree.push({
      path: gitlink.path,
      mode: '160000',
      type: 'commit',
      sha: gitlink.sha ?? 'b'.repeat(40),
      size: undefined,
    })
  }
  const treeUrl = `https://api.github.com/repos/${owner}/${repository}/git/trees/${commit}?recursive=1`
  const fetchBytes = vi.fn(async (url: string, maxBytes: number) => {
    if (url === treeUrl) {
      return Buffer.from(JSON.stringify({
        sha: commit,
        tree,
        truncated: input.truncated ?? false,
      }))
    }
    const content = raw.get(url)
    if (!content) throw new Error(`Unexpected GitHub request: ${url}`)
    if (content.byteLength > maxBytes) throw new Error('fixture exceeded requested bound')
    return content
  })
  return { fetchBytes, treeUrl }
}

function defaultAdvertisement(extra = ''): string {
  return `ref: refs/heads/main\tHEAD
${COMMIT}\tHEAD
${COMMIT}\trefs/heads/main
${extra}`
}

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

  it('reads portable identity fields while rejecting malformed nested metadata', () => {
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
  it('resolves the longest slash-containing ref and acquires only selected commit blobs', async () => {
    const review = `---
name: review-code
description: Review pull requests when asked.
---
# Review
`
    const run = `---
name: run-checks
description: Run meaningful repository checks.
allowed-tools: Bash
---
# Checks
`
    const fixture = githubFixture({
      files: [
        { path: 'skills/review-code/SKILL.md', content: review },
        { path: 'skills/run-checks/SKILL.md', content: run },
        { path: 'skills/run-checks/scripts/check.sh', content: '#!/bin/sh\nnpm test\n', mode: '100755' },
      ],
    })
    const runGit = vi.fn(async (args: string[]) => {
      if (args.includes('ls-remote')) {
        return defaultAdvertisement(`${COMMIT}\trefs/heads/feature/skills\n`)
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    const result = await new GitHubSkillSource({
      runGit,
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/skills/tree/feature/skills/skills')

    expect(result.requestedRef).toBe('feature/skills')
    expect(result.requestedRefType).toBe('branch')
    expect(result.candidates.map(value => value.candidate.name)).toEqual([
      'review-code',
      'run-checks',
    ])
    expect(result.candidates[1]!.candidate.warnings).toEqual([
      'Contains 1 executable file: scripts/check.sh.',
    ])
    expect(runGit).toHaveBeenCalledTimes(1)
    expect(runGit.mock.calls[0]![0]).toContain('ls-remote')
    expect(fixture.fetchBytes.mock.calls[0]![0]).toBe(fixture.treeUrl)
    expect(fixture.fetchBytes.mock.calls.slice(1).map(call => call[0])).toEqual([
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/review-code/SKILL.md`,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/run-checks/SKILL.md`,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/run-checks/scripts/check.sh`,
    ])
  })

  it('charges rejected candidates to one fatal discovery acquisition budget', async () => {
    const invalidSkill = `---
name: wrong-name
description: This package name does not match its directory.
---
# Invalid
`
    const fixture = githubFixture({
      files: ['first', 'second', 'third'].map(directory => ({
        path: `skills/${directory}/SKILL.md`,
        content: invalidSkill,
      })),
    })
    const maxDiscoveryBytes = Buffer.byteLength(invalidSkill) + 1

    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
      maxDiscoveryBytes,
    }).discover('https://github.com/example/skills')).rejects
      .toThrow(/discovery exceeds/)

    // The first candidate is downloaded and rejected for its name mismatch.
    // Its bytes still exhaust the shared budget, so the second and third raw
    // package URLs must never be requested.
    expect(fixture.fetchBytes.mock.calls.map(call => call[0])).toEqual([
      fixture.treeUrl,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/first/SKILL.md`,
    ])
  })

  it('does not inherit credential, TLS, proxy, or Git-control environment state', async () => {
    vi.stubEnv('GIT_ASKPASS', '/tmp/credential-program')
    vi.stubEnv('SSH_ASKPASS', '/tmp/ssh-credential-program')
    vi.stubEnv('GIT_SSL_NO_VERIFY', '1')
    vi.stubEnv('GIT_DIR', '/tmp/redirected-repository')
    vi.stubEnv('HTTPS_PROXY', 'https://credential@proxy.invalid')
    const fixture = githubFixture({
      repository: 'review-code',
      files: [{
        path: 'SKILL.md',
        content: '---\nname: review-code\ndescription: Review code.\n---\n# Review\n',
      }],
    })
    let environment: NodeJS.ProcessEnv | undefined
    const runGit = vi.fn(async (
      args: string[],
      options: { environment: NodeJS.ProcessEnv },
    ) => {
      environment = options.environment
      if (args.includes('ls-remote')) return defaultAdvertisement()
      throw new Error('unexpected git call')
    })

    await new GitHubSkillSource({
      runGit,
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/review-code')

    expect(environment).not.toHaveProperty('GIT_ASKPASS')
    expect(environment).not.toHaveProperty('SSH_ASKPASS')
    expect(environment).not.toHaveProperty('GIT_SSL_NO_VERIFY')
    expect(environment).not.toHaveProperty('GIT_DIR')
    expect(environment).not.toHaveProperty('HTTPS_PROXY')
    expect(environment).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    })
  })

  it('rejects a tree URL whose short ref names both a branch and a tag', async () => {
    const fetchBytes = vi.fn()
    const runGit = vi.fn(async (args: string[]) => {
      if (args.includes('ls-remote')) {
        return defaultAdvertisement(
          `${'b'.repeat(40)}\trefs/heads/release/v1\n${'c'.repeat(40)}\trefs/tags/release/v1\n`,
        )
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    await expect(new GitHubSkillSource({ runGit, fetchBytes }).discover(
      'https://github.com/example/skills/tree/release/v1/review-code',
    )).rejects.toThrow(/both a branch and tag/)
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  it('retains tag identity, including the peeled commit of an annotated tag', async () => {
    const fixture = githubFixture({
      files: [{
        path: 'review-code/SKILL.md',
        content: '---\nname: review-code\ndescription: Review code.\n---\n# Review\n',
      }],
    })
    const runGit = vi.fn(async (args: string[]) => {
      if (args.includes('ls-remote')) {
        return defaultAdvertisement(
          `${'b'.repeat(40)}\trefs/tags/release/v1\n${COMMIT}\trefs/tags/release/v1^{}\n`,
        )
      }
      throw new Error(`Unexpected git invocation: ${args.join(' ')}`)
    })

    const result = await new GitHubSkillSource({
      runGit,
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/skills/tree/release/v1/review-code')

    expect(result).toMatchObject({
      requestedRef: 'release/v1',
      requestedRefType: 'tag',
      resolvedCommit: COMMIT,
    })
    expect(result.candidates[0]!.candidate.source.requestedRefType).toBe('tag')
  })

  it.each([
    ['Unicode-normalized files', 'assets/é.txt', 'assets/é.txt'],
    ['case-folded files', 'assets/Rule.txt', 'assets/rule.txt'],
    ['case-folded file and directory', 'Foo', 'foo/bar.txt'],
    ['Unicode-normalized file and directory', 'assets/é', 'assets/é/child.txt'],
  ])('rejects %s before reading package blobs', async (_label, left, right) => {
    const fixture = githubFixture({
      files: [
        {
          path: 'review-code/SKILL.md',
          content: '---\nname: review-code\ndescription: Review code.\n---\n',
        },
        { path: `review-code/${left}`, content: 'left' },
        { path: `review-code/${right}`, content: 'right' },
      ],
    })
    const runGit = vi.fn(async () => defaultAdvertisement())

    await expect(new GitHubSkillSource({
      runGit,
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/skills')).rejects
      .toThrow(/collide on a supported filesystem/)
    expect(fixture.fetchBytes).toHaveBeenCalledTimes(1)
  })

  it('rejects links inside the selected package before reading their blobs', async () => {
    const fixture = githubFixture({
      repository: 'review-code',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: review-code\ndescription: Review code.\n---\n# Review\n',
        },
        { path: 'secret-link', content: '../../secret', mode: '120000' },
      ],
    })

    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/review-code')).rejects
      .toThrow(/Links and submodules/)
    expect(fixture.fetchBytes).toHaveBeenCalledTimes(1)
  })

  it('rejects raw bytes that do not match the reviewed commit tree', async () => {
    const fixture = githubFixture({
      repository: 'review-code',
      files: [{
        path: 'SKILL.md',
        content: '---\nname: review-code\ndescription: Review code.\n---\n',
        sha: 'b'.repeat(40),
      }],
    })

    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/review-code')).rejects
      .toThrow(/do not match the reviewed commit tree/)
  })

  it('rejects a truncated GitHub tree instead of reviewing an incomplete repository', async () => {
    const fixture = githubFixture({ files: [], truncated: true })
    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
    }).discover('https://github.com/example/skills')).rejects
      .toThrow(/too large or incomplete/)
  })
})

describe('bounded GitHub transport', () => {
  it('stops reading a response as soon as its streamed body crosses the hard limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_025))
        controller.close()
      },
    }), { status: 200 })))

    await expect(fetchBoundedGitHubBytes(
      'https://api.github.com/repos/example/skills/git/trees/main',
      1_024,
    )).rejects.toThrow(/acquisition limit/)
  })
})
