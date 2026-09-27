import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAgentActivityRedactor } from '../../scripts/agent-activity-redaction-policy'

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
    expect(out.worktreePath).toMatch(/\/Development\/p0-----\/x{7}\/x{9}\/x{8}$/)
    expect(out.projectDir).not.toMatch(/win-win|simplify|worktrees/)
    expect(out.branch).toBe('x'.repeat('docs/hermes-runtime-architecture'.length))
  })

  it('refuses a name too short for a unique placeholder rather than change its length', () => {
    expect(() => createAgentActivityRedactor('someone')('/Development/x')).toThrow(/cannot redact/)
  })

  it('finds nothing left to redact in the committed fixture', () => {
    // A fixed point: every private project in the committed file is already a placeholder and every
    // text field is already x. If a hand edit (or a policy change) left an identifier behind, this
    // pass would rewrite it and the comparison fails. The home user is irrelevant here — the
    // committed file must not contain the recorder's.
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown
    expect(createAgentActivityRedactor('fixture-home')(committed)).toEqual(committed)
  })
})
