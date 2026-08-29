import { APP_SLUG } from '@shared/appIdentity.js'

export const AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT = `${APP_SLUG}:managed-skills-changed`

export type AgentCodeManagedSkillsChangeSource = 'conventions' | 'custom-skills' | 'installed-skills'

export type AgentCodeManagedSkillsChange = {
  source: AgentCodeManagedSkillsChangeSource
  revision: number
}

export function announceAgentCodeManagedSkillsChange(
  detail: AgentCodeManagedSkillsChange,
): void {
  // The three Agent Code-managed skill sources deliberately present as
  // separate settings, but main stores them in one revisioned document. This
  // renderer-local event keeps sibling rows honest after an accepted mutation
  // without pretending provider-owned or project-local skills belong here.
  window.dispatchEvent(new CustomEvent(AGENT_CODE_MANAGED_SKILLS_CHANGED_EVENT, { detail }))
}
