import { describe, expect, it } from 'vitest'

import {
  createPathRewriter,
  placeholder,
  redactRecord,
} from '../../../scripts/conversation-corpus-policy.js'

// WHY these inputs are not invented: each is the literal head of a record
// observed on 2026-09-11 (see docs/decomposition/conversations.md §0). The
// policy is the single publication gate for the corpus, so the test pins the
// exact behaviour a leak would have to defeat.
describe('conversation corpus policy', () => {
  const paths = createPathRewriter('/Users/me', '/Users/me/Desktop/Development/agent-code')

  it('hashes free text but keeps a known wrapper prefix verbatim', () => {
    const raw = '<orchestration-handoff>\nYou are now an orchestrated child agent in Agent Code.\n</orchestration-handoff>\n\n<task>\nReview the Grok lifecycle.\n</task>'
    const out = redactRecord({ type: 'user', message: { role: 'user', content: raw } }, paths) as {
      message: { content: string }
    }
    expect(out.message.content.startsWith('<orchestration-handoff>')).toBe(true)
    expect(out.message.content).not.toContain('Grok')
    expect(out.message.content).toBe(`<orchestration-handoff>${placeholder(raw.slice('<orchestration-handoff>'.length))}`)
  })

  it('keeps structural keys, rewrites paths, and hashes branches other than main', () => {
    const out = redactRecord({
      type: 'user',
      cwd: '/Users/me/Desktop/Development/agent-code/.worktrees/extension-platform',
      gitBranch: 'feat/extension-platform',
      timestamp: '2026-09-11T16:32:40.673Z',
      sessionId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1',
      permissionMode: 'bypassPermissions',
      isMeta: true,
    }, paths) as Record<string, unknown>
    expect(out.cwd).toBe('/fixture/repo/.worktrees/extension-platform')
    expect(out.gitBranch).toBe('b:' + placeholder('feat/extension-platform').slice(2, 10))
    expect(out.timestamp).toBe('2026-09-11T16:32:40.673Z')
    expect(out.sessionId).toBe('ededdea8-06bf-4474-b945-b3a8f8ce0fe1')
    expect(out.permissionMode).toBe('bypassPermissions')
    expect(out.isMeta).toBe(true)
  })

  it('keeps main verbatim and maps unrelated projects to numbered fixtures', () => {
    const a = redactRecord({ cwd: '/Users/me/Desktop/Development/bringdown', gitBranch: 'main' }, paths) as Record<string, string>
    const b = redactRecord({ cwd: '/Users/me/Desktop/Development/bringdown/sub' }, paths) as Record<string, string>
    expect(a.cwd).toBe('/fixture/other-1')
    expect(b.cwd).toBe('/fixture/other-1/sub')
    expect(a.gitBranch).toBe('main')
  })

  it('hashes a Codex index title unless it starts with a kept wrapper', () => {
    const plain = redactRecord({ title: 'break down this project' }, paths) as { title: string }
    const agents = redactRecord({ title: '# AGENTS.md instructions for /Users/me/x\n\n<INSTRUCTIONS>' }, paths) as { title: string }
    expect(plain.title).toMatch(/^p:[0-9a-f]{8}:23$/)
    expect(agents.title.startsWith('# AGENTS.md instructions for')).toBe(true)
  })

  it('never leaves a string outside the allowlist unhashed, recursively', () => {
    const out = JSON.stringify(redactRecord({
      payload: { type: 'user_message', message: 'secret text', images: [{ url: 'file:///Users/me/a.png' }] },
      attachment: { type: 'hook_success', stdout: 'secret stdout' },
    }, paths))
    expect(out).not.toContain('secret')
    expect(out).toContain('"type":"user_message"')
    expect(out).toContain('"type":"hook_success"')
  })
})
