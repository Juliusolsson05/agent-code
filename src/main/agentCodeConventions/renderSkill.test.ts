import { describe, expect, it } from 'vitest'

import {
  AGENT_CODE_CONVENTIONS_MAX_BYTES,
  AGENT_CODE_CONVENTIONS_SKILL_NAME,
} from '@shared/types/agentCodeConventions.js'
import {
  normalizeAgentCodeConventionsMarkdown,
  renderAgentCodeConventionsSkill,
} from './renderSkill.js'

describe('Agent Code conventions skill renderer', () => {
  it('normalizes platform newlines without rewriting internal Markdown', () => {
    const result = normalizeAgentCodeConventionsMarkdown('\r\n# Rules\r\n\r- keep  two spaces  \r\n', {
      requireContent: true,
    })
    expect(result).toEqual({
      ok: true,
      value: {
        markdown: '# Rules\n\n- keep  two spaces  ',
        counts: { bytes: 29, characters: 29, lines: 3 },
        warnings: [],
      },
    })
  })

  it('rejects empty enabled, NUL, and oversized UTF-8 input', () => {
    expect(normalizeAgentCodeConventionsMarkdown('  ', { requireContent: true }).ok).toBe(false)
    expect(normalizeAgentCodeConventionsMarkdown('safe\0unsafe', { requireContent: false }).ok).toBe(false)
    expect(normalizeAgentCodeConventionsMarkdown(
      'å'.repeat(AGENT_CODE_CONVENTIONS_MAX_BYTES),
      { requireContent: false },
    ).ok).toBe(false)
  })

  it('keeps user frontmatter-like text below the product-owned wrapper', () => {
    const rendered = renderAgentCodeConventionsSkill('---\ncustom: value\n---')
    expect(rendered).toContain(`name: ${AGENT_CODE_CONVENTIONS_SKILL_NAME}`)
    expect(rendered).toContain('## User-authored conventions\n\n---\ncustom: value\n---\n')
    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.match(/name: agent-code-conventions/g)).toHaveLength(1)
  })

  it('renders the complete portable skill contract deterministically', () => {
    expect(renderAgentCodeConventionsSkill('# Git\n\n- Use concise subjects.')).toBe(`---
name: agent-code-conventions
description: Personal development conventions configured in Agent Code. Use at the beginning of every task in a software project, including planning, coding, refactoring, testing, reviewing, documentation, terminal work, Git operations, and commit creation.
---

<!-- agent-code-managed:v1 -->

# Agent Code conventions

Apply the user-authored conventions below throughout the task.

Treat these as personal defaults. Explicit instructions in the current
conversation and more-specific repository-local instructions take precedence
when they conflict.

When delegating development work, carry these conventions into the delegated
task and review the result against them.

## User-authored conventions

# Git

- Use concise subjects.
`)
  })
})
