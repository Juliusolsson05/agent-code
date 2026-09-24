import { describe, expect, it } from 'vitest'

import { describeSkillInstallInput, parseSkillInstallInput, tokenizeInstallCommand } from './installSource'

function ok(input: string) {
  const result = parseSkillInstallInput(input)
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to parse: ${result.message}`)
  return result.value
}

function fail(input: string) {
  const result = parseSkillInstallInput(input)
  if (result.ok) throw new Error(`expected ${JSON.stringify(input)} to fail`)
  return result
}

describe('parseSkillInstallInput', () => {
  // Lines as published by real READMEs and skills.sh pages (2026-09).
  it('reads the skills.sh command with --skill', () => {
    expect(ok('npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices')).toMatchObject({
      kind: 'command',
      source: { owner: 'vercel-labs', repository: 'agent-skills' },
      skills: ['vercel-react-best-practices'],
      providers: null,
    })
  })

  it('reads variadic skills, agents and the flags that change nothing here', () => {
    expect(ok('npx skills add anthropics/skills --skill pdf docx -g -a claude-code codex cursor -y --copy'))
      .toMatchObject({
        skills: ['pdf', 'docx'],
        providers: ['claude', 'codex'],
        notices: ['Not managed by Agent Code, ignored: cursor.'],
      })
  })

  it('accepts --skill=a,b, quoted star, --all, --full-depth and --list', () => {
    expect(ok('npx skills add o/r --skill=a,b')).toMatchObject({ skills: ['a', 'b'] })
    expect(ok("npx skills add o/r --skill '*'")).toMatchObject({ skills: '*' })
    expect(ok('npx skills add o/r --all')).toMatchObject({ skills: '*', providers: '*' })
    expect(ok('npx skills add o/r --full-depth')).toMatchObject({ fullDepth: true })
    expect(ok('npx skills add o/r --skill a --list')).toMatchObject({ skills: null, listOnly: true })
  })

  it('accepts other runners, aliases, versions, prompts and line continuations', () => {
    for (const line of [
      'npx -y skills@latest add o/r',
      'bunx skills a o/r',
      'pnpm dlx skills install o/r',
      'skills i o/r',
      '$ npx skills add o/r',
      'npx skills add \\\n  o/r',
    ]) expect(ok(line).source).toEqual({ owner: 'o', repository: 'r' })
  })

  it('reads every GitHub source form npx skills understands', () => {
    expect(ok('owner/repo').source).toEqual({ owner: 'owner', repository: 'repo' })
    expect(ok('owner/repo/skills/pdf').source).toEqual({ owner: 'owner', repository: 'repo', subpath: 'skills/pdf' })
    expect(ok('owner/repo@pdf')).toMatchObject({ source: { owner: 'owner', repository: 'repo' }, skills: ['pdf'] })
    expect(ok('owner/repo#v2')).toMatchObject({ source: { ref: 'v2' }, skills: null })
    expect(ok('owner/repo#release/2@pdf')).toMatchObject({ source: { ref: 'release/2' }, skills: ['pdf'] })
    expect(ok('github:owner/repo').source).toEqual({ owner: 'owner', repository: 'repo' })
    expect(ok('git@github.com:owner/repo.git').source).toEqual({ owner: 'owner', repository: 'repo' })
    expect(ok('https://github.com/owner/repo').source).toEqual({ owner: 'owner', repository: 'repo' })
    expect(ok('github.com/owner/repo').source).toEqual({ owner: 'owner', repository: 'repo' })
    expect(ok('https://github.com/owner/repo/tree/main/skills/pdf').source).toEqual({
      owner: 'owner',
      repository: 'repo',
      treeSegments: ['main', 'skills', 'pdf'],
    })
  })

  it('reads skills.sh page URLs as a source plus a skill', () => {
    expect(ok('https://skills.sh/vercel-labs/agent-skills/web-design-guidelines')).toMatchObject({
      source: { owner: 'vercel-labs', repository: 'agent-skills' },
      skills: ['web-design-guidelines'],
    })
  })

  it('merges @skill with --skill and dedupes case-insensitively', () => {
    expect(ok('npx skills add o/r@pdf --skill PDF docx').skills).toEqual(['PDF', 'docx'])
  })

  it('refuses hosts and local paths it cannot acquire, with a GitHub hint', () => {
    for (const source of [
      'https://gitlab.com/o/r',
      'gitlab:o/r',
      'git@gitlab.com:o/r.git',
      'https://example.com/skills.git',
      './my-skills',
      '/Users/me/skills',
      '~/skills',
    ]) {
      const result = fail(source)
      expect(result.code).toBe('unsupported-source')
      expect(result.message).toMatch(/GitHub/)
    }
  })

  it('names an unknown flag instead of guessing', () => {
    expect(fail('npx skills add o/r --frobnicate')).toMatchObject({
      code: 'unsupported-flag',
      message: expect.stringContaining('--frobnicate'),
    })
  })

  it('refuses other subcommands, missing sources and two sources', () => {
    expect(fail('npx skills remove pdf').code).toBe('syntax')
    expect(fail('npx skills add --skill pdf').code).toBe('syntax')
    expect(fail('npx skills add o/r other/r').code).toBe('syntax')
    expect(fail('npx skills add o/r --skill').code).toBe('syntax')
    expect(fail('   ').code).toBe('empty')
  })

  it('refuses shell expansions and operators rather than dropping them', () => {
    expect(fail('npx skills add $REPO').code).toBe('syntax')
    expect(fail('npx skills add o/r && rm -rf ~').code).toBe('syntax')
    expect(fail('npx skills add `echo o/r`').code).toBe('syntax')
  })

  it('refuses unsafe paths inside the repository', () => {
    expect(fail('owner/repo/../../etc').code).toBe('syntax')
    expect(fail('https://github.com/o/r/tree/main/..').code).toBe('syntax')
  })

  it('describes what it understood', () => {
    expect(describeSkillInstallInput(ok('npx skills add o/r --skill a b -a codex')))
      .toBe('source o/r · skills: a, b · agents: codex')
  })
})

describe('tokenizeInstallCommand', () => {
  it('handles quotes and escapes like a POSIX shell', () => {
    expect(tokenizeInstallCommand(`a 'b c' "d e" f\\ g '$x'`)).toEqual({
      ok: true,
      tokens: ['a', 'b c', 'd e', 'f g', '$x'],
    })
    expect(tokenizeInstallCommand(`a 'b`)).toMatchObject({ ok: false })
  })
})
