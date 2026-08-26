import { APP_SLUG } from '@shared/appIdentity.js'

export const AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT = `${APP_SLUG}:managed-skills-changed`

export type AgentCodeManagedSkillsChangeSource = 'conventions' | 'custom-skills'

export type AgentCodeManagedSkillsChange = {
  source: AgentCodeManagedSkillsChangeSource
  revision: number
}

export function announceAgentCodeManagedSkillsChange(
  detail: AgentCodeManagedSkillsChange,
): void {
  // Conventions and Custom Skills deliberately present as separate settings,
  // but main stores them in one revisioned document. This renderer-local event
  // keeps the sibling row honest after an accepted mutation without pretending
  // that externally installed or project-local skills belong to this manager.
  window.dispatchEvent(new CustomEvent(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, { detail }))
}
