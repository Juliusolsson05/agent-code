import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseSkillInstallInput } from '@shared/skills/installSource.js'
import {
  fetchBoundedGitHubBytes,
  GitHubSkillSource,
  GitHubSkillSourceError,
  parseSkillFrontmatter,
  type GitHubSkillDiscoveryRequest,
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

/** What main does with pasted text: the shared parser, then discovery. */
function request(input: string): GitHubSkillDiscoveryRequest {
  const parsed = parseSkillInstallInput(input)
  if (!parsed.ok) throw new Error(parsed.message)
  return {
    source: parsed.value.source,
    fullDepth: parsed.value.fullDepth,
    skills: parsed.value.listOnly ? null : parsed.value.skills,
  }
}

function skill(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n${extra}---\n# ${name}\n`
}

function source(files: Parameters<typeof githubFixture>[0]['files'], options: { maxDiscoveryBytes?: number } = {}) {
  const fixture = githubFixture({ files })
  return {
    fixture,
    source: new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
      ...options,
    }),
  }
}

function defaultAdvertisement(extra = ''): string {
  return `ref: refs/heads/main\tHEAD
${COMMIT}\tHEAD
${COMMIT}\trefs/heads/main
${extra}`
}

describe('GitHub skill source parsing', () => {
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
      internal: false,
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
    }).discover(request('https://github.com/example/skills/tree/feature/skills/skills'))

    expect(result.requestedRef).toBe('feature/skills')
    expect(result.requestedRefType).toBe('branch')
    expect(result.candidates.map(value => value.candidate.name)).toEqual([
      'review-code',
      'run-checks',
    ])
    expect(result.candidates[1]!.candidate.warnings).toEqual([
      'Contains 1 executable file: scripts/check.sh.',
    ])
    // The review lists every file from the tree, before any package download.
    expect(result.candidates[1]!.candidate.files).toEqual([
      { path: 'SKILL.md', bytes: Buffer.byteLength(run), executable: false },
      { path: 'scripts/check.sh', bytes: 19, executable: true },
    ])
    expect(runGit).toHaveBeenCalledTimes(1)
    expect(runGit.mock.calls[0]![0]).toContain('ls-remote')
    expect(fixture.fetchBytes.mock.calls[0]![0]).toBe(fixture.treeUrl)
    // #1161: discovery downloads SKILL.md only; the script waits for install.
    expect(fixture.fetchBytes.mock.calls.slice(1).map(call => call[0])).toEqual([
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/review-code/SKILL.md`,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/run-checks/SKILL.md`,
    ])

    const acquired = await new GitHubSkillSource({ runGit, fetchBytes: fixture.fetchBytes })
      .acquire(result.candidates[1]!)
    expect(fixture.fetchBytes.mock.calls.at(-1)![0])
      .toBe(`https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/run-checks/scripts/check.sh`)
    expect(acquired.candidate.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/check.sh'])
    expect(acquired.contents.get('scripts/check.sh')!.toString()).toBe('#!/bin/sh\nnpm test\n')
  })

  it('charges skipped candidates to one fatal discovery acquisition budget', async () => {
    // Three folders declaring the same name: the second and third are
    // skipped as duplicates, but reading their SKILL.md still costs budget.
    const invalidSkill = `---
name: same-name
description: Every folder declares this name.
---
# Duplicate
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
    }).discover(request('https://github.com/example/skills'))).rejects
      .toThrow(/discovery exceeds/)

    // The first SKILL.md exhausts the shared budget, so the second and third
    // raw URLs must never be requested.
    expect(fixture.fetchBytes.mock.calls.map(call => call[0])).toEqual([
      fixture.treeUrl,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/first/SKILL.md`,
    ])
  })

  it('does not refund reserved acquisition capacity when raw transport fails', async () => {
    const first = `---
name: first
description: First package.
---
# First
`
    const second = `---
name: second
description: Second package.
---
# Second
`
    const fixture = githubFixture({
      files: [
        { path: 'skills/first/SKILL.md', content: first },
        { path: 'skills/second/SKILL.md', content: second },
      ],
    })
    const firstRawUrl = `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/first/SKILL.md`
    const fetchBytes = vi.fn(async (url: string, maxBytes: number) => {
      if (url === fixture.treeUrl) return await fixture.fetchBytes(url, maxBytes)
      if (url === firstRawUrl) {
        throw new GitHubSkillSourceError(
          'network',
          'The raw response failed after delivering its advertised body.',
        )
      }
      throw new Error(`Unexpected request after failed reserved transport: ${url}`)
    })

    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes,
      maxDiscoveryBytes: Buffer.byteLength(first),
    }).discover(request('https://github.com/example/skills'))).rejects
      .toThrow(/discovery exceeds/)
    expect(fetchBytes.mock.calls.map(call => call[0])).toEqual([
      fixture.treeUrl,
      firstRawUrl,
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
    }).discover(request('https://github.com/example/review-code'))

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
      request('https://github.com/example/skills/tree/release/v1/review-code')
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
    }).discover(request('https://github.com/example/skills/tree/release/v1/review-code'))

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
    }).discover(request('https://github.com/example/skills'))).rejects
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
    }).discover(request('https://github.com/example/review-code'))).rejects
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
    }).discover(request('https://github.com/example/review-code'))).rejects
      .toThrow(/do not match the reviewed commit tree/)
  })

  it('rejects a truncated GitHub tree instead of reviewing an incomplete repository', async () => {
    const fixture = githubFixture({ files: [], truncated: true })
    await expect(new GitHubSkillSource({
      runGit: vi.fn(async () => defaultAdvertisement()),
      fetchBytes: fixture.fetchBytes,
    }).discover(request('https://github.com/example/skills'))).rejects
      .toThrow(/too large or incomplete/)
  })
})

