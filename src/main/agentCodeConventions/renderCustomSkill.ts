import {
  AGENT_CODE_CUSTOM_SKILL_MANAGED_MARKER,
  AGENT_CODE_CUSTOM_SKILL_MAX_BYTES,
  AGENT_CODE_CUSTOM_SKILL_MAX_DESCRIPTION_LENGTH,
  AGENT_CODE_CUSTOM_SKILL_MAX_NAME_LENGTH,
  type AgentCodeCustomSkillDraft,
  type AgentCodeCustomSkillPreviewResult,
} from '@shared/types/agentCodeCustomSkills.js'
import { AGENT_CODE_CONVENTIONS_SKILL_NAME } from '@shared/types/agentCodeConventions.js'
import type { AgentCodeConventionsTextCounts } from '@shared/types/agentCodeConventions.js'

const PORTABLE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type NormalizedCustomSkill = {
  name: string
  description: string
  markdown: string
  counts: AgentCodeConventionsTextCounts
  warnings: string[]
}

export type NormalizeCustomSkillResult =
  | { ok: true; value: NormalizedCustomSkill }
  | { ok: false; message: string }

export function normalizeAgentCodeCustomSkill(
  draft: AgentCodeCustomSkillDraft,
  options: { requireContent?: boolean } = {},
): NormalizeCustomSkillResult {
  const name = draft.name.trim()
  const description = draft.description.trim()
  const markdown = draft.markdown.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')

  if (!PORTABLE_SKILL_NAME.test(name) || name.length > AGENT_CODE_CUSTOM_SKILL_MAX_NAME_LENGTH) {
    return {
      ok: false,
      message: 'Skill names must be 1–64 lowercase letters or numbers separated by single hyphens.',
    }
  }
  if (name === AGENT_CODE_CONVENTIONS_SKILL_NAME) {
    return { ok: false, message: 'That name is reserved for Agent Code Conventions.' }
  }
  if (description.length === 0) return { ok: false, message: 'Add a skill description.' }
  if (description.length > AGENT_CODE_CUSTOM_SKILL_MAX_DESCRIPTION_LENGTH) {
    return { ok: false, message: 'Skill descriptions must be 1,024 characters or fewer.' }
  }
  if (/\r|\n|\0/.test(description)) {
    // The editor owns YAML serialization. Keeping the portable description on
    // one line removes an entire class of indentation/tag ambiguities without
    // exposing raw frontmatter as a second, provider-dependent configuration.
    return { ok: false, message: 'Skill descriptions must be a single line without NUL bytes.' }
  }
  if (markdown.includes('\0')) return { ok: false, message: 'Skill instructions cannot contain NUL bytes.' }
  if (options.requireContent && markdown.trim().length === 0) {
    return { ok: false, message: 'Add instructions before enabling the skill.' }
  }
  const bytes = Buffer.byteLength(markdown, 'utf8')
  if (bytes > AGENT_CODE_CUSTOM_SKILL_MAX_BYTES) {
    return {
      ok: false,
      message: `Skill instructions must be ${AGENT_CODE_CUSTOM_SKILL_MAX_BYTES} UTF-8 bytes or fewer.`,
    }
  }
  const counts = {
    bytes,
    characters: [...markdown].length,
    lines: markdown.length === 0 ? 0 : markdown.split('\n').length,
  }
  const warnings: string[] = []
  if (counts.lines > 500) warnings.push('Long skills are harder for agents to apply consistently.')
  if (counts.characters > 8_000 || counts.bytes > 8_000) {
    warnings.push('Keep instructions concise so they use less model context when activated.')
  }
  return { ok: true, value: { name, description, markdown, counts, warnings } }
}

export function renderAgentCodeCustomSkill(skill: {
  name: string
  description: string
  markdown: string
}): string {
  // JSON string syntax is a strict subset of YAML double-quoted scalars. The
  // serializer, rather than user text, therefore controls every frontmatter
  // boundary while still preserving punctuation and non-ASCII descriptions.
  return `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
---

${AGENT_CODE_CUSTOM_SKILL_MANAGED_MARKER}

${skill.markdown}
`
}

export function previewAgentCodeCustomSkill(
  draft: AgentCodeCustomSkillDraft,
): AgentCodeCustomSkillPreviewResult {
  const normalized = normalizeAgentCodeCustomSkill(draft, { requireContent: true })
  if (!normalized.ok) return { ok: false, code: 'validation', message: normalized.message }
  return {
    ok: true,
    renderedSkill: renderAgentCodeCustomSkill(normalized.value),
    warnings: normalized.value.warnings,
    counts: normalized.value.counts,
  }
}
