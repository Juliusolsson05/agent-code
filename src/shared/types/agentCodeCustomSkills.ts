import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type {
  AgentCodeConventionsHealth,
  AgentCodeConventionsTargetStatus,
  AgentCodeConventionsTextCounts,
} from './agentCodeConventions.js'

export const AGENT_CODE_CUSTOM_SKILL_MANAGED_MARKER = '<!-- agent-code-managed-skill:v1 -->'
export const AGENT_CODE_CUSTOM_SKILL_MAX_NAME_LENGTH = 64
export const AGENT_CODE_CUSTOM_SKILL_MAX_DESCRIPTION_LENGTH = 1_024
export const AGENT_CODE_CUSTOM_SKILL_MAX_BYTES = 32 * 1024
// WHY there is no custom-skill count cap (#1161): no provider or the Agent
// Skills spec limits how many skills exist. The real constraint is each
// agent's context budget for the name+description listing, which the CLIs
// handle by shortening descriptions, never by refusing a skill. The former
// cap of 50 was invented here; Settings → Skills shows the budget instead.

export type AgentCodeCustomSkill = {
  managedBy?: 'tldr' | 'goal' | 'auto_title'
  id: string
  name: string
  description: string
  markdown: string
  enabled: boolean
  /** Providers whose agents get it (#1161); absent means every provider. */
  providers?: AgentProviderKind[]
  createdAt: string
  updatedAt: string
  health: AgentCodeConventionsHealth
  targets: AgentCodeConventionsTargetStatus[]
}

export type AgentCodeCustomSkillsSnapshot = {
  revision: number
  skills: AgentCodeCustomSkill[]
  unsupportedProviders: AgentProviderKind[]
  recovery?: { message: string; stateFilePath: string }
}

export type AgentCodeCustomSkillDraft = {
  name: string
  description: string
  markdown: string
  enabled: boolean
}

export type CreateAgentCodeCustomSkillRequest = AgentCodeCustomSkillDraft & {
  expectedRevision: number
}

export type UpdateAgentCodeCustomSkillRequest = Omit<AgentCodeCustomSkillDraft, 'name'> & {
  expectedRevision: number
  skillId: string
}

export type SetAgentCodeCustomSkillEnabledRequest = {
  expectedRevision: number
  skillId: string
  enabled: boolean
}

export type SetAgentCodeCustomSkillProvidersRequest = {
  expectedRevision: number
  skillId: string
  /** null restores "every supporting provider". */
  providers: AgentProviderKind[] | null
}

export type DeleteAgentCodeCustomSkillRequest = {
  expectedRevision: number
  skillId: string
  abandonTargets?: Array<{
    targetId: string
    expectedConflictFingerprint: string
  }>
}

export type AgentCodeCustomSkillsMutationResult =
  | { ok: true; snapshot: AgentCodeCustomSkillsSnapshot }
  | { ok: false; code: 'validation'; message: string }
  | { ok: false; code: 'revision-conflict'; snapshot: AgentCodeCustomSkillsSnapshot }
  | {
      ok: false
      code: 'target-conflict' | 'delete-blocked'
      message: string
      snapshot: AgentCodeCustomSkillsSnapshot
      targets: AgentCodeConventionsTargetStatus[]
    }
  | { ok: false; code: 'unsupported'; snapshot: AgentCodeCustomSkillsSnapshot }
  | { ok: false; code: 'recovery-required'; snapshot: AgentCodeCustomSkillsSnapshot }
  | { ok: false; code: 'not-found'; message: string; snapshot: AgentCodeCustomSkillsSnapshot }
  | { ok: false; code: 'io-error'; message: string; snapshot: AgentCodeCustomSkillsSnapshot }

export type AgentCodeCustomSkillPreviewResult =
  | {
      ok: true
      renderedSkill: string
      warnings: string[]
      counts: AgentCodeConventionsTextCounts
    }
  | { ok: false; code: 'validation'; message: string }