// #1161: discovery mirrors vercel-labs/skills 1.7 `discoverSkills`, so a
// repository shows the same skills here as with `npx skills add`.
describe('npx skills-compatible discovery', () => {
  const names = (result: Awaited<ReturnType<GitHubSkillSource['discover']>>) =>
    result.candidates.map(value => value.candidate.name)

  it('stops at a root SKILL.md unless --full-depth', async () => {
    const files = [
      { path: 'SKILL.md', content: skill('root-skill') },
      { path: 'skills/nested/SKILL.md', content: skill('nested') },
    ]
    expect(names(await source(files).source.discover(request('example/skills')))).toEqual(['root-skill'])
    expect(names(await source(files).source.discover(request('npx skills add example/skills --full-depth'))))
      .toEqual(['root-skill', 'nested'])
  })

  it('searches skills/, its category folders and every .<agent>/skills, but not stray example folders', async () => {
    const { source: github } = source([
      { path: 'skills/pdf/SKILL.md', content: skill('pdf') },
      { path: 'skills/.curated/docx/SKILL.md', content: skill('docx') },
      { path: 'skills/document/xlsx/SKILL.md', content: skill('xlsx') },
      { path: '.claude/skills/claude-only/SKILL.md', content: skill('claude-only') },
      { path: '.cursor/skills/cursor-only/SKILL.md', content: skill('cursor-only') },
      { path: 'examples/demo/fixture/SKILL.md', content: skill('fixture') },
      { path: 'top-level/SKILL.md', content: skill('top-level') },
    ])
    expect(names(await github.discover(request('example/skills'))).sort()).toEqual(
      ['claude-only', 'cursor-only', 'docx', 'pdf', 'top-level', 'xlsx'],
    )
  })

  it('falls back to a recursive search (depth 5, skipping node_modules) when the usual places are empty', async () => {
    const { source: github } = source([
      { path: 'packages/tools/agent/lint/SKILL.md', content: skill('lint') },
      { path: 'node_modules/dep/skills/bad/SKILL.md', content: skill('bad') },
      { path: 'a/b/c/d/e/f/too-deep/SKILL.md', content: skill('too-deep') },
    ])
    expect(names(await github.discover(request('example/skills')))).toEqual(['lint'])
  })

  it('does not cap how many skills a repository may hold', async () => {
    const files = Array.from({ length: 150 }, (_, index) => ({
      path: `skills/skill-${index}/SKILL.md`,
      content: skill(`skill-${index}`),
    }))
    expect((await source(files).source.discover(request('example/skills'))).candidates).toHaveLength(150)
  })

  it('keeps the first of two skills with one name and reports the second', async () => {
    const result = await source([
      { path: 'skills/pdf/SKILL.md', content: skill('pdf') },
      { path: '.claude/skills/pdf/SKILL.md', content: skill('pdf') },
    ]).source.discover(request('example/skills'))
    expect(result.candidates.map(value => value.candidate.source.path)).toEqual(['skills/pdf'])
    expect(result.notices).toEqual([
      '.claude/skills/pdf was skipped: another skill named pdf was found first at skills/pdf.',
    ])
  })

  it('accepts a folder named differently from its skill and installs it under the skill name', async () => {
    const result = await source([
      { path: 'skills/pdf-tools/SKILL.md', content: skill('pdf') },
    ]).source.discover(request('npx skills add example/skills --skill pdf-tools'))
    // `--skill` matches the folder name too, as in npx skills.
    expect(names(result)).toEqual(['pdf'])
  })

  it('reads only the requested skills and reports names that match nothing', async () => {
    const { fixture, source: github } = source([
      { path: 'skills/alpha/SKILL.md', content: skill('alpha') },
      { path: 'skills/beta/SKILL.md', content: skill('beta') },
      { path: 'skills/gamma/SKILL.md', content: skill('gamma') },
    ])
    const result = await github.discover(request('npx skills add example/skills --skill Beta missing'))
    expect(names(result)).toEqual(['beta'])
    expect(result.missingSkills).toEqual(['missing'])
    // `missing` could be a frontmatter name in another folder, so the others
    // are read too — but a satisfied selection stops early (below).
    expect(fixture.fetchBytes).toHaveBeenCalledTimes(4)

    // Roots are read in discovery order (so duplicates resolve exactly as
    // `npx skills` does), and reading stops once every name is matched.
    const { fixture: second, source: again } = source([
      { path: 'skills/alpha/SKILL.md', content: skill('alpha') },
      { path: 'skills/beta/SKILL.md', content: skill('beta') },
      { path: 'skills/gamma/SKILL.md', content: skill('gamma') },
    ])
    await again.discover(request('npx skills add example/skills --skill beta'))
    expect(second.fetchBytes.mock.calls.map(call => call[0])).toEqual([
      second.treeUrl,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/alpha/SKILL.md`,
      `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/beta/SKILL.md`,
    ])
  })

  // Review round 1: vercel's getPluginSkillPaths honours pluginRoot, walks
  // each plugin's `skills/` and the parent of every listed path, and reads
  // plugin.json.
  it('finds skills declared by marketplace and plugin manifests like npx skills', async () => {
    const result = await source([
      { path: 'skills/a/SKILL.md', content: skill('a') },
      {
        path: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          metadata: { pluginRoot: './plugins' },
          plugins: [
            { name: 'listed', source: './p', skills: ['./skills/b'] },
            { name: 'conventional', source: './q' },
            { name: 'remote', source: { source: 'github', repo: 'x/y' } },
          ],
        }),
      },
      { path: 'plugins/p/skills/b/SKILL.md', content: skill('b') },
      { path: 'plugins/q/skills/c/SKILL.md', content: skill('c') },
      { path: '.claude-plugin/plugin.json', content: JSON.stringify({ skills: ['./extra/d'] }) },
      { path: 'extra/d/SKILL.md', content: skill('d') },
    ]).source.discover(request('example/skills'))
    expect(names(result).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('resolves a duplicated name the same way with and without --skill', async () => {
    const files = [
      { path: 'skills/tools/SKILL.md', content: skill('pdf') },
      { path: '.claude/skills/pdf/SKILL.md', content: skill('pdf') },
    ]
    const browsed = await source(files).source.discover(request('example/skills'))
    const named = await source(files).source.discover(request('npx skills add example/skills --skill pdf'))
    expect(browsed.candidates.map(value => value.candidate.source.path)).toEqual(['skills/tools'])
    expect(named.candidates.map(value => value.candidate.source.path)).toEqual(['skills/tools'])
  })

  it('hides metadata.internal skills unless they are named', async () => {
    const files = [
      { path: 'skills/public/SKILL.md', content: skill('public') },
      { path: 'skills/secret/SKILL.md', content: skill('secret', 'metadata:\n  internal: true\n') },
    ]
    expect(names(await source(files).source.discover(request('example/skills')))).toEqual(['public'])
    expect(names(await source(files).source.discover(request("npx skills add example/skills --skill '*'"))))
      .toEqual(['public'])
    const named = await source(files).source.discover(request('npx skills add example/skills --skill secret'))
    expect(names(named)).toEqual(['secret'])
    expect(named.candidates[0]!.candidate.internal).toBe(true)
  })

  it('resolves #ref and owner/repo/sub/path shorthand', async () => {
    const fixture = githubFixture({ files: [{ path: 'nested/tool/SKILL.md', content: skill('tool') }] })
    const runGit = vi.fn(async () => defaultAdvertisement(`${COMMIT}\trefs/tags/v2\n`))
    const github = new GitHubSkillSource({ runGit, fetchBytes: fixture.fetchBytes })
    expect(await github.discover(request('example/skills#v2'))).toMatchObject({
      requestedRef: 'v2',
      requestedRefType: 'tag',
    })
    const sub = await github.discover(request('example/skills/nested/tool'))
    expect(sub.candidates[0]!.candidate.source.path).toBe('nested/tool')
  })

  it('refuses to acquire bytes that differ from the reviewed blob', async () => {
    const fixture = githubFixture({
      files: [
        { path: 'skills/tool/SKILL.md', content: skill('tool') },
        { path: 'skills/tool/data.txt', content: 'reviewed' },
      ],
    })
    const github = new GitHubSkillSource({ runGit: vi.fn(async () => defaultAdvertisement()), fetchBytes: fixture.fetchBytes })
    const result = await github.discover(request('example/skills'))
    fixture.fetchBytes.mockImplementationOnce(async () => Buffer.from('swapped!'))
    await expect(github.acquire(result.candidates[0]!)).rejects.toThrow(/do not match the reviewed commit tree/)
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
