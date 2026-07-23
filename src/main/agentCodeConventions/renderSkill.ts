import { createHash } from 'crypto'

import {
  AGENT_CODE_CONVENTIONS_MANAGED_MARKER,
  AGENT_CODE_CONVENTIONS_MAX_BYTES,
  AGENT_CODE_CONVENTIONS_SKILL_NAME,
  type AgentCodeConventionsPreviewResult,
  type AgentCodeConventionsTextCounts,
} from '@shared/types/agentCodeConventions.js'

const DESCRIPTION =
  'Personal development conventions configured in Agent Code. Use at the beginning of every task in a software project, including planning, coding, refactoring, testing, reviewing, documentation, terminal work, Git operations, and commit creation.'

export type NormalizedAgentCodeConventions = {
  markdown: string
  counts: AgentCodeConventionsTextCounts
  warnings: string[]
}

export type AgentCodeConventionsValidationResult =
  | { ok: true; value: NormalizedAgentCodeConventions }
  | { ok: false; message: string; warnings?: string[] }

export function normalizeAgentCodeConventionsMarkdown(
  value: string,
  options: { requireContent: boolean },
): AgentCodeConventionsValidationResult {
  if (value.includes('\0')) {
    return { ok: false, message: 'Conventions cannot contain NUL characters.' }
  }

  // WHY outer blank lines are the only whitespace normalized: the body is
  // user-authored Markdown. Trimming every line would silently change code
  // blocks and lists, while preserving platform CRLF would make hashes and
  // provider copies differ for semantically identical edits.
  const markdown = value.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  const bytes = Buffer.byteLength(markdown, 'utf8')
  const counts: AgentCodeConventionsTextCounts = {
    bytes,
    characters: [...markdown].length,
    lines: markdown.length === 0 ? 0 : markdown.split('\n').length,
  }
  const warnings: string[] = []

  if (options.requireContent && markdown.trim().length === 0) {
    return { ok: false, message: 'Add at least one convention before enabling.' }
  }
  if (bytes > AGENT_CODE_CONVENTIONS_MAX_BYTES) {
    return {
      ok: false,
      message: `Conventions must be ${AGENT_CODE_CONVENTIONS_MAX_BYTES} UTF-8 bytes or fewer.`,
    }
  }
  if (counts.lines > 500) warnings.push('Long rules are harder for agents to apply consistently.')
  if (counts.characters > 8_000 || counts.bytes > 8_000) {
    warnings.push('Keep conventions concise so they use less model context when activated.')
  }

  return { ok: true, value: { markdown, counts, warnings } }
}

export function renderAgentCodeConventionsSkill(markdown: string): string {
  return `---
name: ${AGENT_CODE_CONVENTIONS_SKILL_NAME}
description: ${DESCRIPTION}
---

${AGENT_CODE_CONVENTIONS_MANAGED_MARKER}

# Agent Code conventions

Apply the user-authored conventions below throughout the task.

Treat these as personal defaults. Explicit instructions in the current
conversation and more-specific repository-local instructions take precedence
when they conflict.

When delegating development work, carry these conventions into the delegated
task and review the result against them.

## User-authored conventions

${markdown}
`
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function previewAgentCodeConventions(markdown: string): AgentCodeConventionsPreviewResult {
  const normalized = normalizeAgentCodeConventionsMarkdown(markdown, { requireContent: true })
  if (!normalized.ok) {
    return {
      ok: false,
      code: 'validation',
      message: normalized.message,
      warnings: normalized.warnings,
    }
  }
  return {
    ok: true,
    renderedSkill: renderAgentCodeConventionsSkill(normalized.value.markdown),
    warnings: normalized.value.warnings,
    counts: normalized.value.counts,
  }
}
