import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertHomesBelongTo,
  assertNoForeignHome,
  createAgentActivityRedactor,
  requireHomeUser,
} from '../../scripts/agent-activity-redaction-policy'

// The redaction pass behind testing/fixtures/agent-activity/runtime-states.json (#1296, review of
// #1353). The committed fixture was regenerated from the pre-redaction corpus in git history with
// exactly this pass; these tests pin the properties that regeneration relies on, so a later edit to
// the policy cannot quietly leak a name or merge two projects again.

const FIXTURE = resolve(__dirname, '../fixtures/agent-activity/runtime-states.json')

describe('agent-activity redaction policy', () => {
  it('gives distinct private projects distinct same-length placeholders, and keeps Agent Code', () => {
    // `startup` and `win-win` are both 7 characters: the first policy mapped both to `project`,
    // merging two projects into one in every regeneration.
    const redact = createAgentActivityRedactor('someone')
    const out = redact({
      a: '/Users/someone/Desktop/Development/startup',
      b: '/Users/someone/Desktop/Development/win-win',
      c: '/Users/someone/Desktop/Development/startup',
      d: '/Users/someone/Desktop/Development/agent-code/.worktrees/public-branch',
    }) as Record<string, string>
    const project = (path: string) => path.split('/').pop()!
    expect(project(out.a)).not.toBe(project(out.b))
    expect(out.a).toBe(out.c)
    expect(out.a).toHaveLength('/Users/someone/Desktop/Development/startup'.length)
    expect(out.a).not.toMatch(/someone|startup/)
    expect(out.d).toBe('/Users/fixture/Desktop/Development/agent-code/.worktrees/public-branch')
  })

  it('fills the path under a private project (keeping separators) and every branch name', () => {
    const redact = createAgentActivityRedactor('someone')
    const out = redact({
      worktreePath: '/Users/someone/Desktop/Development/win-win/.claude/worktrees/simplify',
      projectDir: '/Users/someone/.claude/projects/-Users-someone-Desktop-Development-win-win--claude-worktrees-simplify',
      branch: 'docs/hermes-runtime-architecture',
    }) as Record<string, string>
    expect(out.worktreePath).toMatch(/\/Development\/p0-----\/s0x{5}\/s1x{7}\/s2x{6}$/)
    expect(out.projectDir).not.toMatch(/win-win|simplify|worktrees/)
    expect(out.branch).toBe('x'.repeat('docs/hermes-runtime-architecture'.length))
    // A text field holding an array keeps its field's rule for every item (review of #1353, c).
    expect(redact({ branch: ['feat/secret-plan'] })).toEqual({ branch: ['x'.repeat('feat/secret-plan'.length)] })
  })

  // Steering q74: `startsWith('agent-code')` exempted any private project that merely shares the
  // prefix. Only the public repo's exact segment stays verbatim.
  it('redacts a private project that only shares the public name as a prefix', () => {
    const redact = createAgentActivityRedactor('someone')
    const out = redact({
      a: '/Users/someone/Desktop/Development/agent-code-private/notes',
      b: '/Users/someone/.claude/projects/-Users-someone-Desktop-Development-agent-code-private',
      c: '/Users/someone/Desktop/Development/agent-code',
    }) as Record<string, string>
    expect(out.a).not.toContain('agent-code-private')
    expect(out.a).toMatch(/\/Development\/p0-{16}\/s0x{3}$/)
    expect(out.b).not.toContain('agent-code-private')
    expect(out.c).toBe('/Users/fixture/Desktop/Development/agent-code')
  })

  // Steering q74: --redact-from defaulted the recorder's user to the user RUNNING the script, which
  // on any other checkout left the recorder's home path in the tracked fixture.
  it('requires an explicit, plain --home-user', () => {
    expect(() => requireHomeUser(['--redact-from', 'in.json'])).toThrow(/needs --home-user/)
    for (const bad of ['', ' ', '--other', 'a/b', 'a b']) {
      expect(() => requireHomeUser(['--redact-from', 'in.json', '--home-user', bad])).toThrow(/needs --home-user/)
    }
    expect(() => requireHomeUser(['--redact-from', 'in.json', '--home-user'])).toThrow(/needs --home-user/)
    expect(requireHomeUser(['--redact-from', 'in.json', '--home-user', 'recorder'])).toBe('recorder')
  })

  it('refuses output that still names a home directory other than the placeholder', () => {
    const wrongUser = JSON.stringify(createAgentActivityRedactor('someoneelse')({
      path: '/Users/recorder/Desktop/Development/agent-code',
      projectDir: '/Users/recorder/.claude/projects/-Users-recorder-Desktop-Development-agent-code',
    }))
    expect(() => assertNoForeignHome(wrongUser, 'someoneelse')).toThrow(/still names a home directory/)
    // The error names a count, never the user: it is printed to a terminal and may be pasted.
    expect(() => assertNoForeignHome(wrongUser, 'someoneelse')).not.toThrow(/recorder/)
    const right = JSON.stringify(createAgentActivityRedactor('recorder')({
      path: '/Users/recorder/Desktop/Development/agent-code',
      projectDir: '/Users/recorder/.claude/projects/-Users-recorder-Desktop-Development-agent-code',
    }))
    expect(() => assertNoForeignHome(right, 'recorder')).not.toThrow()
    // Steering q76: the placeholder for an 8-character user is `fixture-`; a foreign `/Users/fixture`
    // (or its dash-encoded form) only shares that prefix and must still refuse.
    expect(() => assertNoForeignHome('{"p":"/Users/fixture/Desktop/Development/agent-code"}', 'recorder')).toThrow(/still names/)
    expect(() => assertNoForeignHome('{"p":"/x/-Users-fixture-Desktop-Development-agent-code"}', 'recorder')).toThrow(/still names/)
    expect(() => assertNoForeignHome('{"p":"/x/-Users-fixture--Desktop-Development-agent-code"}', 'recorder')).not.toThrow()
  })

  // Steering q74 regeneration: an x-filled tail made two same-length worktree paths one object key,
  // and Object.fromEntries kept only the last entry.
  it('keeps same-length paths under one private project distinct, as values and as keys', () => {
    const redact = createAgentActivityRedactor('someone')
    const touched = {
      '/Users/someone/Desktop/Development/private-audits/commands-ui-shell': 1,
      '/Users/someone/Desktop/Development/private-audits/headless-packages': 2,
    }
    const out = redact({ touched }) as { touched: Record<string, number> }
    expect(Object.values(out.touched)).toEqual([1, 2])
    expect(JSON.stringify(out)).not.toMatch(/private-audits|commands-ui-shell|headless-packages/)
  })

  it('refuses the file rather than merge two keys', () => {
    // Two one-character tails cannot get distinct tags, so both x-fill to the same key.
    const redact = createAgentActivityRedactor('someone')
    expect(() => redact({ '/Development/private/a': 1, '/Development/private/b': 2 })).toThrow(/two object keys equal/)
  })

  // Review of #1353, round 3 a: after redaction a foreign user spelled like the placeholder
  // (`fixture-` for an 8-character recorder) cannot be told apart from it. The source can.
  it('refuses a source whose homes are not all the named recorder', () => {
    expect(() => assertHomesBelongTo('{"p":"/Users/fixture-/Desktop/Development/agent-code"}', 'recorder')).toThrow(/other than --home-user/)
    expect(() => assertHomesBelongTo('{"p":"-Users-fixture--secret-Desktop-Development-agent-code"}', 'recorder')).toThrow(/other than --home-user/)
    expect(() => assertHomesBelongTo('{"p":"/home/other/x"}', 'recorder')).toThrow(/other than --home-user/)
    expect(() => assertHomesBelongTo('{"p":"/Users/recorder/Desktop/x","q":"-Users-recorder-Desktop-x"}', 'recorder')).not.toThrow()
    // Steering q78: the dash encoding has no delimiter after the user, so a hyphenated foreign user
    // that STARTS with the recorder's name must refuse as ambiguous...
    expect(() => assertHomesBelongTo('{"p":"/Users/recorder/Desktop/x","q":"-Users-recorder-secret-Desktop-Development-agent-code"}', 'recorder')).toThrow(/other than --home-user/)
    // ...and so must a standard folder the source never names canonically.
    expect(() => assertHomesBelongTo('{"q":"-Users-recorder-Desktop-x"}', 'recorder')).toThrow(/other than --home-user/)
  })

  // Review of #1353, round 3 a: the pass rewrites only the canonical spellings, so any other
  // spelling of a home must refuse the file rather than pass through untouched.
  it.each([
    ['lowercase', '/users/other/Desktop'],
    ['/home', '/home/other/project'],
    ['backslashes', 'C:\\Users\\other\\Desktop'],
    ['JSON-escaped slashes', '\\/Users\\/other\\/Desktop'],
    ['percent-encoded', '%2FUsers%2Fother%2FDesktop'],
    ['a tilde home', '~other/project'],
  ])('refuses a home spelled %s', (_label, path) => {
    const output = JSON.stringify({ p: path })
    expect(() => assertNoForeignHome(output, 'recorder')).toThrow(/still names/)
  })

  it('refuses a name too short for a unique placeholder rather than change its length', () => {
    expect(() => createAgentActivityRedactor('someone')('/Development/x')).toThrow(/cannot redact/)
  })

  it('finds nothing left to redact in the committed fixture', () => {
    // A fixed point: every private project in the committed file is already a placeholder and every
    // text field is already x. If a hand edit (or a policy change) left an identifier behind, this
    // pass would rewrite it and the comparison fails. The home user is irrelevant here — the
    // committed file must not contain the recorder's.
    const text = readFileSync(FIXTURE, 'utf8')
    const committed = JSON.parse(text) as unknown
    expect(createAgentActivityRedactor('fixture-home')(committed)).toEqual(committed)
    expect(() => assertNoForeignHome(text, 'fixture-home')).not.toThrow()
  })
})
