import { describe, expect, it } from 'vitest'

import {
  normalizeAgentCodeCustomSkill,
  previewAgentCodeCustomSkill,
  renderAgentCodeCustomSkill,
} from './renderCustomSkill.js'

describe('custom skill rendering', () => {
  it('renders deterministic portable frontmatter without accepting raw YAML', () => {
    expect(renderAgentCodeCustomSkill({
      name: 'review-pull-request',
      description: 'Review code: safely & carefully',
      markdown: '# Workflow\n\nExplain why each finding matters.',
    })).toBe(`---
name: review-pull-request
description: "Review code: safely & carefully"
---

<!-- agent-code-managed-skill:v1 -->

# Workflow

Explain why each finding matters.
`)
  })

  it.each(['Uppercase', '-leading', 'trailing-', 'two--hyphens', 'spaces here'])(
    'rejects non-portable name %s',
    name => {
      expect(normalizeAgentCodeCustomSkill({
        name,
        description: 'Valid description',
        markdown: '# Instructions',
        enabled: true,
      })).toMatchObject({ ok: false })
    },
  )

  it('rejects the reserved conventions name and unsafe or empty enabled content', () => {
    expect(previewAgentCodeCustomSkill({
      name: 'agent-code-conventions',
      description: 'Collision',
      markdown: '# Instructions',
      enabled: true,
    })).toMatchObject({ ok: false, code: 'validation' })
    expect(previewAgentCodeCustomSkill({
      name: 'safe-name',
      description: 'Line one\nfrontmatter: escape',
      markdown: '# Instructions',
      enabled: true,
    })).toMatchObject({ ok: false, code: 'validation' })
    expect(previewAgentCodeCustomSkill({
      name: 'safe-name',
      description: 'Useful skill',
      markdown: '',
      enabled: true,
    })).toMatchObject({ ok: false, code: 'validation' })
  })

  it('allows an empty disabled draft but keeps instructions bounded and NUL-free', () => {
    expect(normalizeAgentCodeCustomSkill({
      name: 'draft-skill',
      description: 'Work in progress',
      markdown: '',
      enabled: false,
    })).toMatchObject({ ok: true, value: { markdown: '' } })
    expect(normalizeAgentCodeCustomSkill({
      name: 'draft-skill',
      description: 'Work in progress',
      markdown: 'bad\0content',
      enabled: false,
    })).toMatchObject({ ok: false })
    expect(normalizeAgentCodeCustomSkill({
      name: 'draft-skill',
      description: 'Work in progress',
      markdown: 'a'.repeat(32 * 1024 + 1),
      enabled: false,
    })).toMatchObject({ ok: false })
  })
})
